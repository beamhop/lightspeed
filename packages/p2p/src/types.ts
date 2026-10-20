// Shared contracts for @beamhop/p2p. Other packages (signaling-nostr, react, studio, relay)
// build against these shapes; change them only together with their implementers.

/** Lowercase hex string. Pubkeys are 32-byte x-only secp256k1 keys (BIP-340). */
export type Hex = string

export type Unsubscribe = () => void

// ---------------------------------------------------------------- identity

export type Attestation =
  | { type: 'anonymous' }
  | {
      type: 'nostr'
      pubkey: Hex
      /** NIP-26-free: session key signed by the nostr key (event kind KIND_SESSION_ATTESTATION). */
      sig: Hex
      /** created_at of the signed attestation event; 0 when omitted. */
      created_at?: number
    }
  | { type: 'oidc' /** JWS { v: 1, iss, sub, pubkey, iat, exp } */; jws: string }

export interface Identity {
  /** Session pubkey used for signaling, handshakes and pair encryption. */
  readonly pubkey: Hex
  readonly attestations: readonly Attestation[]
  /** BIP-340 Schnorr signature over a 32-byte message hash. */
  sign(hash32: Uint8Array): Promise<Uint8Array>
  /** NIP-44 v2 encryption to another pubkey. */
  encrypt(to: Hex, plaintext: string): Promise<string>
  decrypt(from: Hex, payload: string): Promise<string>
  /** NIP-44 v2 conversation key with `peer` (used for relay-path frame encryption). */
  conversationKey(peer: Hex): Promise<Uint8Array>
}

export interface IdentityProvider {
  readonly kind: 'anonymous' | 'nostr' | 'oidc' | (string & {})
  load(): Promise<Identity>
}

// ---------------------------------------------------------------- signaling

/** A signal as received from a signaling adapter. Payloads are opaque strings;
 * the room encrypts announces with the room key and directed signals with NIP-44. */
export interface Signal {
  kind: 'announce' | 'direct'
  /** Sender's session pubkey (the Nostr event author for the Nostr adapter). */
  from: Hex
  content: string
  /** Seconds since epoch as stamped by the sender. */
  createdAt: number
}

export interface SignalingAdapter {
  /** Room-wide announce (kind 20100, tagged `t` = topic). */
  announce(topic: Hex, content: string): Promise<void>
  /** Directed signal (kind 20101, tagged `t` and `p` = recipient). */
  send(topic: Hex, to: Hex, content: string): Promise<void>
  /** Receive announces for the topic and directed signals addressed to the local identity. */
  subscribe(topic: Hex, onSignal: (signal: Signal) => void): Unsubscribe
  /** Optional connection status per underlying endpoint, for telemetry and the demo lobby. */
  status?(): SignalingStatus[]
  close(): Promise<void>
}

export interface SignalingStatus {
  url: string
  state: 'connecting' | 'open' | 'closed' | 'error'
  error?: string
}

/** Adapters are created per room with the room's identity (needed to sign Nostr events). */
export type SignalingFactory = (ctx: { identity: Identity }) => SignalingAdapter

// ---------------------------------------------------------------- transport

export type Reliability =
  | { mode: 'reliable' }
  | { mode: 'unordered' }
  | { mode: 'unreliable'; maxRetransmits: number }

export type PathType = 'direct' | 'turn' | 'relay' | 'memory'

export interface Channel {
  readonly label: string
  readonly reliability: Reliability
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: Uint8Array): void
  onOpen(cb: () => void): Unsubscribe
  onMessage(cb: (data: Uint8Array) => void): Unsubscribe
  onBufferedAmountLow(cb: () => void): Unsubscribe
  onClose(cb: () => void): Unsubscribe
  close(): void
}

export interface ConnectionStats {
  path: PathType
  rttMs?: number
  bytesSent: number
  bytesReceived: number
  localCandidateType?: string
  remoteCandidateType?: string
}

export interface Connection {
  readonly remote: Hex
  readonly path: PathType
  readonly state: 'connecting' | 'connected' | 'disconnected' | 'closed'
  openChannel(label: string, reliability: Reliability): Channel
  onChannel(cb: (channel: Channel) => void): Unsubscribe
  onStateChange(cb: (state: Connection['state']) => void): Unsubscribe
  /** Media (webrtc only). */
  addStream?(stream: MediaStream): void
  removeStream?(stream: MediaStream): void
  onTrack?(cb: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void): Unsubscribe
  stats(): Promise<ConnectionStats>
  close(): void
}

/** Per-pair signaling pipe a transport uses to exchange offer/answer/ICE or relay-connect. */
export interface SignalPipe {
  send(message: TransportSignal): void
  onMessage(cb: (message: TransportSignal) => void): Unsubscribe
}

export type TransportSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }
  | { type: 'restart' }
  | { type: 'relay-connect'; url: string }
  | { type: string & {}; [k: string]: unknown }

export interface TransportConnectOptions {
  /** Deterministic: the lower pubkey initiates. */
  initiator: boolean
  pipe: SignalPipe
  local: Identity
  signal?: AbortSignal
  /** ICE servers configured on the room (createRoom({ iceServers })); transports may ignore it. */
  iceServers?: RTCIceServer[]
}

export interface Transport {
  readonly name: 'webrtc' | 'relay' | 'memory' | (string & {})
  connect(remote: Hex, opts: TransportConnectOptions): Promise<Connection>
}

// ---------------------------------------------------------------- telemetry

export type TelemetryEvent =
  | {
      type: 'signal'
      at: number
      direction: 'in' | 'out'
      kind: Signal['kind'] | TransportSignal['type']
      peer?: Hex
    }
  | {
      type: 'connection'
      at: number
      peer: Hex
      state: Connection['state'] | 'away' | 'back'
      path?: PathType
    }
  | { type: 'path'; at: number; peer: Hex; path: PathType; candidatePair?: string }
  | { type: 'bytes'; at: number; peer: Hex; channel: string; sent: number; received: number }
  | { type: 'rtt'; at: number; peer: Hex; ms: number }
  | {
      type: 'message'
      at: number
      peer: Hex
      direction: 'in' | 'out'
      action: string
      size: number
      payload?: unknown
    }
  | { type: 'progress'; at: number; peer: Hex; streamId: number; sent: number; total: number }
  | { type: 'peer'; at: number; peer: Hex; event: 'join' | 'leave' }
  | { type: 'error'; at: number; peer?: Hex; code: string; message: string }
  | { type: 'host'; at: number; host: Hex | null }
