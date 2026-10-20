import type { Capability, CapabilityToken } from '../identity/capability'
import type { AttestationResult, JwksResolver } from '../identity/oidc'
import type { SharedLog, SharedMap } from '../state/store'
import type { TelemetryBus } from '../telemetry'
import type {
  Attestation,
  Hex,
  Identity,
  IdentityProvider,
  PathType,
  SignalingFactory,
  Transport,
  Unsubscribe,
} from '../types'
import type { Clock } from '../util/clock'
import type {
  ActionInput,
  ActionNames,
  ActionOutput,
  ProtocolDef,
  RequestInput,
  RequestNames,
  RequestOutput,
  ResponseInput,
  ResponseOutput,
} from './protocol'

export type Topology = 'mesh' | { star: { host?: Hex } }

export interface RoomPolicy {
  /**
   * Which attestations admit a peer. Omit to admit everyone whose attestations verify. When set, a peer
   * needs at least one verified attestation matching an enabled entry.
   */
  attest?: {
    anonymous?: boolean
    nostr?: boolean | { pubkeys: Hex[] }
    oidc?: { iss: string | string[]; sub?: string[] }
  }
  /** JWKS lookup for OIDC certs (default: OIDC discovery over fetch, cached). */
  jwks?: JwksResolver
  capabilities?: {
    /** Trusted token issuers (app keys). In star rooms the current host is trusted too. */
    issuers?: Hex[]
    /** Capabilities every peer must hold (e.g. ['join']). */
    require?: Capability[]
  }
  /** Dev mode: accept any validly signed capability token regardless of issuer. */
  dev?: boolean
  /** Final say, after attestations and capabilities verified. */
  admit?(peer: PeerCandidate): boolean | Promise<boolean>
}

export interface PeerCandidate {
  pubkey: Hex
  meta: Record<string, unknown>
  attestations: readonly Attestation[]
  verified: AttestationResult[]
  caps: Capability[]
}

export interface RoomTimeouts {
  /** Per-rung transport connect timeout (default 15 s). */
  connectMs?: number
  /** Handshake timeout (default 10 s). */
  handshakeMs?: number
  /** How long a dropped peer stays 'away' before it is reported as left (default 30 s). */
  resumeWindowMs?: number
  /** Session ping interval (default 5 s); three missed pongs kill the link. */
  pingIntervalMs?: number
  /** Housekeeping tick (default 1 s). */
  tickMs?: number
}

export interface RoomOptions<P extends ProtocolDef = ProtocolDef> {
  appId: string
  roomId: string
  password?: string
  identity: IdentityProvider | Identity
  signaling: SignalingFactory | SignalingFactory[]
  /** Connection ladder, tried in order (e.g. [webrtc(), relayTransport({ url })]). */
  transports: Transport[]
  topology?: Topology
  protocol?: P
  policy?: RoomPolicy
  /** Connect through the transport named 'relay' first, run the rest in parallel, migrate when better. */
  relayFirst?: boolean
  iceServers?: RTCIceServer[]
  /** Public metadata (display name, avatar...) shared in announces and handshakes. */
  meta?: Record<string, unknown>
  /** Our capability token (e.g. Studio's debug token). */
  capability?: CapabilityToken
  timeouts?: RoomTimeouts
  /** Telemetry bus enabled (default true). */
  telemetry?: boolean
  /** Include decoded payloads in telemetry 'message' events (default true). */
  telemetryPayloads?: boolean
  /** Swap time for a virtual clock (simulator). */
  clock?: Clock
}

export interface Peer {
  readonly pubkey: Hex
  readonly meta: Record<string, unknown>
  readonly attestations: readonly Attestation[]
  readonly verified: readonly AttestationResult[]
  readonly caps: readonly Capability[]
  /** 'away' while a dropped direct session waits to resume. */
  readonly state: 'connected' | 'away'
  /** 'direct' = we hold a session; 'host' = known through the star host's roster. */
  readonly via: 'direct' | 'host'
  readonly path: PathType | null
  readonly rttMs: number | undefined
  readonly isHost: boolean
}

export type Target = Hex | Hex[] | 'all'

export interface SendOptions {
  /** Recipients; default 'all'. */
  to?: Target
  /** Chunk progress for payloads over 16 KiB. */
  onProgress?: (sent: number, total: number) => void
}

export interface ActionHandle<In, Out> {
  /** Resolves when every recipient (or the star host) acknowledged it; unreliable actions resolve at once. */
  send(data: In, opts?: SendOptions): Promise<void>
  onMessage(cb: (data: Out, from: Hex) => void): Unsubscribe
}

export interface RequestHandle<ReqIn, ReqOut, ResIn, ResOut> {
  call(to: Hex, input: ReqIn, opts?: { timeoutMs?: number }): Promise<ResOut>
  handle(fn: (input: ReqOut, from: Hex) => ResIn | Promise<ResIn>): Unsubscribe
}

export interface IncomingFile {
  readonly id: string
  readonly from: Hex
  readonly name: string
  readonly mime: string
  readonly size: number | undefined
  readonly stream: ReadableStream<Uint8Array>
  /** Bytes received so far. */
  readonly received: number
  onProgress(cb: (received: number, total: number | undefined) => void): Unsubscribe
  /** Read the whole file. */
  bytes(): Promise<Uint8Array>
}

export interface FileSendOptions {
  to?: Target
  name?: string
  mime?: string
  size?: number
  onProgress?: (sent: number, total: number | undefined) => void
}

export type FileSource = Blob | ReadableStream<Uint8Array> | Uint8Array

export interface SessionInfo {
  remote: Hex
  state: 'connected' | 'away'
  path: PathType | null
  transport: string | null
  rttMs: number | undefined
  unacked: number
  queuedBytes: number
}

export interface RoomStateApi {
  map<V = unknown>(name: string): SharedMap<V>
  log<V = unknown>(name: string): SharedLog<V>
  /** Ask the host (star) or every connected peer (mesh) for a snapshot. */
  sync(): Promise<void>
  /** Canonical content string; equal across converged peers. */
  digest(): string
}

export interface RoomTelemetry {
  readonly bus: TelemetryBus
  subscribe: TelemetryBus['subscribe']
  /** Events from peers observed via observe(). */
  subscribeRemote: TelemetryBus['subscribeRemote']
  /** Ask peers to stream telemetry to us over the reserved channel (needs a 'debug' capability). */
  observe(peers?: Target): Promise<void>
}

export interface Room<P extends ProtocolDef = ProtocolDef> {
  readonly appId: string
  readonly roomId: string
  readonly topic: Hex
  readonly self: Identity
  /** Random id of this room instance; changes when a peer restarts. */
  readonly sid: string
  readonly topology: Topology
  /** Current star host (null in mesh rooms). */
  readonly host: Hex | null
  readonly peers: readonly Peer[]
  peer(pubkey: Hex): Peer | undefined
  onPeerJoin(cb: (peer: Peer) => void): Unsubscribe
  onPeerLeave(cb: (peer: Peer) => void): Unsubscribe
  /** Any peer change: away/back, path, rtt, host. */
  onPeerUpdate(cb: (peer: Peer) => void): Unsubscribe
  onHostChange(cb: (host: Hex | null) => void): Unsubscribe
  action<K extends ActionNames<P>>(name: K): ActionHandle<ActionInput<P, K>, ActionOutput<P, K>>
  request<K extends RequestNames<P>>(
    name: K,
  ): RequestHandle<RequestInput<P, K>, RequestOutput<P, K>, ResponseInput<P, K>, ResponseOutput<P, K>>
  sendFile(source: FileSource, opts?: FileSendOptions): Promise<void>
  onFile(cb: (file: IncomingFile) => void): Unsubscribe
  readonly state: RoomStateApi
  readonly telemetry: RoomTelemetry
  /** Expose telemetry on a BroadcastChannel for the in-page Studio bridge. */
  devtools(opts?: { channel?: string }): { close(): void }
  /** Studio / simulator introspection. */
  readonly debug: { sessions(): SessionInfo[]; presence(): Hex[] }
  leave(): Promise<void>
}
