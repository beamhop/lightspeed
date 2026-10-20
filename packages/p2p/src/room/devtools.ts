// In-page devtools bridge: speaks Studio's BroadcastChannel protocol on `beamhop-devtools:<roomId>`.
//
// Page → Studio: { type: 'hello', self, peers }, { type: 'peers', peers },
//                { type: 'telemetry', source, event }, { type: 'connection-info', source, peer, info },
//                { type: 'admission', pubkey, admitted, reason? }   (extra, ignored by older Studios)
// Studio → page: { type: 'studio-hello' }, { type: 'fault', id, fault }, { type: 'clear-fault', id },
//                { type: 'identity', identity }, { type: 'connection-info?', source, peer }
import type { MemoryHub } from '../transport/memory'
import type { Attestation, Hex, PathType, Reliability, TelemetryEvent, Unsubscribe } from '../types'

export const devtoolsChannelName = (roomId: string): string => `beamhop-devtools:${roomId}`

export type DevtoolsFault =
  | { type: 'latency'; ms: number; peer?: Hex }
  | { type: 'loss'; rate: number; peer?: Hex }
  | { type: 'partition'; groups: Hex[][] }
  | { type: 'kill'; peer: Hex }

export interface DevtoolsPeer {
  pubkey: Hex
  name?: string
  isHost?: boolean
  isSelf?: boolean
  attestations?: Attestation['type'][]
  meta?: Record<string, unknown>
}

export interface DevtoolsChannelInfo {
  label: string
  reliability: Reliability['mode']
  readyState: 'connecting' | 'open' | 'closing' | 'closed'
  bufferedAmount: number
  bufferedAmountLowThreshold: number
}

export interface DevtoolsConnectionInfo {
  state: 'connecting' | 'connected' | 'disconnected' | 'closed'
  path: PathType
  channels: DevtoolsChannelInfo[]
  candidatePairs: {
    local: string
    remote: string
    path: PathType
    state: 'succeeded' | 'in-progress' | 'failed' | 'frozen'
    nominated: boolean
    rttMs?: number
  }[]
}

/** Identity Studio asks the page to evaluate (Studio's StudioIdentity). */
export interface DevtoolsIdentity {
  kind: string
  pubkey: Hex
  label?: string
  attestation: Attestation
}

export interface DevtoolsOptions {
  /** Channel name override (default `beamhop-devtools:<roomId>`). */
  channel?: string
  /** Called when Studio's identity switcher picks an identity, with this room's admission decision. */
  onIdentity?: (
    identity: DevtoolsIdentity,
    admission: { admitted: boolean; reason?: string },
  ) => void
  /** Custom BroadcastChannel factory (tests, non-browser runtimes). */
  createChannel?: (name: string) => DevtoolsChannelLike
}

export interface DevtoolsChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  removeEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
  close(): void
}

/** What the bridge needs from a room (implemented by RoomImpl). */
export interface DevtoolsHost {
  readonly roomId: string
  readonly selfKey: Hex
  studioPeers(): DevtoolsPeer[]
  onPeersChanged(cb: () => void): Unsubscribe
  onTelemetry(cb: (e: TelemetryEvent) => void): Unsubscribe
  recentTelemetry(): readonly TelemetryEvent[]
  memoryHubs(): MemoryHub[]
  /** Drop live links to `peer` ('all' = every peer); sessions then resume. */
  killLinks(peer: Hex | 'all'): void
  connectionInfo(peer: Hex): Promise<DevtoolsConnectionInfo | null>
  checkAdmission(identity: DevtoolsIdentity): Promise<{ admitted: boolean; reason?: string }>
  reportError(code: string, message: string): void
}

type Undo = () => void

export function startDevtools(host: DevtoolsHost, opts: DevtoolsOptions = {}): { close(): void } {
  const name = opts.channel ?? devtoolsChannelName(host.roomId)
  let ch: DevtoolsChannelLike
  if (opts.createChannel) ch = opts.createChannel(name)
  else {
    const BC = (globalThis as { BroadcastChannel?: new (n: string) => DevtoolsChannelLike })
      .BroadcastChannel
    if (!BC) return { close() {} }
    ch = new BC(name)
  }
  const post = (m: unknown) => {
    try {
      ch.postMessage(m)
    } catch {}
  }
  const self = host.selfKey
  const hello = () => post({ type: 'hello', self, peers: host.studioPeers() })
  const undo = new Map<string, Undo>()

  const applyFault = (f: DevtoolsFault): Undo | null => {
    const hubs = host.memoryHubs()
    if (hubs.length) {
      const undos: Undo[] = []
      for (const hub of hubs) {
        if (f.type === 'latency' || f.type === 'loss') {
          const cond = f.type === 'latency' ? { latencyMs: f.ms } : { loss: f.rate }
          if (!f.peer || f.peer === self) {
            const prev = { ...hub.defaults }
            hub.setDefaults(cond)
            undos.push(() => hub.setDefaults(prev))
          } else {
            const prev = hub.linkOverride(self, f.peer)
            hub.setLink(self, f.peer, cond)
            const peer = f.peer
            undos.push(() => hub.resetLink(self, peer, prev))
          }
        } else if (f.type === 'partition') {
          const groups = f.groups.filter((g) => g.length > 0)
          const ids = groups.map((g, i) =>
            hub.partition(g, groups.filter((_, j) => j !== i).flat()),
          )
          undos.push(() => {
            for (const id of ids) hub.unpartition(id)
          })
        } else if (f.type === 'kill') {
          hub.kill(f.peer)
          const peer = f.peer
          undos.push(() => hub.revive(peer))
        }
      }
      return () => {
        for (const u of undos) u()
      }
    }
    // Live transports: the only portable fault is dropping links (sessions resume afterwards).
    if (f.type === 'kill') {
      host.killLinks(f.peer === self ? 'all' : f.peer)
      return () => {}
    }
    if (f.type === 'partition') {
      const mine = f.groups.find((g) => g.includes(self))
      if (mine) for (const g of f.groups) if (g !== mine) for (const p of g) host.killLinks(p)
      return () => {}
    }
    host.reportError('fault-unsupported', `${f.type} faults need the memory transport`)
    return null
  }

  const onMessage = (e: { data: unknown }) => {
    const m = e.data as { type?: string; [k: string]: unknown } | null
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'studio-hello':
        hello()
        for (const ev of host.recentTelemetry())
          post({ type: 'telemetry', source: self, event: ev })
        return
      case 'fault': {
        const id = String(m.id)
        const u = applyFault(m.fault as DevtoolsFault)
        if (u) undo.set(id, u)
        return
      }
      case 'clear-fault': {
        const id = String(m.id)
        undo.get(id)?.()
        undo.delete(id)
        return
      }
      case 'connection-info?': {
        if (m.source !== undefined && m.source !== self) return
        const peer = m.peer as Hex
        void host.connectionInfo(peer).then((info) => {
          if (info) post({ type: 'connection-info', source: self, peer, info })
        })
        return
      }
      case 'identity': {
        const identity = m.identity as DevtoolsIdentity
        if (!identity || typeof identity.pubkey !== 'string') return
        void host.checkAdmission(identity).then((r) => {
          post({ type: 'admission', pubkey: identity.pubkey, ...r })
          opts.onIdentity?.(identity, r)
        })
        return
      }
    }
  }

  ch.addEventListener('message', onMessage)
  const unsubs = [
    host.onTelemetry((event) => post({ type: 'telemetry', source: self, event })),
    host.onPeersChanged(() => post({ type: 'peers', peers: host.studioPeers() })),
  ]
  hello()
  return {
    close() {
      for (const u of unsubs) u()
      for (const u of undo.values()) u()
      undo.clear()
      ch.removeEventListener('message', onMessage)
      ch.close()
    },
  }
}
