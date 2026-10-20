// The narrow interface Studio needs from a room. Studio never talks to @beamhop/p2p's Room
// directly; every attach mode (simulated, in-page bridge, observer peer) implements this.
import type {
  Attestation,
  Connection,
  Hex,
  PathType,
  Reliability,
  TelemetryEvent,
  Unsubscribe,
} from '@beamhop/p2p'

export type { Hex, PathType, TelemetryEvent, Unsubscribe }

/** A telemetry event as Studio stores it: who reported it, plus a stable sequence number. */
export interface StudioEvent {
  /** Monotonic per room adapter; breaks ties between events with the same `at`. */
  seq: number
  /** Pubkey of the peer whose telemetry bus emitted the event. */
  source: Hex
  event: TelemetryEvent
}

export type AttachMode = 'simulated' | 'bridge' | 'observer'

export interface StudioPeer {
  pubkey: Hex
  /** Display name (peer.meta.name or a generated label). */
  name?: string
  /** Host of a star room. */
  isHost?: boolean
  /** The peer Studio itself is attached as (observer / local page). */
  isSelf?: boolean
  attestations?: Attestation['type'][]
  meta?: Record<string, unknown>
}

/** Faults Studio can inject. `peer` omitted means "every peer". */
export type Fault =
  | { type: 'latency'; ms: number; peer?: Hex }
  | { type: 'loss'; rate: number; peer?: Hex }
  | { type: 'partition'; groups: Hex[][] }
  | { type: 'kill'; peer: Hex }

export interface ActiveFault {
  id: string
  fault: Fault
  /** Telemetry time (ms) the fault was applied. */
  since: number
}

export interface ChannelInfo {
  label: string
  reliability: Reliability['mode']
  readyState: 'connecting' | 'open' | 'closing' | 'closed'
  bufferedAmount: number
  bufferedAmountLowThreshold: number
}

export interface CandidatePairInfo {
  local: string
  remote: string
  path: PathType
  state: 'succeeded' | 'in-progress' | 'failed' | 'frozen'
  nominated: boolean
  rttMs?: number
}

/** Live connection internals that are not on the telemetry bus. */
export interface ConnectionInfo {
  state: Connection['state']
  path: PathType
  channels: ChannelInfo[]
  candidatePairs: CandidatePairInfo[]
}

export type IdentityKind = 'anonymous' | 'nostr' | 'oidc'

export interface StudioIdentity {
  kind: IdentityKind
  /** Session pubkey the room would use. */
  pubkey: Hex
  label: string
  attestation: Attestation
}

export interface AdmissionResult {
  admitted: boolean
  reason?: string
}

export interface StudioRoomCapabilities {
  faults: boolean
  connectionInfo: boolean
  identity: boolean
}

export interface StudioRoom {
  readonly mode: AttachMode
  readonly roomId: string
  readonly capabilities: StudioRoomCapabilities
  /** Join (or attach) as an observer. Resolves once telemetry starts flowing. */
  join(): Promise<void>
  leave(): Promise<void>
  /** Events received so far, in arrival order. */
  history(): readonly StudioEvent[]
  /** Live events after the call. */
  subscribe(cb: (event: StudioEvent) => void): Unsubscribe
  /** Known peers (including self when the adapter is a peer itself). */
  peers(): StudioPeer[]
  injectFault(fault: Fault): Promise<ActiveFault>
  clearFault(id: string): Promise<void>
  faults(): readonly ActiveFault[]
  /** Connection internals as seen by `source` towards `peer`, when available. */
  connectionInfo(source: Hex, peer: Hex): ConnectionInfo | null
  /** Swap the identity the observer joins with; returns the room's admission decision. */
  setIdentity(identity: StudioIdentity): Promise<AdmissionResult>
}

/** Error thrown for operations an adapter cannot perform. */
export class UnsupportedError extends Error {
  constructor(what: string, mode: AttachMode) {
    super(`${what} is not supported in ${mode} mode`)
    this.name = 'UnsupportedError'
  }
}
