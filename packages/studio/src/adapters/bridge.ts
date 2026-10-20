// In-page bridge: the app calls room.devtools(), which posts its telemetry on the
// BroadcastChannel `beamhop-devtools:<roomId>`. Studio (same origin: iframe, overlay or another
// tab) listens here. No network involved.
import type { TelemetryEvent } from '@beamhop/p2p'
import type {
  ActiveFault,
  AdmissionResult,
  ConnectionInfo,
  Fault,
  Hex,
  StudioEvent,
  StudioIdentity,
  StudioPeer,
  StudioRoom,
  Unsubscribe,
} from '../room-adapter'

export const devtoolsChannelName = (roomId: string) => `beamhop-devtools:${roomId}`

/** Messages the page may post. A bare TelemetryEvent is accepted too (source = page's self). */
export type BridgeInbound =
  | TelemetryEvent
  | { type: 'telemetry'; source?: Hex; event: TelemetryEvent }
  | { type: 'hello'; self: Hex; peers?: StudioPeer[] }
  | { type: 'peers'; peers: StudioPeer[] }
  | { type: 'connection-info'; source: Hex; peer: Hex; info: ConnectionInfo }

/** Messages Studio posts back; the page's dev hook may act on them. */
export type BridgeOutbound =
  | { type: 'studio-hello' }
  | { type: 'fault'; id: string; fault: Fault }
  | { type: 'clear-fault'; id: string }
  | { type: 'identity'; identity: StudioIdentity }
  | { type: 'connection-info?'; source: Hex; peer: Hex }

/** The subset of BroadcastChannel the bridge uses (injectable for tests). */
export interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  removeEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  close(): void
}

const TELEMETRY_TYPES = new Set([
  'signal',
  'connection',
  'path',
  'bytes',
  'rtt',
  'message',
  'progress',
  'peer',
])

export function isTelemetryEvent(x: unknown): x is TelemetryEvent {
  if (!x || typeof x !== 'object') return false
  const o = x as { type?: unknown; at?: unknown }
  return typeof o.type === 'string' && TELEMETRY_TYPES.has(o.type) && typeof o.at === 'number'
}

export interface BridgeRoomOptions {
  roomId: string
  /** Defaults to `new BroadcastChannel(devtoolsChannelName(roomId))`. */
  channel?: () => ChannelLike
  /** Fallback source pubkey before the page says hello. */
  defaultSource?: Hex
}

export class BridgeRoom implements StudioRoom {
  readonly mode = 'bridge' as const
  readonly roomId: string
  readonly capabilities = { faults: true, connectionInfo: true, identity: true }
  private channel: ChannelLike | null = null
  private log: StudioEvent[] = []
  private listeners = new Set<(e: StudioEvent) => void>()
  private seq = 0
  private self: Hex
  private peerList: StudioPeer[] = []
  private faultList: ActiveFault[] = []
  private faultSeq = 0
  private infos = new Map<string, ConnectionInfo>()
  private readonly makeChannel: () => ChannelLike

  constructor(opts: BridgeRoomOptions) {
    this.roomId = opts.roomId
    this.self = opts.defaultSource ?? 'page'
    this.makeChannel =
      opts.channel ??
      (() => new BroadcastChannel(devtoolsChannelName(opts.roomId)) as unknown as ChannelLike)
  }

  private onMessage = (e: { data: unknown }) => this.receive(e.data)

  /** Handle one inbound message (exposed for tests). */
  receive(data: unknown): void {
    if (isTelemetryEvent(data)) {
      this.push(this.self, data)
      return
    }
    if (!data || typeof data !== 'object') return
    const m = data as BridgeInbound
    switch (m.type) {
      case 'telemetry':
        if ('event' in m && isTelemetryEvent(m.event)) this.push(m.source ?? this.self, m.event)
        break
      case 'hello':
        if ('self' in m) {
          this.self = m.self
          if (m.peers) this.peerList = m.peers
        }
        break
      case 'peers':
        if ('peers' in m && Array.isArray(m.peers)) this.peerList = m.peers
        break
      case 'connection-info':
        if ('info' in m) this.infos.set(`${m.source}>${m.peer}`, m.info)
        break
    }
  }

  private push(source: Hex, event: TelemetryEvent): void {
    const se: StudioEvent = { seq: ++this.seq, source, event }
    this.log.push(se)
    for (const l of this.listeners) l(se)
  }

  private post(m: BridgeOutbound): void {
    this.channel?.postMessage(m)
  }

  async join(): Promise<void> {
    if (this.channel) return
    this.channel = this.makeChannel()
    this.channel.addEventListener('message', this.onMessage)
    this.post({ type: 'studio-hello' })
  }

  async leave(): Promise<void> {
    if (!this.channel) return
    this.channel.removeEventListener('message', this.onMessage)
    this.channel.close()
    this.channel = null
  }

  history(): readonly StudioEvent[] {
    return this.log
  }

  subscribe(cb: (event: StudioEvent) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  peers(): StudioPeer[] {
    if (this.peerList.length) return this.peerList
    // derive from telemetry when the page never sent a peer list
    const seen = new Map<Hex, StudioPeer>()
    seen.set(this.self, { pubkey: this.self, isSelf: true })
    for (const e of this.log) {
      const ev = e.event
      if (ev.type === 'peer' && ev.event === 'leave') seen.delete(ev.peer)
      else if ('peer' in ev && ev.peer && !seen.has(ev.peer)) seen.set(ev.peer, { pubkey: ev.peer })
    }
    return [...seen.values()]
  }

  async injectFault(fault: Fault): Promise<ActiveFault> {
    const active: ActiveFault = { id: `b${++this.faultSeq}`, fault, since: Date.now() }
    this.faultList = [...this.faultList, active]
    this.post({ type: 'fault', id: active.id, fault })
    return active
  }

  async clearFault(id: string): Promise<void> {
    this.faultList = this.faultList.filter((f) => f.id !== id)
    this.post({ type: 'clear-fault', id })
  }

  faults(): readonly ActiveFault[] {
    return this.faultList
  }

  connectionInfo(source: Hex, peer: Hex): ConnectionInfo | null {
    this.post({ type: 'connection-info?', source, peer })
    return this.infos.get(`${source}>${peer}`) ?? null
  }

  async setIdentity(identity: StudioIdentity): Promise<AdmissionResult> {
    this.post({ type: 'identity', identity })
    // The page decides admission; the bridge itself has no policy.
    return { admitted: true, reason: 'forwarded to the page (bridge mode has no admission check)' }
  }
}
