// Identity-keyed peer session: sequence numbers + cumulative acks give at-least-once delivery across
// link drops and path migrations; a priority queue with bufferedAmountLow backpressure feeds the link;
// payloads larger than CHUNK_SIZE are split and reassembled.
import { decodeCbor, encodeCbor } from '../codec/cbor'
import type { Hex } from '../types'
import type { Clock } from '../util/clock'
import { Listeners } from '../util/emitter'
import { CHUNK_SIZE, type Frame, FrameType } from '../wire'
import { HIGH_WATER, type Lane, type Link } from './link'

/** 0 = control, 1 = high, 2 = normal, 3 = low (bulk/files). */
export type PriorityLevel = 0 | 1 | 2 | 3
/** 0 = ordered reliable lane, 1 = unordered reliable lane. */
export type SeqLane = 0 | 1

const LANE_CH: Record<SeqLane, Lane> = { 0: 'r', 1: 'u' }

interface OutUnit {
  lane: SeqLane
  streamId: number
  idx: number
  count: number
  bytes: Uint8Array
  seq: number
  msg: OutMessage
}

interface OutMessage {
  total: number
  sentBytes: number
  units: number
  acked: number
  streamId: number
  resolve(): void
  reject(e: Error): void
  onProgress?: (sent: number, total: number) => void
}

type QueuedUnit = Omit<OutUnit, 'seq'>
interface OutLane {
  next: number
  unacked: Map<number, OutUnit>
}
interface InLane {
  next: number
  buf: Map<number, [number, number, number, Uint8Array]>
  seen: Set<number>
}

interface Reassembly {
  parts: (Uint8Array | undefined)[]
  got: number
  bytes: number
}

const D_UNIT = 0
const D_UNRELIABLE = 1
const D_ACK = 2

export interface SessionEvents {
  message(bytes: Uint8Array, lane: SeqLane | 'x'): void
  progress(direction: 'in' | 'out', streamId: number, done: number, total: number): void
  rtt(ms: number): void
  linkLost(reason: string): void
  close(reason: string): void
}

export interface SessionOptions {
  clock: Clock
  pingIntervalMs: number
  ackDelayMs?: number
}

export class Session {
  link: Link | null = null
  state: 'connected' | 'away' = 'away'
  rttMs: number | undefined
  /** Remote room-instance id from its handshake; a different sid means the peer restarted. */
  readonly sid: string
  awaySince: number | null = null
  readonly events = {
    message: new Listeners<[Uint8Array, SeqLane | 'x']>(),
    progress: new Listeners<['in' | 'out', number, number, number]>(),
    rtt: new Listeners<[number]>(),
    linkLost: new Listeners<[string]>(),
    bye: new Listeners<[string]>(),
  }

  private out: [OutLane, OutLane] = [
    { next: 1, unacked: new Map() },
    { next: 1, unacked: new Map() },
  ]
  private inn: [InLane, InLane] = [
    { next: 1, buf: new Map(), seen: new Set() },
    { next: 1, buf: new Map(), seen: new Set() },
  ]
  private queue: [QueuedUnit[], QueuedUnit[], QueuedUnit[], QueuedUnit[]] = [[], [], [], []]
  private queuedBytes = 0
  private nextStream = 0
  private reasm = new Map<string, Reassembly>()
  private ackTimer: unknown = null
  private ackDirty: [boolean, boolean] = [false, false]
  private pingTimer: unknown = null
  private lastPong = 0
  private linkUnsubs: (() => void)[] = []
  private drainL = new Listeners<[]>()
  private closed = false

  constructor(
    readonly remote: Hex,
    sid: string,
    private opts: SessionOptions,
  ) {
    this.sid = sid
  }

  /** Receive cursors to advertise in a handshake so the remote can trim what we already have. */
  recvCursor(): [number, number] {
    return [this.inn[0].next, this.inn[1].next]
  }

  get pendingBytes(): number {
    return this.queuedBytes
  }

  get unackedCount(): number {
    return this.out[0].unacked.size + this.out[1].unacked.size
  }

  /** Attach a (new or better) link. `remoteRecv` trims units the remote already received. */
  attach(link: Link, remoteRecv?: [number, number], backlog: [Frame, Lane][] = []): void {
    const prev = this.link
    this.detachHandlers()
    this.link = link
    this.state = 'connected'
    this.awaySince = null
    this.lastPong = this.opts.clock.now()
    if (remoteRecv) {
      for (const lane of [0, 1] as SeqLane[]) this.ackUpTo(lane, (remoteRecv[lane] ?? 1) - 1)
    }
    for (const [f, lane] of backlog) this.onFrame(f, lane)
    this.linkUnsubs.push(
      link.onFrame((f, lane) => this.onFrame(f, lane)),
      link.onDead((reason) => this.onLinkDead(link, reason)),
    )
    for (const lane of ['r', 'u'] as Lane[]) {
      const ch = link.channels[lane]
      if (ch) this.linkUnsubs.push(ch.onBufferedAmountLow(() => this.pump()))
    }
    // Retransmit everything not yet acknowledged, in sequence order, then continue with the queue.
    for (const lane of [0, 1] as SeqLane[]) {
      const units = [...this.out[lane].unacked.values()].sort((a, b) => a.seq - b.seq)
      for (const u of units) this.sendUnit(u)
    }
    this.schedulePing()
    this.pump()
    if (prev && prev !== link) {
      // Give in-flight frames on the old path a moment, then close it.
      const old = prev
      this.opts.clock.setTimeout(() => old.kill('migrated'), 1000)
    }
  }

  private detachHandlers(): void {
    for (const u of this.linkUnsubs) u()
    this.linkUnsubs = []
  }

  private onLinkDead(link: Link, reason: string): void {
    if (this.link !== link) return
    this.detachHandlers()
    this.link = null
    this.state = 'away'
    this.awaySince = this.opts.clock.now()
    if (this.pingTimer !== null) this.opts.clock.clearTimeout(this.pingTimer)
    this.pingTimer = null
    this.events.linkLost.emit(reason)
  }

  /**
   * Queue a message. Resolves when every unit is acknowledged by the remote (at-least-once);
   * unreliable sends resolve immediately.
   */
  send(
    bytes: Uint8Array,
    o: {
      lane: SeqLane | 'x'
      priority: PriorityLevel
      onProgress?: (sent: number, total: number) => void
    },
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error('session closed'))
    if (o.lane === 'x') {
      if (bytes.length <= CHUNK_SIZE) {
        const link = this.link
        if (link && link.buffered('x') < HIGH_WATER) {
          link.send('x', FrameType.Data, 0, encodeCbor([D_UNRELIABLE, bytes]))
        }
        return Promise.resolve()
      }
      // Too large for one unreliable datagram: degrade to the unordered reliable lane.
      return this.send(bytes, { ...o, lane: 1 })
    }
    const lane = o.lane
    const count = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE))
    let streamId = 0
    if (count > 1) {
      this.nextStream = (this.nextStream % 0xffff) + 1
      streamId = this.nextStream
    }
    const p = new Promise<void>((resolve, reject) => {
      const msg: OutMessage = {
        total: bytes.length,
        sentBytes: 0,
        units: count,
        acked: 0,
        streamId,
        resolve,
        reject,
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      }
      for (let i = 0; i < count; i++) {
        const chunk = bytes.subarray(i * CHUNK_SIZE, Math.min(bytes.length, (i + 1) * CHUNK_SIZE))
        this.queue[o.priority]?.push({ lane, streamId, idx: i, count, bytes: chunk, msg })
        this.queuedBytes += chunk.length
      }
      this.pump()
    })
    p.catch(() => {})
    return p
  }

  /** Resolves once queued (not yet handed to the transport) bytes drop to `limit` or below. */
  waitDrain(limit = HIGH_WATER): Promise<void> {
    if (this.queuedBytes <= limit || this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      const u = this.drainL.add(() => {
        if (this.queuedBytes <= limit || this.closed) {
          u()
          resolve()
        }
      })
    })
  }

  private pump(): void {
    const link = this.link
    if (!link || !link.open) return
    for (;;) {
      const bucket = this.queue.find((q) => q.length > 0)
      if (!bucket) break
      const head = bucket[0] as Omit<OutUnit, 'seq'>
      const lane = LANE_CH[head.lane]
      if (link.buffered(lane) > HIGH_WATER) {
        break
      }
      bucket.shift()
      this.queuedBytes -= head.bytes.length
      const unit: OutUnit = { ...head, seq: this.out[head.lane].next++ }
      this.out[head.lane].unacked.set(unit.seq, unit)
      if (!this.sendUnit(unit)) break
      const m = unit.msg
      m.sentBytes += unit.bytes.length
      if (m.units > 1) {
        m.onProgress?.(m.sentBytes, m.total)
        this.events.progress.emit('out', m.streamId, m.sentBytes, m.total)
      }
    }
    this.drainL.emit()
  }

  private sendUnit(u: OutUnit): boolean {
    const link = this.link
    if (!link) return false
    return link.send(
      LANE_CH[u.lane],
      FrameType.Data,
      u.streamId,
      encodeCbor([D_UNIT, u.lane, u.seq, u.idx, u.count, u.bytes]),
    )
  }

  private ackUpTo(lane: SeqLane, cum: number): void {
    const un = this.out[lane].unacked
    for (const [seq, u] of un) {
      if (seq > cum) continue
      un.delete(seq)
      const m = u.msg
      m.acked++
      if (m.acked === m.units) {
        if (m.units === 1) m.onProgress?.(m.total, m.total)
        m.resolve()
      }
    }
  }

  private onFrame(f: Frame, _lane: Lane): void {
    if (f.type === FrameType.Ping) {
      const [kind, t] = decodeCbor(f.payload) as [number, number]
      const link = this.link
      if (kind === 0) link?.send('r', FrameType.Ping, 0, encodeCbor([1, t]))
      else {
        this.lastPong = this.opts.clock.now()
        this.rttMs = this.opts.clock.now() - t
        this.events.rtt.emit(this.rttMs)
      }
      return
    }
    if (f.type === FrameType.Close) {
      let reason = 'leave'
      try {
        reason = String((decodeCbor(f.payload) as unknown[])[0] ?? reason)
      } catch {}
      this.events.bye.emit(reason)
      return
    }
    if (f.type !== FrameType.Data) return
    let d: unknown[]
    try {
      d = decodeCbor(f.payload) as unknown[]
    } catch {
      return
    }
    if (!Array.isArray(d)) return
    if (d[0] === D_ACK) {
      this.ackUpTo(d[1] as SeqLane, d[2] as number)
      return
    }
    if (d[0] === D_UNRELIABLE) {
      this.events.message.emit(d[1] as Uint8Array, 'x')
      return
    }
    if (d[0] !== D_UNIT) return
    const [, lane, seq, idx, count, bytes] = d as [
      number,
      SeqLane,
      number,
      number,
      number,
      Uint8Array,
    ]
    if (lane !== 0 && lane !== 1) return
    const st = this.inn[lane]
    this.ackDirty[lane] = true
    this.scheduleAck()
    if (seq < st.next || st.buf.has(seq) || st.seen.has(seq)) return // duplicate after a resend
    if (lane === 0) {
      if (seq !== st.next) {
        st.buf.set(seq, [f.streamId, idx, count, bytes])
        return
      }
      this.deliverUnit(lane, f.streamId, idx, count, bytes)
      st.next++
      for (;;) {
        const nxt = st.buf.get(st.next)
        if (!nxt) break
        st.buf.delete(st.next)
        this.deliverUnit(lane, ...nxt)
        st.next++
      }
    } else {
      st.seen.add(seq)
      while (st.seen.has(st.next)) {
        st.seen.delete(st.next)
        st.next++
      }
      this.deliverUnit(lane, f.streamId, idx, count, bytes)
    }
  }

  private deliverUnit(
    lane: SeqLane,
    streamId: number,
    idx: number,
    count: number,
    bytes: Uint8Array,
  ): void {
    if (count <= 1) {
      this.events.message.emit(bytes, lane)
      return
    }
    const key = `${lane}:${streamId}`
    let r = this.reasm.get(key)
    if (!r) {
      r = { parts: new Array(count), got: 0, bytes: 0 }
      this.reasm.set(key, r)
    }
    if (r.parts[idx]) return
    r.parts[idx] = bytes
    r.got++
    r.bytes += bytes.length
    // Total is only known at the end for the last chunk; estimate with full chunks.
    const estTotal = (count - 1) * CHUNK_SIZE + (r.parts[count - 1]?.length ?? CHUNK_SIZE)
    this.events.progress.emit('in', streamId, r.bytes, estTotal)
    if (r.got < count) return
    this.reasm.delete(key)
    const out = new Uint8Array(r.bytes)
    let o = 0
    for (const p of r.parts) {
      out.set(p as Uint8Array, o)
      o += (p as Uint8Array).length
    }
    this.events.message.emit(out, lane)
  }

  private scheduleAck(): void {
    if (this.ackTimer !== null) return
    this.ackTimer = this.opts.clock.setTimeout(() => {
      this.ackTimer = null
      const link = this.link
      if (!link) return
      for (const lane of [0, 1] as SeqLane[]) {
        if (!this.ackDirty[lane]) continue
        this.ackDirty[lane] = false
        link.send('r', FrameType.Data, 0, encodeCbor([D_ACK, lane, this.inn[lane].next - 1]))
      }
    }, this.opts.ackDelayMs ?? 5)
  }

  private schedulePing(): void {
    if (this.pingTimer !== null) this.opts.clock.clearTimeout(this.pingTimer)
    this.pingTimer = null
    const tick = () => {
      this.pingTimer = null
      const link = this.link
      if (!link || this.closed) return
      const now = this.opts.clock.now()
      if (now - this.lastPong > this.opts.pingIntervalMs * 3) {
        link.kill('ping timeout')
        return
      }
      link.send('r', FrameType.Ping, 0, encodeCbor([0, now]))
      this.pingTimer = this.opts.clock.setTimeout(tick, this.opts.pingIntervalMs)
    }
    this.pingTimer = this.opts.clock.setTimeout(tick, Math.min(250, this.opts.pingIntervalMs))
  }

  sendBye(reason = 'leave'): void {
    this.link?.send('r', FrameType.Close, 0, encodeCbor([reason]))
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    this.detachHandlers()
    if (this.pingTimer !== null) this.opts.clock.clearTimeout(this.pingTimer)
    if (this.ackTimer !== null) this.opts.clock.clearTimeout(this.ackTimer)
    const link = this.link
    this.link = null
    link?.kill(reason)
    const err = new Error(`session closed: ${reason}`)
    for (const lane of [0, 1] as SeqLane[]) {
      for (const u of this.out[lane].unacked.values()) u.msg.reject(err)
      this.out[lane].unacked.clear()
    }
    for (const q of this.queue) {
      for (const u of q) u.msg.reject(err)
      q.length = 0
    }
    this.queuedBytes = 0
    this.drainL.emit()
  }
}
