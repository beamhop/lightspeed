// In-process transport for tests, the seeded simulator and Studio fault injection.
import type {
  Channel,
  Connection,
  ConnectionStats,
  Hex,
  PathType,
  Reliability,
  Transport,
  TransportConnectOptions,
  Unsubscribe,
} from '../types'
import { randomId } from '../util/bytes'
import { type Clock, realClock, seededRandom } from '../util/clock'
import { Listeners } from '../util/emitter'

export interface LinkConditions {
  /** One-way latency in ms. */
  latencyMs: number
  /** Uniform extra delay in [0, jitterMs). */
  jitterMs: number
  /** Packet loss probability in [0, 1]. Unreliable channels drop; reliable ones pay a retransmit delay. */
  loss: number
  /** Serialization rate; Infinity disables bandwidth modelling. */
  bandwidthBps: number
  /** Path badge reported by connections on this link. */
  path: PathType
}

export interface MemoryHubOptions {
  clock?: Clock
  /** Seed for the loss/jitter RNG (default 1). */
  seed?: number
  defaults?: Partial<LinkConditions>
  /** How long a broken link takes to surface as a 'disconnected' connection (default 1500 ms). */
  detectMs?: number
}

const pairKey = (a: Hex, b: Hex) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export interface MemoryLinkInfo {
  id: string
  a: Hex
  b: Hex
  path: PathType
  state: Connection['state']
  bytes: number
}

/** Shared medium for memory transports, with fault-injection hooks. */
export class MemoryHub {
  readonly clock: Clock
  readonly random: () => number
  defaults: LinkConditions
  detectMs: number
  private links = new Map<string, Partial<LinkConditions>>()
  private partitions: { id: number; a: Set<Hex>; b: Set<Hex> | null }[] = []
  private partitionSeq = 0
  private killed = new Set<Hex>()
  private pending = new Map<string, { from: Hex; to: Hex; conn: MemoryConnection }>()
  private live = new Set<MemoryConnection>()

  constructor(opts: MemoryHubOptions = {}) {
    this.clock = opts.clock ?? realClock
    this.random = seededRandom(opts.seed ?? 1)
    this.detectMs = opts.detectMs ?? 1500
    this.defaults = {
      latencyMs: 0,
      jitterMs: 0,
      loss: 0,
      bandwidthBps: Number.POSITIVE_INFINITY,
      path: 'memory',
      ...opts.defaults,
    }
  }

  conditions(a: Hex, b: Hex): LinkConditions {
    return { ...this.defaults, ...this.links.get(pairKey(a, b)) }
  }

  /** Override conditions for one pair (symmetric). */
  setLink(a: Hex, b: Hex, cond: Partial<LinkConditions>): void {
    this.links.set(pairKey(a, b), { ...this.links.get(pairKey(a, b)), ...cond })
  }

  setDefaults(cond: Partial<LinkConditions>): void {
    this.defaults = { ...this.defaults, ...cond }
  }

  /** Cut every link between `a` and `b` (or between `a` and everyone else when `b` is omitted). */
  partition(a: Hex[], b?: Hex[]): number {
    const id = ++this.partitionSeq
    this.partitions.push({ id, a: new Set(a), b: b ? new Set(b) : null })
    for (const c of this.live) if (this.blocked(c.local, c.remote)) c.scheduleFailure()
    return id
  }

  /** Remove one partition (by the id `partition` returned). */
  unpartition(id: number): void {
    this.partitions = this.partitions.filter((p) => p.id !== id)
    for (const c of this.live) if (!this.blocked(c.local, c.remote)) c.cancelFailure()
  }

  /** Current overrides for a pair (for restoring after a temporary fault). */
  linkOverride(a: Hex, b: Hex): Partial<LinkConditions> | undefined {
    const v = this.links.get(pairKey(a, b))
    return v ? { ...v } : undefined
  }

  /** Replace (or with `undefined`, remove) the overrides for a pair. */
  resetLink(a: Hex, b: Hex, cond?: Partial<LinkConditions>): void {
    if (cond) this.links.set(pairKey(a, b), { ...cond })
    else this.links.delete(pairKey(a, b))
  }

  /** Remove all partitions. Broken connections stay broken; peers reconnect. */
  heal(): void {
    this.partitions = []
    for (const c of this.live) c.cancelFailure()
  }

  /** Crash a peer's network: its connections drop and new ones fail until `revive`. */
  kill(pubkey: Hex): void {
    this.killed.add(pubkey)
    for (const c of [...this.live])
      if (c.local === pubkey || c.remote === pubkey) c.scheduleFailure(0)
  }

  revive(pubkey: Hex): void {
    this.killed.delete(pubkey)
  }

  blocked(x: Hex, y: Hex): boolean {
    if (this.killed.has(x) || this.killed.has(y)) return true
    for (const p of this.partitions) {
      const inA = (k: Hex) => p.a.has(k)
      const inB = (k: Hex) => (p.b ? p.b.has(k) : !p.a.has(k))
      if ((inA(x) && inB(y)) || (inA(y) && inB(x))) return true
    }
    return false
  }

  /** Live connections (one entry per pair), for Studio's topology view. */
  connections(): MemoryLinkInfo[] {
    const out: MemoryLinkInfo[] = []
    for (const c of this.live) {
      if (c.local > c.remote) continue
      out.push({
        id: c.id,
        a: c.local,
        b: c.remote,
        path: c.path,
        state: c.state,
        bytes: c.bytesSent + c.bytesReceived,
      })
    }
    return out
  }

  /** @internal */
  register(id: string, from: Hex, to: Hex, conn: MemoryConnection): void {
    this.pending.set(id, { from, to, conn })
  }

  /** @internal */
  take(id: string): { from: Hex; to: Hex; conn: MemoryConnection } | undefined {
    const p = this.pending.get(id)
    this.pending.delete(id)
    return p
  }

  /** @internal */
  track(c: MemoryConnection, on: boolean): void {
    if (on) this.live.add(c)
    else this.live.delete(c)
  }
}

export function createMemoryHub(opts?: MemoryHubOptions): MemoryHub {
  return new MemoryHub(opts)
}

// ---------------------------------------------------------------- channel

class MemoryChannel implements Channel {
  readyState: Channel['readyState'] = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  peer: MemoryChannel | null = null
  private openL = new Listeners<[]>()
  private msgL = new Listeners<[Uint8Array]>()
  private lowL = new Listeners<[]>()
  private closeL = new Listeners<[]>()
  private queued: Uint8Array[] = []
  private inbox: Uint8Array[] = []
  lastDeliver = 0
  private txFree = 0

  constructor(
    readonly label: string,
    readonly reliability: Reliability,
    private conn: MemoryConnection,
  ) {}

  /** @internal */
  open(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    this.openL.emit()
    const q = this.queued
    this.queued = []
    for (const m of q) this.send(m)
  }

  send(data: Uint8Array): void {
    if (this.readyState === 'closing' || this.readyState === 'closed')
      throw new Error('channel closed')
    const copy = data.slice()
    if (this.readyState === 'connecting') {
      this.queued.push(copy)
      return
    }
    const hub = this.conn.hub
    const clock = hub.clock
    const cond = hub.conditions(this.conn.local, this.conn.remote)
    const now = clock.now()
    // Serialization delay drives bufferedAmount.
    const txMs = Number.isFinite(cond.bandwidthBps) ? (copy.length * 1000) / cond.bandwidthBps : 0
    const txStart = Math.max(now, this.txFree)
    const txEnd = txStart + txMs
    this.txFree = txEnd
    this.bufferedAmount += copy.length
    this.conn.bytesSent += copy.length
    clock.setTimeout(() => {
      const before = this.bufferedAmount
      this.bufferedAmount -= copy.length
      if (
        before > this.bufferedAmountLowThreshold &&
        this.bufferedAmount <= this.bufferedAmountLowThreshold
      ) {
        this.lowL.emit()
      }
    }, txEnd - now)

    if (hub.blocked(this.conn.local, this.conn.remote)) return
    let delay =
      txEnd - now + cond.latencyMs + (cond.jitterMs > 0 ? hub.random() * cond.jitterMs : 0)
    const lost = cond.loss > 0 && hub.random() < cond.loss
    if (this.reliability.mode === 'unreliable') {
      if (lost) return
    } else if (lost) {
      // Model an SCTP retransmission: one extra round trip plus a timer slack.
      delay += 2 * cond.latencyMs + 20
    }
    let at = now + delay
    if (this.reliability.mode === 'reliable') {
      at = Math.max(at, this.lastDeliver)
      this.lastDeliver = at
    }
    clock.setTimeout(() => {
      const peer = this.peer
      if (!peer || peer.readyState !== 'open') return
      // Reliable data already in flight when a partition starts is lost with the connection.
      if (hub.blocked(this.conn.local, this.conn.remote)) return
      peer.conn.bytesReceived += copy.length
      peer.deliver(copy)
    }, at - now)
  }

  onOpen(cb: () => void): Unsubscribe {
    return this.openL.add(cb)
  }
  /** @internal Messages that arrive before anyone listens are held, like a socket buffer. */
  deliver(data: Uint8Array): void {
    if (this.msgL.size === 0) this.inbox.push(data)
    else this.msgL.emit(data)
  }

  onMessage(cb: (data: Uint8Array) => void): Unsubscribe {
    const u = this.msgL.add(cb)
    if (this.inbox.length) {
      const box = this.inbox
      this.inbox = []
      for (const m of box) this.msgL.emit(m)
    }
    return u
  }
  onBufferedAmountLow(cb: () => void): Unsubscribe {
    return this.lowL.add(cb)
  }
  onClose(cb: () => void): Unsubscribe {
    return this.closeL.add(cb)
  }

  close(): void {
    this.closeLocal()
    const peer = this.peer
    if (peer)
      this.conn.hub.clock.setTimeout(
        () => peer.closeLocal(),
        this.conn.hub.conditions(this.conn.local, this.conn.remote).latencyMs,
      )
  }

  /** @internal */
  closeLocal(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.queued = []
    this.closeL.emit()
  }
}

// ---------------------------------------------------------------- connection

export class MemoryConnection implements Connection {
  readonly id: string
  state: Connection['state'] = 'connecting'
  peer: MemoryConnection | null = null
  bytesSent = 0
  bytesReceived = 0
  private channels = new Map<string, MemoryChannel>()
  private chanL = new Listeners<[Channel]>()
  private stateL = new Listeners<[Connection['state']]>()
  private failTimer: unknown = null
  private pendingChannels: Channel[] = []

  constructor(
    readonly hub: MemoryHub,
    readonly local: Hex,
    readonly remote: Hex,
    readonly pathOverride: PathType | undefined,
    id: string,
  ) {
    this.id = id
  }

  get path(): PathType {
    return this.pathOverride ?? this.hub.conditions(this.local, this.remote).path
  }

  /** @internal */
  setState(s: Connection['state']): void {
    if (this.state === s || this.state === 'closed') return
    this.state = s
    if (s === 'closed' || s === 'disconnected') {
      this.hub.track(this, false)
      for (const ch of this.channels.values()) ch.closeLocal()
    }
    this.stateL.emit(s)
    if (s === 'disconnected') this.setState('closed')
  }

  openChannel(label: string, reliability: Reliability): Channel {
    if (this.state === 'closed' || !this.peer) throw new Error('connection closed')
    const local = new MemoryChannel(label, reliability, this)
    const remote = new MemoryChannel(label, reliability, this.peer)
    local.peer = remote
    remote.peer = local
    this.channels.set(label, local)
    const peer = this.peer
    const lat = this.hub.conditions(this.local, this.remote).latencyMs
    this.hub.clock.setTimeout(() => {
      if (peer.state !== 'connected' || this.hub.blocked(this.local, this.remote)) return
      peer.channels.set(label, remote)
      remote.open()
      peer.announceChannel(remote)
      this.hub.clock.setTimeout(() => {
        if (this.state === 'connected') local.open()
      }, lat)
    }, lat)
    return local
  }

  /** @internal */
  announceChannel(ch: Channel): void {
    if (this.chanL.size === 0) this.pendingChannels.push(ch)
    else this.chanL.emit(ch)
  }

  onChannel(cb: (channel: Channel) => void): Unsubscribe {
    const u = this.chanL.add(cb)
    const pending = this.pendingChannels
    this.pendingChannels = []
    for (const ch of pending) cb(ch)
    return u
  }

  onStateChange(cb: (state: Connection['state']) => void): Unsubscribe {
    return this.stateL.add(cb)
  }

  async stats(): Promise<ConnectionStats> {
    return {
      path: this.path,
      rttMs: 2 * this.hub.conditions(this.local, this.remote).latencyMs,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      localCandidateType: 'host',
      remoteCandidateType: 'host',
    }
  }

  close(): void {
    if (this.state === 'closed') return
    const peer = this.peer
    this.setState('closed')
    if (peer) {
      // Close the far side after everything already sent has landed (graceful, like an SCTP shutdown).
      const now = this.hub.clock.now()
      let at = now + this.hub.conditions(this.local, this.remote).latencyMs
      for (const ch of this.channels.values()) at = Math.max(at, ch.lastDeliver)
      this.hub.clock.setTimeout(() => peer.setState('closed'), at - now + 1)
    }
  }

  /** @internal Break the link after the hub's detection delay (both sides). */
  scheduleFailure(ms = this.hub.detectMs): void {
    if (this.failTimer !== null || this.state === 'closed') return
    this.failTimer = this.hub.clock.setTimeout(() => {
      this.failTimer = null
      this.setState('disconnected')
      this.peer?.setState('disconnected')
    }, ms)
  }

  /** @internal */
  cancelFailure(): void {
    if (this.failTimer === null) return
    this.hub.clock.clearTimeout(this.failTimer)
    this.failTimer = null
  }
}

export interface MemoryTransportOptions {
  /** Report this path type instead of the hub's link path (e.g. to fake a 'relay' rung). */
  path?: PathType
  name?: string
}

/** Transport over a MemoryHub. Offer/answer travel over the room's signal pipe like a real transport. */
export function memoryTransport(
  hub: MemoryHub,
  opts: MemoryTransportOptions = {},
): Transport & { hub: MemoryHub } {
  return {
    hub,
    name: opts.name ?? 'memory',
    connect(remote: Hex, o: TransportConnectOptions): Promise<Connection> {
      const local = o.local.pubkey
      return new Promise<Connection>((resolve, reject) => {
        let unsub: Unsubscribe = () => {}
        const done = (err: Error | null, c?: Connection) => {
          unsub()
          o.signal?.removeEventListener('abort', onAbort)
          if (err) reject(err)
          else resolve(c as Connection)
        }
        const onAbort = () => done(new Error('memory transport: aborted'))
        if (o.signal?.aborted) return onAbort()
        o.signal?.addEventListener('abort', onAbort)

        if (o.initiator) {
          const id = randomId(8)
          const conn = new MemoryConnection(hub, local, remote, opts.path, id)
          hub.register(id, local, remote, conn)
          unsub = o.pipe.onMessage((m) => {
            if (m.type === 'memory-answer' && (m as { id?: unknown }).id === id) {
              if (conn.state === 'connected') done(null, conn)
              else done(new Error('memory transport: link failed'))
            }
          })
          o.pipe.send({ type: 'memory-offer', id })
        } else {
          unsub = o.pipe.onMessage((m) => {
            const offerId = (m as { id?: unknown }).id
            if (m.type !== 'memory-offer' || typeof offerId !== 'string') return
            const p = hub.take(offerId)
            if (!p || p.from !== remote || p.to !== local) return
            if (hub.blocked(local, remote)) return // offer lost; initiator times out
            const mine = new MemoryConnection(hub, local, remote, opts.path, p.conn.id)
            mine.peer = p.conn
            p.conn.peer = mine
            mine.state = 'connected'
            p.conn.state = 'connected'
            hub.track(mine, true)
            hub.track(p.conn, true)
            o.pipe.send({ type: 'memory-answer', id: offerId })
            done(null, mine)
          })
        }
      })
    },
  }
}
