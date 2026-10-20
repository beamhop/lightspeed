import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import type { Server } from 'bun'
import { computeId, powDifficulty } from '../src/event'
import { createNostrRelay } from '../src/index'
import type { NostrEvent, NostrRelay, NostrRelayOptions, NostrSocketData } from '../src/types'

export interface Keys {
  sk: Uint8Array
  pk: string
}

export function genKeys(): Keys {
  const sk = schnorr.utils.randomPrivateKey()
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

export interface Template {
  kind?: number
  content?: string
  tags?: string[][]
  created_at?: number
}

export const now = () => Math.floor(Date.now() / 1000)

export function sign(keys: Keys, t: Template = {}): NostrEvent {
  const base = {
    pubkey: keys.pk,
    created_at: t.created_at ?? now(),
    kind: t.kind ?? 1,
    tags: t.tags ?? [],
    content: t.content ?? '',
  }
  const id = computeId(base)
  return { ...base, id, sig: bytesToHex(schnorr.sign(id, keys.sk)) }
}

/** NIP-13 mining with a committed target. */
export function mine(keys: Keys, t: Template, bits: number): NostrEvent {
  const created_at = t.created_at ?? now()
  for (let nonce = 0; ; nonce++) {
    const base = {
      pubkey: keys.pk,
      created_at,
      kind: t.kind ?? 1,
      tags: [...(t.tags ?? []), ['nonce', String(nonce), String(bits)]],
      content: t.content ?? '',
    }
    const id = computeId(base)
    if (powDifficulty(id) >= bits)
      return { ...base, id, sig: bytesToHex(schnorr.sign(id, keys.sk)) }
  }
}

export interface TestRelay {
  relay: NostrRelay
  server: Server<NostrSocketData>
  url: string
  httpUrl: string
  close(): void
}

/** Starts the engine behind a real Bun.serve on port 0. `/` = public relay, `/a/<id>` = realm. */
export function startRelay(opts: Partial<NostrRelayOptions> = {}): TestRelay {
  const relay = createNostrRelay({
    dbPath: ':memory:',
    info: { name: 'test relay', description: 'conformance' },
    sweepIntervalMs: 0,
    ...opts,
  })
  const realmOf = (path: string) => {
    const m = /^\/a\/([^/]+)\/?$/.exec(path)
    return m ? (m[1] as string) : null
  }
  const server = Bun.serve<NostrSocketData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url)
      const realm = realmOf(url.pathname)
      if (url.pathname !== '/' && realm === null) return new Response('not found', { status: 404 })
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const ip = srv.requestIP(req)?.address ?? ''
        const fwd = req.headers.get('x-test-ip')
        if (srv.upgrade(req, { data: relay.socketData({ realm, ip: fwd ?? ip }) })) return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      if (req.headers.get('content-type')?.startsWith('application/nostr+json+rpc'))
        return relay.handleManagement(req, realm)
      if (req.headers.get('accept')?.includes('application/nostr+json') || req.method === 'OPTIONS')
        return relay.handleInfo(req, realm)
      return new Response('nostr relay')
    },
    websocket: relay.websocket,
  })
  const base = `127.0.0.1:${server.port}`
  return {
    relay,
    server,
    url: `ws://${base}`,
    httpUrl: `http://${base}`,
    close() {
      relay.close()
      server.stop(true)
    },
  }
}

type Msg = unknown[]

/** Minimal WebSocket Nostr client for tests. */
export class Client {
  private queue: Msg[] = []
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  all: Msg[] = []
  challenge = ''

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg
      this.all.push(m)
      if (m[0] === 'AUTH') this.challenge = m[1] as string
      const i = this.waiters.findIndex((w) => w.pred(m))
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1)
        w?.resolve(m)
      } else this.queue.push(m)
    }
  }

  static connect(url: string, headers?: Record<string, string>): Promise<Client> {
    // Bun's WebSocket accepts a headers option.
    const ws = new WebSocket(url, headers ? ({ headers } as unknown as string[]) : undefined)
    const c = new Client(ws)
    return new Promise((resolve, reject) => {
      ws.onopen = async () => {
        await c.next((m) => m[0] === 'AUTH')
        resolve(c)
      }
      ws.onerror = (e) => reject(e)
    })
  }

  send(msg: Msg) {
    this.ws.send(JSON.stringify(msg))
  }

  /** Wait for the next message matching `pred` (consumes it). */
  next(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const i = this.queue.findIndex(pred)
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as Msg)
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      this.waiters.push(w)
      setTimeout(() => {
        const j = this.waiters.indexOf(w)
        if (j >= 0) {
          this.waiters.splice(j, 1)
          reject(
            new Error(`timeout waiting for message; last: ${JSON.stringify(this.all.slice(-3))}`),
          )
        }
      }, timeoutMs)
    })
  }

  /** Messages of a given type currently queued (not consumed). */
  pending(type: string) {
    return this.queue.filter((m) => m[0] === type)
  }

  async publish(ev: NostrEvent): Promise<{ ok: boolean; message: string }> {
    this.send(['EVENT', ev])
    const m = await this.next((x) => x[0] === 'OK' && x[1] === ev.id)
    return { ok: m[2] as boolean, message: m[3] as string }
  }

  /** REQ and collect events until EOSE (or CLOSED). Subscription stays open unless closed. */
  async req(
    subId: string,
    ...filters: object[]
  ): Promise<{ events: NostrEvent[]; closed?: string }> {
    this.send(['REQ', subId, ...filters])
    const events: NostrEvent[] = []
    for (;;) {
      const m = await this.next(
        (x) => (x[0] === 'EVENT' || x[0] === 'EOSE' || x[0] === 'CLOSED') && x[1] === subId,
      )
      if (m[0] === 'EVENT') events.push(m[2] as NostrEvent)
      else if (m[0] === 'CLOSED') return { events, closed: m[2] as string }
      else return { events }
    }
  }

  async query(...filters: object[]) {
    const id = `q${Math.random().toString(36).slice(2, 10)}`
    const r = await this.req(id, ...filters)
    this.send(['CLOSE', id])
    return r.events
  }

  async count(...filters: object[]): Promise<number | string> {
    const id = `c${Math.random().toString(36).slice(2, 10)}`
    this.send(['COUNT', id, ...filters])
    const m = await this.next((x) => (x[0] === 'COUNT' || x[0] === 'CLOSED') && x[1] === id)
    return m[0] === 'COUNT' ? (m[2] as { count: number }).count : (m[2] as string)
  }

  async auth(keys: Keys, relayUrl: string, challenge = this.challenge) {
    const ev = sign(keys, {
      kind: 22242,
      tags: [
        ['relay', relayUrl],
        ['challenge', challenge],
      ],
    })
    this.send(['AUTH', ev])
    const m = await this.next((x) => x[0] === 'OK' && x[1] === ev.id)
    return { ok: m[2] as boolean, message: m[3] as string }
  }

  close() {
    this.ws.close()
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function nip98Header(keys: Keys, url: string, method: string, body: string) {
  const ev = sign(keys, {
    kind: 27235,
    tags: [
      ['u', url],
      ['method', method],
      ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
    ],
  })
  return `Nostr ${btoa(JSON.stringify(ev))}`
}

export async function manage(
  t: TestRelay,
  keys: Keys,
  method: string,
  params: unknown[] = [],
  path = '/',
) {
  const url = `${t.httpUrl}${path}`
  const body = JSON.stringify({ method, params })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/nostr+json+rpc',
      authorization: nip98Header(keys, url, 'POST', body),
    },
    body,
  })
  return { status: res.status, body: (await res.json()) as { result: unknown; error?: string } }
}
