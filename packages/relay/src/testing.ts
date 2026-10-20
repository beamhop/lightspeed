// In-process fakes of the engine contracts (engines.ts) and helpers for the relay's tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { type DeepPartial, makeConfig, type RelayConfig } from './config'
import type {
  AllocationInfo,
  Filter,
  Nip11Info,
  NostrEvent,
  NostrRelay,
  NostrRelayOptions,
  TurnServer,
  TurnServerOptions,
} from './engines'
import { silentLogger } from './log'
import type { InvoiceStatus, MadeInvoice, NwcClient } from './nwc'
import { createRelayServer, type RelayServer, type RelayServerDeps } from './server'
import { randomHex, verifyEvent } from './util/crypto'

interface FakeSock {
  realm: string | null
  ip: string
  subs: Map<string, Filter[]>
}

function matches(e: NostrEvent, f: Filter): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.since !== undefined && e.created_at < f.since) return false
  if (f.until !== undefined && e.created_at > f.until) return false
  if (f.search && !e.content.includes(f.search)) return false
  for (const [k, v] of Object.entries(f)) {
    if (
      k.startsWith('#') &&
      Array.isArray(v) &&
      !e.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1] as string))
    )
      return false
  }
  return true
}

/** Minimal NostrRelay: EVENT/REQ/CLOSE over WS, policy checks incl. writeAllowed, NIP-86 banevent. */
export class FakeNostrRelay implements NostrRelay {
  events: { e: NostrEvent; realm: string | null }[] = []
  sockets = new Set<ServerWebSocket<FakeSock>>()
  private listeners = new Set<(e: NostrEvent, realm: string | null) => void>()
  closed = false

  constructor(readonly opts: NostrRelayOptions) {}

  get info(): Nip11Info {
    return this.opts.info
  }

  websocket = {
    open: (ws: ServerWebSocket<object>) => {
      this.sockets.add(ws as ServerWebSocket<FakeSock>)
    },
    message: (ws: ServerWebSocket<object>, raw: string | Buffer) => {
      const s = ws as ServerWebSocket<FakeSock>
      const msg = JSON.parse(String(raw)) as unknown[]
      if (msg[0] === 'EVENT') {
        void this.publish(msg[1] as NostrEvent, s.data.realm).then((r) =>
          s.send(JSON.stringify(['OK', (msg[1] as NostrEvent).id, r.ok, r.message])),
        )
      } else if (msg[0] === 'REQ') {
        const id = String(msg[1])
        const filters = msg.slice(2) as Filter[]
        s.data.subs.set(id, filters)
        for (const e of this.query(filters, s.data.realm)) s.send(JSON.stringify(['EVENT', id, e]))
        s.send(JSON.stringify(['EOSE', id]))
      } else if (msg[0] === 'CLOSE') {
        s.data.subs.delete(String(msg[1]))
      }
    },
    close: (ws: ServerWebSocket<object>) => {
      this.sockets.delete(ws as ServerWebSocket<FakeSock>)
    },
  }

  socketData(ctx: { realm: string | null; ip: string }): FakeSock {
    return { realm: ctx.realm, ip: ctx.ip, subs: new Map() }
  }

  handleInfo(_req: Request, realm: string | null): Response {
    return new Response(JSON.stringify({ ...this.opts.info, realm }), {
      headers: { 'content-type': 'application/nostr+json' },
    })
  }

  async handleManagement(req: Request, realm: string | null): Promise<Response> {
    const h = req.headers.get('authorization') ?? ''
    const ev = h.startsWith('Nostr ') ? (JSON.parse(atob(h.slice(6))) as NostrEvent) : null
    const admin = this.opts.info.self ?? this.opts.info.pubkey
    if (!ev || !verifyEvent(ev) || ev.kind !== 27235 || ev.pubkey !== admin)
      return new Response('unauthorized', { status: 401 })
    const body = (await req.json()) as { method: string; params: string[] }
    if (body.method === 'banevent') {
      const before = this.events.length
      this.events = this.events.filter((x) => !(x.e.id === body.params[0] && x.realm === realm))
      return Response.json(
        before === this.events.length ? { error: 'not found' } : { result: true },
      )
    }
    return Response.json({ error: 'unsupported' })
  }

  async publish(
    e: NostrEvent,
    realm: string | null = null,
  ): Promise<{ ok: boolean; message: string }> {
    if (!verifyEvent(e)) return { ok: false, message: 'invalid: bad signature' }
    const p = this.opts.policy?.get(realm)
    if (p?.pubkeys?.deny?.includes(e.pubkey))
      return { ok: false, message: 'blocked: pubkey denied' }
    if (p?.kinds?.deny?.includes(e.kind)) return { ok: false, message: 'blocked: kind denied' }
    if (p?.writeAllowed && !p.writeAllowed(e.pubkey))
      return { ok: false, message: 'restricted: payment required' }
    if (!(e.kind >= 20000 && e.kind < 30000)) this.events.push({ e, realm })
    for (const s of this.sockets) {
      if (s.data.realm !== realm) continue
      for (const [id, fs] of s.data.subs)
        if (fs.some((f) => matches(e, f))) s.send(JSON.stringify(['EVENT', id, e]))
    }
    for (const l of this.listeners) l(e, realm)
    return { ok: true, message: '' }
  }

  query(filters: Filter[], realm: string | null = null): NostrEvent[] {
    const out = this.events
      .filter((x) => x.realm === realm && filters.some((f) => matches(x.e, f)))
      .map((x) => x.e)
    const limit = Math.min(...filters.map((f) => f.limit ?? 500))
    return out.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  stats() {
    let subscriptions = 0
    for (const s of this.sockets) subscriptions += s.data.subs.size
    return {
      events: this.events.length,
      subscriptions,
      clients: this.sockets.size,
      eventsPerSec: 0,
    }
  }

  onEvent(cb: (e: NostrEvent, realm: string | null) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  close() {
    this.closed = true
  }
}

/** TurnServer fake: records options, exposes allocations the test can add. */
export class FakeTurnServer implements TurnServer {
  allocs: AllocationInfo[] = []
  started = false
  constructor(readonly opts: TurnServerOptions) {}
  async start() {
    this.started = true
    return { udp: 3478, tcp: 3478 }
  }
  async stop() {
    this.started = false
  }
  allocations() {
    return this.allocs
  }
  kill(id: string) {
    const n = this.allocs.length
    this.allocs = this.allocs.filter((a) => a.id !== id)
    return this.allocs.length !== n
  }
  stats() {
    return { allocations: this.allocs.length, bytesIn: 10, bytesOut: 20, bps: 0 }
  }
}

/** Wallet fake: invoices are paid when the test calls `pay(hash)`. */
export class FakeNwc implements NwcClient {
  invoices = new Map<string, { amountMsat: number; paid: boolean }>()
  closed = false
  async makeInvoice(p: {
    amountMsat: number
    description: string
    expirySec: number
  }): Promise<MadeInvoice> {
    const paymentHash = randomHex(32)
    this.invoices.set(paymentHash, { amountMsat: p.amountMsat, paid: false })
    return {
      invoice: `lnbc${p.amountMsat / 1000}n1fake${paymentHash.slice(0, 20)}`,
      paymentHash,
      expiresAt: Math.floor(Date.now() / 1000) + p.expirySec,
    }
  }
  async lookupInvoice(p: { paymentHash: string }): Promise<InvoiceStatus> {
    const inv = this.invoices.get(p.paymentHash)
    return { paid: !!inv?.paid, settledAt: inv?.paid ? Math.floor(Date.now() / 1000) : undefined }
  }
  pay(hash: string) {
    const inv = this.invoices.get(hash)
    if (inv) inv.paid = true
  }
  close() {
    this.closed = true
  }
}

export interface TestRelay {
  relay: RelayServer
  base: string
  wsBase: string
  nostr: () => FakeNostrRelay
  turn: () => FakeTurnServer
  nwc: FakeNwc
  dataDir: string
  bootstrapToken: string | null
  close(): Promise<void>
}

/** Start a relay on 127.0.0.1:0 with fakes and a temp data dir. */
export async function startTestRelay(
  partial: DeepPartial<RelayConfig> = {},
  deps: RelayServerDeps = {},
): Promise<TestRelay> {
  const dataDir = mkdtempSync(join(tmpdir(), 'beamhop-relay-'))
  const config = makeConfig({
    ...partial,
    dataDir,
    http: { host: '127.0.0.1', port: 0, ...(partial.http ?? {}) },
    backups: { enabled: false, ...(partial.backups ?? {}) },
  })
  let nostr: FakeNostrRelay | null = null
  let turn: FakeTurnServer | null = null
  const nwc = new FakeNwc()
  const relay = createRelayServer(config, {
    logger: silentLogger(),
    nostrFactory: (o) => (nostr = new FakeNostrRelay(o)),
    turnFactory: (o) => (turn = new FakeTurnServer(o)),
    nwcFactory: () => nwc,
    ...deps,
  })
  const res = await relay.start()
  const base = `http://127.0.0.1:${res.port}`
  return {
    relay,
    base,
    wsBase: base.replace('http', 'ws'),
    nostr: () => nostr as unknown as FakeNostrRelay,
    turn: () => turn as unknown as FakeTurnServer,
    nwc,
    dataDir,
    bootstrapToken: res.bootstrapToken,
    async close() {
      await relay.stop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** JSON request helper that sends a same-origin Origin header and an optional session cookie. */
export async function api(
  base: string,
  path: string,
  opts: {
    method?: string
    body?: unknown
    cookie?: string
    origin?: string | null
    headers?: Record<string, string>
  } = {},
  // biome-ignore lint/suspicious/noExplicitAny: test helper returns arbitrary JSON
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin !== null) headers.origin = opts.origin ?? base
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, body, headers: res.headers }
}

export function cookieFrom(headers: Headers): string {
  const sc = headers.get('set-cookie') ?? ''
  return sc.split(';')[0] ?? ''
}

/** Claim the relay with the bootstrap token as a pubkey admin; returns the session cookie. */
export async function bootstrapPubkeyAdmin(t: TestRelay, pubkey: string): Promise<string> {
  const r = await api(t.base, '/api/admin/auth/bootstrap', {
    body: { token: t.bootstrapToken, pubkey },
  })
  if (r.status !== 200) throw new Error(`bootstrap failed: ${JSON.stringify(r.body)}`)
  return cookieFrom(r.headers)
}

/** WebSocket test client that buffers messages and waits for matches. */
export class WsClient {
  messages: (string | Uint8Array)[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (m) => {
      this.messages.push(
        typeof m.data === 'string' ? m.data : new Uint8Array(m.data as ArrayBuffer),
      )
      for (const w of this.waiters.splice(0)) w()
    }
    ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason }
      for (const w of this.waiters.splice(0)) w()
    }
  }

  static open(url: string, headers?: Record<string, string>): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      // Bun's WebSocket accepts a headers option (cookies/origin for the admin stats socket).
      const ws = headers
        ? new WebSocket(url, { headers } as unknown as string[])
        : new WebSocket(url)
      const c = new WsClient(ws)
      ws.onopen = () => resolve(c)
      ws.onerror = () => reject(new Error(`websocket error ${url}`))
    })
  }

  /** Wait for (and consume) the first buffered message matching `pred`. */
  // biome-ignore lint/suspicious/noExplicitAny: predicate over arbitrary JSON
  async next<T = any>(pred: (m: any) => boolean = () => true, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.messages.findIndex((m) => {
        if (typeof m !== 'string') return pred(m)
        try {
          return pred(JSON.parse(m))
        } catch {
          return false
        }
      })
      if (i >= 0) {
        const [m] = this.messages.splice(i, 1)
        return (typeof m === 'string' ? JSON.parse(m) : m) as T
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code} ${this.closed.reason})`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('timed out waiting for message')
      await new Promise<void>((r) => {
        const t = setTimeout(r, left)
        this.waiters.push(() => {
          clearTimeout(t)
          r()
        })
      })
    }
  }

  async waitClosed(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    return this.closed
  }

  send(m: string | Uint8Array) {
    this.ws.send(m)
  }

  close() {
    this.ws.close()
  }
}
