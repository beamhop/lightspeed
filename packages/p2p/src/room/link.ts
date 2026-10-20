// A Link is one transport Connection with the library's three channels and frame codec on top.
import type { Channel, Connection, PathType, Reliability } from '../types'
import { Listeners } from '../util/emitter'
import { type Frame, FrameType, decodeFrame, encodeFrame } from '../wire'

export type Lane = 'r' | 'u' | 'x'

export const CHANNELS: Record<Lane, { label: string; reliability: Reliability }> = {
  r: { label: 'bh/r', reliability: { mode: 'reliable' } },
  u: { label: 'bh/u', reliability: { mode: 'unordered' } },
  x: { label: 'bh/x', reliability: { mode: 'unreliable', maxRetransmits: 0 } },
}

const LANE_BY_LABEL = new Map<string, Lane>(Object.entries(CHANNELS).map(([k, v]) => [v.label, k as Lane]))

export const PATH_RANK: Record<PathType, number> = { direct: 3, memory: 3, turn: 2, relay: 1 }

let linkSeq = 0

export class Link {
  readonly id = ++linkSeq
  readonly channels: Partial<Record<Lane, Channel>> = {}
  dead = false
  /** Bytes sent/received per lane (telemetry). */
  bytes = { sent: 0, received: 0 }
  private frameL = new Listeners<[Frame, Lane]>()
  private deadL = new Listeners<[string]>()
  private openL = new Listeners<[]>()
  private held: [Frame, Lane][] = []
  private unsubs: (() => void)[] = []

  constructor(
    readonly conn: Connection,
    readonly transport: string,
    readonly initiator: boolean,
  ) {
    if (initiator) {
      for (const lane of ['r', 'u', 'x'] as Lane[]) {
        const spec = CHANNELS[lane]
        this.bind(lane, conn.openChannel(spec.label, spec.reliability))
      }
    } else {
      this.unsubs.push(
        conn.onChannel((ch) => {
          const lane = LANE_BY_LABEL.get(ch.label)
          if (lane && !this.channels[lane]) this.bind(lane, ch)
        }),
      )
    }
    this.unsubs.push(
      conn.onStateChange((s) => {
        if (s === 'disconnected' || s === 'closed') this.kill(`connection ${s}`)
      }),
    )
    if (conn.state === 'closed' || conn.state === 'disconnected') queueMicrotask(() => this.kill('connection closed'))
  }

  get path(): PathType {
    return this.conn.path
  }

  get rank(): number {
    return PATH_RANK[this.conn.path] ?? 0
  }

  get open(): boolean {
    return !this.dead && this.channels.r?.readyState === 'open'
  }

  private bind(lane: Lane, ch: Channel): void {
    this.channels[lane] = ch
    ch.bufferedAmountLowThreshold = LOW_WATER
    this.unsubs.push(
      ch.onMessage((data) => {
        if (this.dead) return
        this.bytes.received += data.length
        let f: Frame
        try {
          f = decodeFrame(data)
        } catch {
          return
        }
        if (this.frameL.size === 0) this.held.push([f, lane])
        else this.frameL.emit(f, lane)
      }),
      ch.onClose(() => {
        if (lane === 'r') this.kill('reliable channel closed')
      }),
    )
    if (lane === 'r') {
      if (ch.readyState === 'open') queueMicrotask(() => this.openL.emit())
      else this.unsubs.push(ch.onOpen(() => this.openL.emit()))
    }
  }

  onOpen(cb: () => void): () => void {
    if (this.open) queueMicrotask(cb)
    return this.openL.add(cb)
  }

  /** Frames that arrive before a handler is attached are held and replayed to the first handler. */
  onFrame(cb: (f: Frame, lane: Lane) => void): () => void {
    const u = this.frameL.add(cb)
    const held = this.held
    this.held = []
    for (const [f, lane] of held) cb(f, lane)
    return u
  }

  onDead(cb: (reason: string) => void): () => void {
    if (this.dead) queueMicrotask(() => cb('dead'))
    return this.deadL.add(cb)
  }

  channelFor(lane: Lane): Channel | undefined {
    const ch = this.channels[lane]
    if (ch && ch.readyState === 'open') return ch
    if (lane !== 'r') {
      // Fall back to the reliable channel (relay paths, or before the extra channels open).
      const r = this.channels.r
      return r && r.readyState === 'open' ? r : undefined
    }
    return undefined
  }

  buffered(lane: Lane): number {
    return this.channelFor(lane)?.bufferedAmount ?? 0
  }

  send(lane: Lane, type: FrameType, streamId: number, payload: Uint8Array): boolean {
    if (this.dead) return false
    const ch = this.channelFor(lane)
    if (!ch) return false
    const bytes = encodeFrame({ type, streamId, payload })
    try {
      ch.send(bytes)
    } catch {
      return false
    }
    this.bytes.sent += bytes.length
    return true
  }

  kill(reason: string): void {
    if (this.dead) return
    this.dead = true
    for (const u of this.unsubs) u()
    this.unsubs = []
    try {
      this.conn.close()
    } catch {}
    this.deadL.emit(reason)
  }
}

/** Backpressure thresholds per channel. */
export const HIGH_WATER = 256 * 1024
export const LOW_WATER = 64 * 1024
