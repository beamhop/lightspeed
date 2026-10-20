// Deterministic room simulator. Given a seed and the same sequence of calls it produces exactly
// the same telemetry, which makes Studio usable without a real room and its reducers testable.
import type { TelemetryEvent } from '@beamhop/p2p'
import { linkKey } from '../model/events'
import type {
  ActiveFault,
  CandidatePairInfo,
  ChannelInfo,
  ConnectionInfo,
  Fault,
  Hex,
  PathType,
  StudioEvent,
  StudioPeer,
} from '../room-adapter'
import { createRng, type Rng } from './rng'

export interface SimOptions {
  seed?: number
  /** Peers present at the start. Default 5. */
  peers?: number
  /** Epoch ms of simulated t=0. Default 1_700_000_000_000 (fixed, for determinism). */
  start?: number
  topology?: 'mesh' | 'star'
  /** Average messages per peer per second. Default 1.5. */
  messageRate?: number
  /** Connect through the relay first and migrate to direct/TURN (library relayFirst). */
  relayFirst?: boolean
  /** Probability multiplier for spontaneous path changes and resumes. Default 1. */
  chaos?: number
}

interface SimPeer {
  id: Hex
  name: string
  present: boolean
  index: number
  ip: number
}

type PairState = 'connecting' | 'connected' | 'away' | 'disconnected' | 'closed'

interface SimPair {
  key: string
  a: Hex
  b: Hex
  state: PairState
  path: PathType
  baseRtt: number
  candidatePair: string
  /** cumulative bytes per side per channel */
  bytes: Record<Hex, Record<string, { sent: number; received: number }>>
  /** bytes queued by in-flight file transfers, per sender */
  buffered: Record<Hex, number>
  /** bumps on each (re)connect so stale scheduled callbacks are ignored */
  epoch: number
}

interface Task {
  at: number
  order: number
  run: () => void
}

const ANIMALS = [
  'otter',
  'lynx',
  'heron',
  'fox',
  'ibis',
  'marten',
  'wren',
  'puffin',
  'gecko',
  'koi',
  'badger',
  'kestrel',
  'newt',
  'stoat',
  'quokka',
  'tapir',
  'yak',
  'zebu',
  'civet',
  'dingo',
]
const CHAT = [
  'hey all',
  'is the relay up?',
  'joining from my phone',
  'can you see my cursor?',
  'brb',
  'switching to wifi',
  'nice, direct path now',
  'file incoming',
  'lgtm',
  'ping',
]
const EMOJI = ['🎉', '👍', '🐇', '🔥', '👀', '✨']
const STATUS = ['active', 'idle', 'typing', 'away']

export const DEFAULT_START = 1_700_000_000_000

export class SimEngine {
  readonly rng: Rng
  readonly options: Required<SimOptions>
  now: number
  private seq = 0
  private order = 0
  private queue: Task[] = []
  private peersById = new Map<Hex, SimPeer>()
  private pairs = new Map<string, SimPair>()
  private faultList: ActiveFault[] = []
  private faultSeq = 0
  private streamSeq = 0
  private listeners = new Set<(e: StudioEvent) => void>()
  private log: StudioEvent[] = []
  private hostId: Hex | null = null

  constructor(opts: SimOptions = {}) {
    this.options = {
      seed: opts.seed ?? 1,
      peers: opts.peers ?? 5,
      start: opts.start ?? DEFAULT_START,
      topology: opts.topology ?? 'mesh',
      messageRate: opts.messageRate ?? 1.5,
      relayFirst: opts.relayFirst ?? false,
      chaos: opts.chaos ?? 1,
    }
    this.rng = createRng(this.options.seed)
    this.now = this.options.start
    for (let i = 0; i < this.options.peers; i++) {
      const p = this.createPeer()
      this.schedule(this.now + i * this.rng.int(150, 600), () => this.join(p.id))
    }
    this.every(1000, () => this.sampleRtt())
    this.every(2000, () => this.sampleBytes())
    this.every(200, () => this.chatter())
    this.every(1000, () => this.disturb())
  }

  // ------------------------------------------------------------------ public api

  /** Advance simulated time by `ms`, running everything scheduled up to then. */
  step(ms: number): StudioEvent[] {
    const target = this.now + ms
    const startLen = this.log.length
    while (this.queue.length && (this.queue[0] as Task).at <= target) {
      const task = this.queue.shift() as Task
      this.now = task.at
      task.run()
    }
    this.now = target
    return this.log.slice(startLen)
  }

  events(): readonly StudioEvent[] {
    return this.log
  }

  subscribe(cb: (e: StudioEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  peers(): StudioPeer[] {
    return [...this.peersById.values()]
      .filter((p) => p.present)
      .map((p) => ({
        pubkey: p.id,
        name: p.name,
        isHost: this.options.topology === 'star' && p.id === this.hostId,
        attestations: ['anonymous'],
        meta: { name: p.name, sim: true },
      }))
  }

  host(): Hex | null {
    return this.options.topology === 'star' ? this.hostId : null
  }

  /** Spawn a new simulated peer that joins now. */
  addPeer(): Hex {
    const p = this.createPeer()
    this.join(p.id)
    return p.id
  }

  faults(): readonly ActiveFault[] {
    return this.faultList
  }

  injectFault(fault: Fault): ActiveFault {
    const active: ActiveFault = { id: `f${++this.faultSeq}`, fault, since: this.now }
    this.faultList = [...this.faultList, active]
    if (fault.type === 'partition') this.applyPartition()
    if (fault.type === 'kill') this.leave(fault.peer)
    return active
  }

  clearFault(id: string): void {
    const f = this.faultList.find((x) => x.id === id)
    if (!f) return
    this.faultList = this.faultList.filter((x) => x.id !== id)
    if (f.fault.type === 'partition') this.healPartition()
    if (f.fault.type === 'kill') this.join(f.fault.peer)
  }

  connectionInfo(source: Hex, peer: Hex): ConnectionInfo | null {
    const pair = this.pairs.get(linkKey(source, peer))
    if (!pair) return null
    const open = pair.state === 'connected'
    const readyState: ChannelInfo['readyState'] =
      pair.state === 'closed' || pair.state === 'disconnected'
        ? 'closed'
        : open
          ? 'open'
          : 'connecting'
    const buffered = pair.buffered[source] ?? 0
    const channels: ChannelInfo[] = [
      {
        label: 'reliable',
        reliability: 'reliable',
        readyState,
        bufferedAmount: buffered,
        bufferedAmountLowThreshold: 65536,
      },
      {
        label: 'unreliable',
        reliability: 'unreliable',
        readyState,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 16384,
      },
      {
        label: '__beamhop/telemetry',
        reliability: 'unordered',
        readyState,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 16384,
      },
    ]
    const [local, remote] = pair.candidatePair.split(' ↔ ')
    const nominated: CandidatePairInfo = {
      local: local ?? '',
      remote: remote ?? '',
      path: pair.path,
      state: open ? 'succeeded' : 'in-progress',
      nominated: true,
      rttMs: pair.baseRtt,
    }
    const pa = this.peersById.get(source)
    const pb = this.peersById.get(peer)
    const candidates: CandidatePairInfo[] = [
      {
        local: `host 192.168.1.${pa?.ip ?? 2}:5${(pa?.index ?? 0) + 1000}`,
        remote: `host 10.0.0.${pb?.ip ?? 3}:5${(pb?.index ?? 0) + 1000}`,
        path: 'direct',
        state: pair.path === 'direct' ? 'succeeded' : 'failed',
        nominated: false,
      },
      {
        local: `relay 203.0.113.7:4${(pa?.index ?? 0) + 9000}`,
        remote: `srflx 198.51.100.${pb?.ip ?? 9}:6${(pb?.index ?? 0) + 2000}`,
        path: 'turn',
        state: pair.path === 'turn' ? 'succeeded' : 'frozen',
        nominated: false,
      },
    ]
    const alternates = candidates.filter((c) => c.path !== pair.path)
    return {
      state: this.pairToConnState(pair.state),
      path: pair.path,
      channels,
      candidatePairs: [nominated, ...alternates],
    }
  }

  // ------------------------------------------------------------------ scheduling

  private schedule(at: number, run: () => void): void {
    const task: Task = { at, order: this.order++, run }
    // binary insertion keeps (at, order) ordering stable and deterministic
    let lo = 0
    let hi = this.queue.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const m = this.queue[mid] as Task
      if (m.at < at || (m.at === at && m.order < task.order)) lo = mid + 1
      else hi = mid
    }
    this.queue.splice(lo, 0, task)
  }

  private after(ms: number, run: () => void): void {
    this.schedule(this.now + Math.max(0, Math.round(ms)), run)
  }

  private every(ms: number, run: () => void): void {
    const tick = () => {
      run()
      this.after(ms, tick)
    }
    this.after(ms, tick)
  }

  private emit(source: Hex, event: TelemetryEvent): void {
    const se: StudioEvent = { seq: ++this.seq, source, event }
    this.log.push(se)
    for (const l of this.listeners) l(se)
  }

  // ------------------------------------------------------------------ peers & pairs

  private createPeer(): SimPeer {
    const index = this.peersById.size
    const id = this.rng.hex(32)
    const animal = ANIMALS[index % ANIMALS.length] as string
    const p: SimPeer = {
      id,
      name: `${animal}-${index + 1}`,
      present: false,
      index,
      ip: this.rng.int(2, 250),
    }
    this.peersById.set(id, p)
    return p
  }

  private present(): SimPeer[] {
    return [...this.peersById.values()].filter((p) => p.present)
  }

  private electHost(): void {
    const ids = this.present()
      .map((p) => p.id)
      .sort()
    this.hostId = ids[0] ?? null
  }

  /** Peers `id` should hold a connection with under the current topology. */
  private shouldConnect(a: Hex, b: Hex): boolean {
    if (a === b) return false
    if (this.options.topology === 'mesh') return true
    return a === this.hostId || b === this.hostId
  }

  private join(id: Hex): void {
    const p = this.peersById.get(id)
    if (!p || p.present) return
    p.present = true
    // star: the first peer (later: lowest pubkey on handoff) hosts; joins never steal the role
    if (this.options.topology === 'star' && !this.hostId) this.hostId = id
    this.emit(id, { type: 'signal', at: this.now, direction: 'out', kind: 'announce' })
    for (const q of this.present()) {
      if (q.id === id) continue
      const d = this.rng.int(15, 70)
      this.after(d, () =>
        this.emit(q.id, {
          type: 'signal',
          at: this.now,
          direction: 'in',
          kind: 'announce',
          peer: id,
        }),
      )
      if (this.shouldConnect(id, q.id)) this.after(d + 10, () => this.connect(id, q.id))
    }
  }

  private leave(id: Hex): void {
    const p = this.peersById.get(id)
    if (!p?.present) return
    p.present = false
    for (const pair of this.pairs.values()) {
      if (pair.a !== id && pair.b !== id) continue
      if (pair.state === 'closed') continue
      pair.state = 'closed'
      pair.epoch++
      pair.buffered = {}
      const other = pair.a === id ? pair.b : pair.a
      const d = this.rng.int(200, 1200)
      this.after(d, () => {
        this.emit(other, { type: 'connection', at: this.now, peer: id, state: 'closed' })
        this.emit(other, { type: 'peer', at: this.now, peer: id, event: 'leave' })
      })
    }
    if (this.options.topology === 'star' && id === this.hostId) {
      this.electHost()
      const host = this.hostId
      if (host) {
        for (const q of this.present()) {
          if (q.id !== host && !this.isConnected(host, q.id))
            this.after(this.rng.int(800, 1600), () => this.connect(host, q.id))
        }
      }
    }
  }

  private isConnected(a: Hex, b: Hex): boolean {
    const s = this.pairs.get(linkKey(a, b))?.state
    return s === 'connected' || s === 'connecting' || s === 'away'
  }

  private partitioned(a: Hex, b: Hex): boolean {
    for (const f of this.faultList) {
      if (f.fault.type !== 'partition') continue
      const ga = f.fault.groups.findIndex((g) => g.includes(a))
      const gb = f.fault.groups.findIndex((g) => g.includes(b))
      if (ga !== -1 && gb !== -1 && ga !== gb) return true
    }
    return false
  }

  private extraLatency(a: Hex, b: Hex): number {
    let ms = 0
    for (const f of this.faultList) {
      if (f.fault.type !== 'latency') continue
      if (!f.fault.peer || f.fault.peer === a || f.fault.peer === b) ms += f.fault.ms
    }
    return ms
  }

  private lossRate(a: Hex, b: Hex): number {
    let keep = 1
    for (const f of this.faultList) {
      if (f.fault.type !== 'loss') continue
      if (!f.fault.peer || f.fault.peer === a || f.fault.peer === b)
        keep *= 1 - Math.min(1, Math.max(0, f.fault.rate))
    }
    return 1 - keep
  }

  private choosePath(): PathType {
    return this.rng.weighted<PathType>([
      ['direct', 70],
      ['turn', 20],
      ['relay', 10],
    ])
  }

  private candidateFor(path: PathType, a: SimPeer, b: SimPeer): string {
    const port = () => this.rng.int(40000, 65000)
    switch (path) {
      case 'direct':
        return this.rng.chance(0.5)
          ? `host/udp 192.168.1.${a.ip}:${port()} ↔ host/udp 192.168.1.${b.ip}:${port()}`
          : `srflx/udp 198.51.100.${a.ip}:${port()} ↔ srflx/udp 203.0.113.${b.ip}:${port()}`
      case 'turn':
        return `relay/udp 203.0.113.7:${port()} ↔ srflx/udp 198.51.100.${b.ip}:${port()}`
      case 'relay':
        return 'wss relay.beamhop.local/a/demo/data ↔ wss relay.beamhop.local/a/demo/data'
      default:
        return 'memory ↔ memory'
    }
  }

  private pairFor(a: Hex, b: Hex): SimPair {
    const key = linkKey(a, b)
    let pair = this.pairs.get(key)
    if (!pair) {
      const [x, y] = a < b ? [a, b] : [b, a]
      pair = {
        key,
        a: x,
        b: y,
        state: 'connecting',
        path: 'direct',
        baseRtt: this.rng.int(12, 140),
        candidatePair: '',
        bytes: { [x]: {}, [y]: {} },
        buffered: {},
        epoch: 0,
      }
      this.pairs.set(key, pair)
    }
    return pair
  }

  /** Full signaling + ICE handshake between two present peers. */
  private connect(a: Hex, b: Hex): void {
    const pa = this.peersById.get(a)
    const pb = this.peersById.get(b)
    if (!pa?.present || !pb?.present) return
    const pair = this.pairFor(a, b)
    if (pair.state === 'connected' || pair.state === 'away') return
    pair.state = 'connecting'
    const epoch = ++pair.epoch
    const [init, resp] = a < b ? [a, b] : [b, a]
    const d = () => this.rng.int(15, 60)
    this.emit(init, { type: 'connection', at: this.now, peer: resp, state: 'connecting' })
    this.emit(init, { type: 'signal', at: this.now, direction: 'out', kind: 'offer', peer: resp })
    let t = d()
    this.after(t, () => {
      this.emit(resp, { type: 'signal', at: this.now, direction: 'in', kind: 'offer', peer: init })
      this.emit(resp, { type: 'connection', at: this.now, peer: init, state: 'connecting' })
      this.emit(resp, {
        type: 'signal',
        at: this.now,
        direction: 'out',
        kind: 'answer',
        peer: init,
      })
    })
    t += d()
    this.after(t, () =>
      this.emit(init, {
        type: 'signal',
        at: this.now,
        direction: 'in',
        kind: 'answer',
        peer: resp,
      }),
    )
    const candidates = this.rng.int(2, 4)
    for (let i = 0; i < candidates; i++) {
      const ct = t + i * this.rng.int(5, 30)
      this.after(ct, () => {
        this.emit(init, {
          type: 'signal',
          at: this.now,
          direction: 'out',
          kind: 'candidate',
          peer: resp,
        })
        this.emit(resp, {
          type: 'signal',
          at: this.now,
          direction: 'out',
          kind: 'candidate',
          peer: init,
        })
      })
      this.after(ct + d(), () => {
        this.emit(resp, {
          type: 'signal',
          at: this.now,
          direction: 'in',
          kind: 'candidate',
          peer: init,
        })
        this.emit(init, {
          type: 'signal',
          at: this.now,
          direction: 'in',
          kind: 'candidate',
          peer: resp,
        })
      })
    }
    const finalPath = this.choosePath()
    const firstPath: PathType = this.options.relayFirst ? 'relay' : finalPath
    this.after(t + this.rng.int(250, 900), () => {
      if (pair.epoch !== epoch || pair.state !== 'connecting') return
      if (this.partitioned(a, b)) {
        pair.state = 'disconnected'
        this.emit(init, { type: 'connection', at: this.now, peer: resp, state: 'disconnected' })
        this.emit(resp, { type: 'connection', at: this.now, peer: init, state: 'disconnected' })
        return
      }
      pair.state = 'connected'
      pair.path = firstPath
      pair.candidatePair = this.candidateFor(firstPath, pa, pb)
      for (const [s, r] of [
        [init, resp],
        [resp, init],
      ] as const) {
        this.emit(s, {
          type: 'connection',
          at: this.now,
          peer: r,
          state: 'connected',
          path: firstPath,
        })
        this.emit(s, {
          type: 'path',
          at: this.now,
          peer: r,
          path: firstPath,
          candidatePair: pair.candidatePair,
        })
        this.emit(s, { type: 'peer', at: this.now, peer: r, event: 'join' })
      }
      if (firstPath !== finalPath) {
        this.after(this.rng.int(800, 2500), () => {
          if (pair.epoch === epoch && pair.state === 'connected') this.changePath(pair, finalPath)
        })
      }
    })
  }

  private changePath(pair: SimPair, path: PathType): void {
    const pa = this.peersById.get(pair.a)
    const pb = this.peersById.get(pair.b)
    if (!pa || !pb) return
    pair.path = path
    pair.candidatePair = this.candidateFor(path, pa, pb)
    if (path === 'turn') pair.baseRtt = Math.round(pair.baseRtt * 1.4 + 10)
    if (path === 'direct') pair.baseRtt = Math.max(8, Math.round(pair.baseRtt / 1.3))
    for (const [s, r] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      this.emit(s, { type: 'path', at: this.now, peer: r, path, candidatePair: pair.candidatePair })
    }
  }

  private pairToConnState(s: PairState): ConnectionInfo['state'] {
    return s === 'away' ? 'disconnected' : s
  }

  // ------------------------------------------------------------------ faults

  private applyPartition(): void {
    for (const pair of this.pairs.values()) {
      if (pair.state !== 'connected' && pair.state !== 'connecting') continue
      if (!this.partitioned(pair.a, pair.b)) continue
      pair.state = 'away'
      const epoch = pair.epoch
      for (const [s, r] of [
        [pair.a, pair.b],
        [pair.b, pair.a],
      ] as const) {
        this.emit(s, { type: 'connection', at: this.now, peer: r, state: 'away' })
      }
      // still cut off after the resume window: give up on the session
      this.after(3000, () => {
        if (pair.epoch !== epoch || pair.state !== 'away' || !this.partitioned(pair.a, pair.b))
          return
        pair.state = 'disconnected'
        for (const [s, r] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const) {
          this.emit(s, { type: 'connection', at: this.now, peer: r, state: 'disconnected' })
        }
      })
    }
  }

  private healPartition(): void {
    for (const pair of this.pairs.values()) {
      if (this.partitioned(pair.a, pair.b)) continue
      if (pair.state === 'away') {
        pair.state = 'connected'
        for (const [s, r] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const) {
          this.emit(s, {
            type: 'connection',
            at: this.now,
            peer: r,
            state: 'back',
            path: pair.path,
          })
        }
      } else if (pair.state === 'disconnected') {
        const { a, b } = pair
        this.emit(a, { type: 'signal', at: this.now, direction: 'out', kind: 'restart', peer: b })
        this.after(this.rng.int(20, 80), () => this.connect(a, b))
      }
    }
  }

  // ------------------------------------------------------------------ periodic activity

  private connectedPairs(): SimPair[] {
    return [...this.pairs.values()].filter((p) => p.state === 'connected')
  }

  private sampleRtt(): void {
    for (const pair of this.connectedPairs()) {
      const extra = this.extraLatency(pair.a, pair.b)
      const loss = this.lossRate(pair.a, pair.b)
      for (const [s, r] of [
        [pair.a, pair.b],
        [pair.b, pair.a],
      ] as const) {
        let ms = pair.baseRtt + extra + this.rng.range(0, pair.baseRtt * 0.3)
        if (loss > 0 && this.rng.chance(loss)) ms += this.rng.int(200, 900) // retransmit spike
        this.emit(s, { type: 'rtt', at: this.now, peer: r, ms: Math.round(ms) })
      }
    }
  }

  private addBytes(
    pair: SimPair,
    from: Hex,
    channel: string,
    size: number,
    delivered: boolean,
  ): void {
    const to = from === pair.a ? pair.b : pair.a
    const s = pair.bytes[from] ?? {}
    pair.bytes[from] = s
    const sc = s[channel] ?? { sent: 0, received: 0 }
    s[channel] = { sent: sc.sent + size, received: sc.received }
    if (!delivered) return
    const r = pair.bytes[to] ?? {}
    pair.bytes[to] = r
    const rc = r[channel] ?? { sent: 0, received: 0 }
    r[channel] = { sent: rc.sent, received: rc.received + size }
  }

  private sampleBytes(): void {
    for (const pair of this.connectedPairs()) {
      // keepalive pings
      this.addBytes(pair, pair.a, 'reliable', 48, true)
      this.addBytes(pair, pair.b, 'reliable', 48, true)
      for (const side of [pair.a, pair.b]) {
        const other = side === pair.a ? pair.b : pair.a
        for (const [channel, c] of Object.entries(pair.bytes[side] ?? {})) {
          this.emit(side, {
            type: 'bytes',
            at: this.now,
            peer: other,
            channel,
            sent: c.sent,
            received: c.received,
          })
        }
      }
    }
  }

  private send(
    from: Hex,
    to: Hex,
    action: string,
    payload: unknown,
    size: number,
    channel: string,
  ): void {
    const pair = this.pairs.get(linkKey(from, to))
    if (pair?.state !== 'connected') return
    this.emit(from, {
      type: 'message',
      at: this.now,
      peer: to,
      direction: 'out',
      action,
      size,
      payload,
    })
    const dropped = channel === 'unreliable' && this.rng.chance(this.lossRate(from, to))
    // reliable channels retransmit: loss shows up as delay instead of drops
    const retransmit = channel !== 'unreliable' && this.rng.chance(this.lossRate(from, to))
    this.addBytes(pair, from, channel, size, !dropped)
    if (dropped) return
    const oneWay =
      (pair.baseRtt + this.extraLatency(from, to)) / 2 + (retransmit ? pair.baseRtt * 2 : 0)
    const epoch = pair.epoch
    this.after(oneWay + this.rng.range(0, 8), () => {
      if (pair.epoch !== epoch || pair.state !== 'connected') return
      this.emit(to, {
        type: 'message',
        at: this.now,
        peer: from,
        direction: 'in',
        action,
        size,
        payload,
      })
    })
  }

  private neighbours(id: Hex): Hex[] {
    const out: Hex[] = []
    for (const pair of this.pairs.values()) {
      if (pair.state !== 'connected') continue
      if (pair.a === id) out.push(pair.b)
      else if (pair.b === id) out.push(pair.a)
    }
    return out
  }

  private chatter(): void {
    const p = this.options.messageRate * 0.2
    for (const peer of this.present()) {
      if (!this.rng.chance(p)) continue
      const targets = this.neighbours(peer.id)
      if (targets.length === 0) continue
      const action = this.rng.weighted([
        ['cursor', 45],
        ['chat', 14],
        ['presence', 10],
        ['react', 10],
        ['state/map', 15],
        ['file', 3],
      ] as const)
      switch (action) {
        case 'cursor': {
          const payload = { x: this.rng.int(0, 1280), y: this.rng.int(0, 800) }
          for (const t of targets) this.send(peer.id, t, 'cursor', payload, 24, 'unreliable')
          break
        }
        case 'chat': {
          const payload = { text: this.rng.pick(CHAT), from: peer.name, ts: this.now }
          for (const t of targets)
            this.send(peer.id, t, 'chat', payload, 40 + payload.text.length, 'reliable')
          break
        }
        case 'presence': {
          const payload = { status: this.rng.pick(STATUS), name: peer.name }
          for (const t of targets) this.send(peer.id, t, 'presence', payload, 36, 'reliable')
          break
        }
        case 'react': {
          const payload = { emoji: this.rng.pick(EMOJI), target: this.rng.int(1, 40) }
          for (const t of targets) this.send(peer.id, t, 'react', payload, 30, 'reliable')
          break
        }
        case 'state/map': {
          const payload = {
            map: 'board',
            key: `card-${this.rng.int(1, 12)}`,
            value: { col: this.rng.pick(['todo', 'doing', 'done']) },
            hlc: `${this.now}:${this.rng.int(0, 9)}:${peer.id.slice(0, 8)}`,
          }
          for (const t of targets) this.send(peer.id, t, 'state/map', payload, 96, 'reliable')
          break
        }
        case 'file':
          this.sendFile(peer, this.rng.pick(targets))
          break
      }
    }
  }

  private sendFile(from: SimPeer, to: Hex): void {
    const pair = this.pairs.get(linkKey(from.id, to))
    if (!pair) return
    const total = this.rng.int(4, 120) * 16 * 1024
    const streamId = ++this.streamSeq
    const name = this.rng.pick(['notes.md', 'photo.jpg', 'build.zip', 'trace.json', 'clip.webm'])
    this.send(from.id, to, 'file', { name, size: total, streamId }, 64, 'reliable')
    const epoch = pair.epoch
    const rate = pair.path === 'direct' ? 2_000_000 : pair.path === 'turn' ? 900_000 : 400_000 // bytes/s
    let sent = 0
    const tick = () => {
      if (pair.epoch !== epoch || pair.state !== 'connected') {
        pair.buffered[from.id] = 0
        return
      }
      sent = Math.min(total, sent + Math.round((rate / 4) * this.rng.range(0.6, 1.2)))
      pair.buffered[from.id] = Math.min(total - sent, 256 * 1024)
      this.addBytes(pair, from.id, 'reliable', 0, true)
      this.emit(from.id, { type: 'progress', at: this.now, peer: to, streamId, sent, total })
      this.after(pair.baseRtt / 2, () =>
        this.emit(to, { type: 'progress', at: this.now, peer: from.id, streamId, sent, total }),
      )
      if (sent < total) this.after(250, tick)
      else {
        pair.buffered[from.id] = 0
        this.addBytes(pair, from.id, 'reliable', total, true)
      }
    }
    this.after(100, tick)
  }

  private disturb(): void {
    const chaos = this.options.chaos
    for (const pair of this.connectedPairs()) {
      if (this.rng.chance(0.006 * chaos)) {
        // network change → ICE restart onto another path
        const next: PathType = pair.path === 'direct' ? 'turn' : 'direct'
        this.emit(pair.a, {
          type: 'signal',
          at: this.now,
          direction: 'out',
          kind: 'restart',
          peer: pair.b,
        })
        this.after(this.rng.int(20, 60), () =>
          this.emit(pair.b, {
            type: 'signal',
            at: this.now,
            direction: 'in',
            kind: 'restart',
            peer: pair.a,
          }),
        )
        const epoch = pair.epoch
        this.after(this.rng.int(300, 900), () => {
          if (pair.epoch === epoch && pair.state === 'connected') this.changePath(pair, next)
        })
      } else if (this.rng.chance(0.004 * chaos)) {
        // brief drop: session resumes with away/back instead of leave/join
        pair.state = 'away'
        const epoch = pair.epoch
        for (const [s, r] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const) {
          this.emit(s, { type: 'connection', at: this.now, peer: r, state: 'away' })
        }
        this.after(this.rng.int(1200, 4000), () => {
          if (pair.epoch !== epoch || pair.state !== 'away' || this.partitioned(pair.a, pair.b))
            return
          pair.state = 'connected'
          for (const [s, r] of [
            [pair.a, pair.b],
            [pair.b, pair.a],
          ] as const) {
            this.emit(s, {
              type: 'connection',
              at: this.now,
              peer: r,
              state: 'back',
              path: pair.path,
            })
          }
        })
      }
    }
  }
}

/** Convenience: run a fresh engine for `durationMs` and return its whole log. */
export function generateEvents(opts: SimOptions, durationMs: number, stepMs = 100): StudioEvent[] {
  const engine = new SimEngine(opts)
  for (let t = 0; t < durationMs; t += stepMs) engine.step(Math.min(stepMs, durationMs - t))
  return [...engine.events()]
}
