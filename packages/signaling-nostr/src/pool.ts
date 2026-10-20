// Minimal Nostr relay pool: reconnect with backoff, subscriptions, publish with OK tracking,
// NIP-42 AUTH, CLOSED/NOTICE handling, rate-limit backoff, cross-relay dedupe + signature checks.
import type { Identity, SignalingStatus } from '@beamhop/p2p/types'
import { type NostrEvent, nowSeconds, signEvent, verifyEvent } from './event'

export interface Filter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  [tag: `#${string}`]: string[] | undefined
}

export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  // biome-ignore lint/suspicious/noExplicitAny: must accept DOM and ws event listener shapes
  addEventListener(type: string, listener: (ev: any) => void): void
}

export type WebSocketCtor = new (url: string) => WebSocketLike

export interface PublishResult {
  url: string
  ok: boolean
  message: string
}

export interface RelayPoolOptions {
  /** Signer used for NIP-42 AUTH. Omit to never answer AUTH challenges. */
  auth?: Pick<Identity, 'pubkey' | 'sign'>
  WebSocket?: WebSocketCtor
  /** Reconnect backoff bounds (ms). Defaults 500 / 30000. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Time to wait for an OK per relay before a publish counts as failed. Default 10000. */
  publishTimeoutMs?: number
}

interface SubEntry {
  /** Called on every (re)send so `since` is fresh. */
  filters: () => Filter[]
  onEvent: (event: NostrEvent, url: string) => void
  seen: Map<string, number>
}

interface PendingPublish {
  event: NostrEvent
  resolve: (r: PublishResult) => void
  timer: ReturnType<typeof setTimeout>
  waitingAuth: boolean
  retries: number
}

const OPEN = 1
const SEEN_TTL_MS = 5 * 60_000

const reasonOf = (msg: string): string => {
  const i = msg.indexOf(':')
  return i > 0 ? msg.slice(0, i).trim() : ''
}

class RelayConnection {
  state: SignalingStatus['state'] = 'connecting'
  error: string | undefined
  private ws: WebSocketLike | undefined
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private pausedUntil = 0
  private pauseTimer: ReturnType<typeof setTimeout> | undefined
  private rateBackoffMs = 1000
  private authed = false
  private authEventId: string | undefined
  private readonly closedForAuth = new Set<string>()
  private readonly pending = new Map<string, PendingPublish>()

  constructor(
    readonly url: string,
    private readonly pool: RelayPool,
    private readonly opts: Required<Omit<RelayPoolOptions, 'auth'>> & RelayPoolOptions,
  ) {
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    this.state = 'connecting'
    let ws: WebSocketLike
    try {
      ws = new this.opts.WebSocket(this.url)
    } catch (err) {
      this.state = 'error'
      this.error = String(err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.state = 'open'
      this.error = undefined
      this.attempts = 0
      this.flush()
    })
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (this.ws !== ws) return
      if (typeof ev.data === 'string') this.onMessage(ev.data)
    })
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return
      this.state = 'error'
      this.error = 'websocket error'
    })
    ws.addEventListener('close', (ev: { code?: number; reason?: string }) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.authed = false
      this.authEventId = undefined
      if (this.state !== 'error') this.state = 'closed'
      if (ev?.reason) this.error = ev.reason
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const { minBackoffMs, maxBackoffMs } = this.opts
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** this.attempts)
    this.attempts++
    const delay = base / 2 + Math.random() * (base / 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private get writable(): boolean {
    return !!this.ws && this.ws.readyState === OPEN && Date.now() >= this.pausedUntil
  }

  private raw(msg: unknown[]): void {
    try {
      this.ws?.send(JSON.stringify(msg))
    } catch {
      // the close handler reconnects and flushes
    }
  }

  /** (Re)send every subscription and every unacknowledged event. */
  private flush(): void {
    if (!this.ws || this.ws.readyState !== OPEN) return
    for (const [id, sub] of this.pool.subscriptions()) {
      if (!this.closedForAuth.has(id)) this.raw(['REQ', id, ...sub.filters()])
    }
    if (!this.writable) return
    for (const p of this.pending.values()) {
      if (!p.waitingAuth) this.raw(['EVENT', p.event])
    }
  }

  req(id: string, filters: Filter[]): void {
    if (this.ws?.readyState === OPEN) this.raw(['REQ', id, ...filters])
  }

  unsub(id: string): void {
    this.closedForAuth.delete(id)
    if (this.ws?.readyState === OPEN) this.raw(['CLOSE', id])
  }

  publish(event: NostrEvent): Promise<PublishResult> {
    return new Promise((resolve) => {
      const existing = this.pending.get(event.id)
      if (existing) clearTimeout(existing.timer)
      const timer = setTimeout(() => {
        this.pending.delete(event.id)
        resolve({ url: this.url, ok: false, message: 'timeout' })
      }, this.opts.publishTimeoutMs)
      this.pending.set(event.id, { event, resolve, timer, waitingAuth: false, retries: 0 })
      if (this.writable) this.raw(['EVENT', event])
    })
  }

  private settle(id: string, ok: boolean, message: string): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve({ url: this.url, ok, message })
  }

  private pause(): void {
    this.pausedUntil = Date.now() + this.rateBackoffMs
    const delay = this.rateBackoffMs
    this.rateBackoffMs = Math.min(this.rateBackoffMs * 2, this.opts.maxBackoffMs)
    clearTimeout(this.pauseTimer)
    this.pauseTimer = setTimeout(() => this.flush(), delay + 5)
  }

  private onMessage(data: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return
    switch (msg[0]) {
      case 'EVENT': {
        if (typeof msg[1] === 'string') this.pool.receive(msg[1], msg[2], this.url)
        return
      }
      case 'OK': {
        const [, id, ok, message = ''] = msg as [string, string, boolean, string?]
        if (typeof id !== 'string') return
        if (id === this.authEventId) {
          this.authEventId = undefined
          if (ok) {
            this.authed = true
            this.onAuthed()
          } else {
            this.error = `auth rejected: ${message}`
          }
          return
        }
        const p = this.pending.get(id)
        if (!p) return
        if (ok) {
          this.rateBackoffMs = 1000
          this.settle(id, true, message)
          return
        }
        const reason = reasonOf(message)
        if (reason === 'auth-required' && this.pool.authSigner && !this.authed && p.retries < 1) {
          p.retries++
          p.waitingAuth = true
          return
        }
        if (reason === 'rate-limited' && p.retries < 3) {
          p.retries++
          this.pause()
          return
        }
        this.settle(id, false, message)
        return
      }
      case 'CLOSED': {
        const [, id, message = ''] = msg as [string, string, string?]
        if (typeof id !== 'string' || !this.pool.hasSubscription(id)) return
        const reason = reasonOf(message)
        if (reason === 'auth-required' && this.pool.authSigner && !this.authed) {
          this.closedForAuth.add(id)
        } else if (reason === 'rate-limited' || reason === 'error') {
          const delay = this.rateBackoffMs
          this.pause()
          setTimeout(() => {
            const sub = this.pool.subscription(id)
            if (sub) this.req(id, sub.filters())
          }, delay)
        } else {
          this.error = `subscription closed: ${message}`
        }
        return
      }
      case 'NOTICE': {
        const message = String(msg[1] ?? '')
        this.error = message
        if (/rate|slow down|too (many|fast)/i.test(message)) this.pause()
        return
      }
      case 'AUTH': {
        if (typeof msg[1] === 'string') void this.authenticate(msg[1])
        return
      }
      default:
        return
    }
  }

  private async authenticate(challenge: string): Promise<void> {
    const signer = this.pool.authSigner
    if (!signer) return
    const ws = this.ws
    const event = await signEvent(
      {
        kind: 22242,
        tags: [
          ['relay', this.url],
          ['challenge', challenge],
        ],
        content: '',
      },
      signer,
    )
    if (this.ws !== ws) return
    this.authEventId = event.id
    this.raw(['AUTH', event])
  }

  private onAuthed(): void {
    for (const id of [...this.closedForAuth]) {
      this.closedForAuth.delete(id)
      const sub = this.pool.subscription(id)
      if (sub) this.req(id, sub.filters())
    }
    for (const p of this.pending.values()) {
      if (p.waitingAuth) {
        p.waitingAuth = false
        if (this.writable) this.raw(['EVENT', p.event])
      }
    }
  }

  status(): SignalingStatus {
    const s: SignalingStatus = { url: this.url, state: this.state }
    if (this.error) s.error = this.error
    return s
  }

  close(): void {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.pauseTimer)
    for (const id of [...this.pending.keys()]) this.settle(id, false, 'closed')
    this.state = 'closed'
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close()
    } catch {
      // ignore
    }
  }
}

let subCounter = 0

export class RelayPool {
  private readonly relays: RelayConnection[]
  private readonly subs = new Map<string, SubEntry>()
  readonly authSigner: Pick<Identity, 'pubkey' | 'sign'> | undefined
  /** Count of events dropped for a bad id/signature (telemetry/tests). */
  dropped = 0

  constructor(urls: string[], opts: RelayPoolOptions = {}) {
    this.authSigner = opts.auth
    const WS = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined)
    if (!WS) throw new Error('No WebSocket implementation available; pass options.WebSocket')
    const full = {
      ...opts,
      WebSocket: WS,
      minBackoffMs: opts.minBackoffMs ?? 500,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
      publishTimeoutMs: opts.publishTimeoutMs ?? 10_000,
    }
    this.relays = [...new Set(urls)].map((u) => new RelayConnection(u, this, full))
  }

  subscriptions(): IterableIterator<[string, SubEntry]> {
    return this.subs.entries()
  }

  subscription(id: string): SubEntry | undefined {
    return this.subs.get(id)
  }

  hasSubscription(id: string): boolean {
    return this.subs.has(id)
  }

  subscribe(
    filters: Filter[] | (() => Filter[]),
    onEvent: (event: NostrEvent, url: string) => void,
  ): () => void {
    const id = `bh${(++subCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const get = typeof filters === 'function' ? filters : () => filters
    this.subs.set(id, { filters: get, onEvent, seen: new Map() })
    const f = get()
    for (const r of this.relays) r.req(id, f)
    return () => {
      if (!this.subs.delete(id)) return
      for (const r of this.relays) r.unsub(id)
    }
  }

  /** Called by a relay connection for every incoming EVENT. */
  receive(subId: string, event: unknown, url: string): void {
    const sub = this.subs.get(subId)
    if (!sub || !event || typeof event !== 'object') return
    const id = (event as { id?: unknown }).id
    if (typeof id !== 'string' || sub.seen.has(id)) return
    if (!verifyEvent(event)) {
      this.dropped++
      return
    }
    const now = Date.now()
    sub.seen.set(id, now)
    this.prune(sub.seen, now)
    sub.onEvent(event as NostrEvent, url)
  }

  private prune(map: Map<string, number>, now: number): void {
    if (map.size < 2048) return
    for (const [k, t] of map) {
      if (now - t < SEEN_TTL_MS && map.size < 8192) break
      map.delete(k)
    }
  }

  /** Publishes to every relay; resolves with per-relay results once all settled. */
  async publish(event: NostrEvent): Promise<PublishResult[]> {
    return Promise.all(this.relays.map((r) => r.publish(event)))
  }

  /** Resolves as soon as one relay accepts; rejects if every relay rejects or times out. */
  publishAny(event: NostrEvent): Promise<PublishResult> {
    return new Promise((resolve, reject) => {
      let failed = 0
      const errors: string[] = []
      if (this.relays.length === 0) reject(new Error('no relays configured'))
      for (const r of this.relays) {
        void r.publish(event).then((res) => {
          if (res.ok) return resolve(res)
          errors.push(`${res.url}: ${res.message}`)
          if (++failed === this.relays.length) {
            reject(new Error(`publish failed on all relays (${errors.join('; ')})`))
          }
        })
      }
    })
  }

  status(): SignalingStatus[] {
    return this.relays.map((r) => r.status())
  }

  close(): void {
    for (const r of this.relays) r.close()
    this.subs.clear()
  }

  /** Seconds since epoch, exposed for filters. */
  static now(): number {
    return nowSeconds()
  }
}
