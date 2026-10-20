// Relay health checks: NIP-11 info, NIP-42 AUTH challenge, TURN credential mint (+ optional
// allocation test) and signaling RTT. Runs in the browser or in Bun; every check tolerates
// failure and reports it instead of throwing.
import type { TurnCredentialsResponse } from '@beamhop/p2p'

export type CheckName = 'nip11' | 'auth' | 'turn' | 'allocation' | 'signaling'

export interface HealthCheck {
  name: CheckName
  /** null = skipped (not applicable / missing input). */
  ok: boolean | null
  ms?: number
  detail: string
  data?: unknown
}

export interface HealthReport {
  relay: string
  at: number
  checks: HealthCheck[]
}

/** Minimal WebSocket surface used here (browser WebSocket and Bun's both fit). */
export interface WsLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
}

export interface HealthOptions {
  relay: string
  appId?: string
  apiKey?: string
  timeoutMs?: number
  fetch?: typeof fetch
  WebSocket?: new (url: string) => WsLike
  /** Allocation test; in browsers pass `browserAllocationTest`. Skipped when absent. */
  allocationTest?: (iceServers: TurnCredentialsResponse['iceServers']) => Promise<HealthCheck>
  now?: () => number
}

/** ws(s)://host/path → http(s)://host/path */
export function httpUrlFor(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, 'http$1://')
}

/** Realm relay URL for an app: wss://host/a/<appId> */
export function realmUrl(relay: string, appId?: string): string {
  if (!appId) return relay
  return `${relay.replace(/\/+$/, '')}/a/${encodeURIComponent(appId)}`
}

const elapsed = (now: () => number, t0: number) => Math.round(now() - t0)

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export async function checkNip11(opts: HealthOptions): Promise<HealthCheck> {
  const f = opts.fetch ?? fetch
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  try {
    const res = await withTimeout(
      f(httpUrlFor(realmUrl(opts.relay, opts.appId)), {
        headers: { Accept: 'application/nostr+json' },
      }),
      opts.timeoutMs ?? 5000,
      'NIP-11 fetch',
    )
    if (!res.ok)
      return { name: 'nip11', ok: false, ms: elapsed(now, t0), detail: `HTTP ${res.status}` }
    const info = (await res.json()) as {
      name?: string
      software?: string
      supported_nips?: number[]
    }
    const nips = Array.isArray(info.supported_nips) ? info.supported_nips : []
    return {
      name: 'nip11',
      ok: true,
      ms: elapsed(now, t0),
      detail: `${info.name ?? 'unnamed relay'}${info.software ? ` · ${info.software}` : ''} · NIPs ${nips.join(', ') || 'n/a'}`,
      data: info,
    }
  } catch (e) {
    return { name: 'nip11', ok: false, ms: elapsed(now, t0), detail: errorText(e) }
  }
}

/**
 * Open a socket, send a REQ for the room-announce kind and wait for EOSE (signaling RTT);
 * report whether the relay issued a NIP-42 AUTH challenge on the way.
 */
export async function checkSocket(opts: HealthOptions): Promise<[HealthCheck, HealthCheck]> {
  const Ws = opts.WebSocket ?? (globalThis.WebSocket as unknown as HealthOptions['WebSocket'])
  const now = opts.now ?? (() => performance.now())
  const timeout = opts.timeoutMs ?? 5000
  if (!Ws) {
    const skip = (name: CheckName): HealthCheck => ({
      name,
      ok: null,
      detail: 'WebSocket unavailable',
    })
    return [skip('auth'), skip('signaling')]
  }
  const url = realmUrl(opts.relay, opts.appId)
  return new Promise((resolve) => {
    let challenge: string | null = null
    let settled = false
    let sentAt = 0
    let ws: WsLike
    const subId = `studio-${Math.random().toString(36).slice(2, 8)}`
    const done = (signaling: HealthCheck) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      const auth: HealthCheck = challenge
        ? {
            name: 'auth',
            ok: true,
            detail: `AUTH challenge issued (${challenge.slice(0, 12)}…)`,
            data: { challenge },
          }
        : {
            name: 'auth',
            ok: signaling.ok ? true : null,
            detail: signaling.ok ? 'no AUTH challenge (open relay)' : 'not reached',
          }
      resolve([auth, signaling])
    }
    const timer = setTimeout(
      () => done({ name: 'signaling', ok: false, detail: `no EOSE within ${timeout} ms` }),
      timeout,
    )
    try {
      ws = new Ws(url)
    } catch (e) {
      clearTimeout(timer)
      resolve([
        { name: 'auth', ok: null, detail: 'not reached' },
        { name: 'signaling', ok: false, detail: errorText(e) },
      ])
      return
    }
    ws.onopen = () => {
      sentAt = now()
      ws.send(JSON.stringify(['REQ', subId, { kinds: [20100], limit: 0 }]))
    }
    ws.onmessage = (ev) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (!Array.isArray(msg)) return
      if (msg[0] === 'AUTH' && typeof msg[1] === 'string') challenge = msg[1]
      else if (msg[0] === 'EOSE' && msg[1] === subId) {
        try {
          ws.send(JSON.stringify(['CLOSE', subId]))
        } catch {}
        const ms = elapsed(now, sentAt)
        done({ name: 'signaling', ok: true, ms, detail: `REQ → EOSE in ${ms} ms` })
      } else if (msg[0] === 'CLOSED' && msg[1] === subId) {
        done({
          name: 'signaling',
          ok: false,
          detail: `subscription closed: ${String(msg[2] ?? '')}`,
        })
      } else if (msg[0] === 'NOTICE') {
        // keep waiting; a notice is not a failure on its own
      }
    }
    ws.onerror = () => done({ name: 'signaling', ok: false, detail: `cannot connect to ${url}` })
    ws.onclose = () => done({ name: 'signaling', ok: false, detail: 'socket closed before EOSE' })
  })
}

export async function checkTurnCredentials(
  opts: HealthOptions,
): Promise<{ check: HealthCheck; creds?: TurnCredentialsResponse }> {
  if (!opts.appId)
    return { check: { name: 'turn', ok: null, detail: 'set an app id to mint TURN credentials' } }
  const f = opts.fetch ?? fetch
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const url = `${httpUrlFor(opts.relay).replace(/\/+$/, '')}/a/${encodeURIComponent(opts.appId)}/turn-credentials`
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
    const res = await withTimeout(
      f(url, { method: 'POST', headers, body: '{}' }),
      opts.timeoutMs ?? 5000,
      'TURN mint',
    )
    if (!res.ok) {
      return {
        check: {
          name: 'turn',
          ok: false,
          ms: elapsed(now, t0),
          detail: `HTTP ${res.status}${res.status === 401 ? ' (API key?)' : ''}`,
        },
      }
    }
    const creds = (await res.json()) as TurnCredentialsResponse
    if (!Array.isArray(creds.iceServers)) {
      return {
        check: {
          name: 'turn',
          ok: false,
          ms: elapsed(now, t0),
          detail: 'response has no iceServers',
        },
      }
    }
    const urls = creds.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
    return {
      check: {
        name: 'turn',
        ok: true,
        ms: elapsed(now, t0),
        detail: `${urls.length} ICE URL(s), ttl ${creds.ttl}s`,
        data: { urls, ttl: creds.ttl },
      },
      creds,
    }
  } catch (e) {
    return { check: { name: 'turn', ok: false, ms: elapsed(now, t0), detail: errorText(e) } }
  }
}

/** Browser-only: gather candidates with iceTransportPolicy 'relay'; success = a relay candidate. */
export async function browserAllocationTest(
  iceServers: TurnCredentialsResponse['iceServers'],
  timeoutMs = 6000,
): Promise<HealthCheck> {
  const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection
  if (!PC) return { name: 'allocation', ok: null, detail: 'RTCPeerConnection unavailable' }
  const t0 = performance.now()
  const pc = new PC({ iceServers: iceServers as RTCIceServer[], iceTransportPolicy: 'relay' })
  try {
    pc.createDataChannel('probe')
    const found = new Promise<string>((resolve, reject) => {
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ relay /.test(e.candidate.candidate)) resolve(e.candidate.candidate)
        if (!e.candidate) reject(new Error('gathering finished without a relay candidate'))
      }
    })
    await pc.setLocalDescription(await pc.createOffer())
    const cand = await withTimeout(found, timeoutMs, 'TURN allocation')
    return {
      name: 'allocation',
      ok: true,
      ms: Math.round(performance.now() - t0),
      detail: cand.split(' ').slice(4, 6).join(':'),
    }
  } catch (e) {
    return {
      name: 'allocation',
      ok: false,
      ms: Math.round(performance.now() - t0),
      detail: errorText(e),
    }
  } finally {
    pc.close()
  }
}

export async function checkRelay(opts: HealthOptions): Promise<HealthReport> {
  const [nip11, [auth, signaling], turn] = await Promise.all([
    checkNip11(opts),
    checkSocket(opts),
    checkTurnCredentials(opts),
  ])
  let allocation: HealthCheck = { name: 'allocation', ok: null, detail: 'skipped' }
  if (turn.creds && opts.allocationTest)
    allocation = await opts.allocationTest(turn.creds.iceServers)
  else if (turn.creds)
    allocation = {
      name: 'allocation',
      ok: null,
      detail: 'allocation test runs in the browser only',
    }
  return {
    relay: opts.relay,
    at: Date.now(),
    checks: [nip11, auth, signaling, turn.check, allocation],
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
