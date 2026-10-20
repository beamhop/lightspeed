export * from './types'
export * from './wire'

// identity
export { anonymous, indexedDbKeyStorage, memoryKeyStorage } from './identity/anonymous'
export type { AnonymousOptions, KeyStorage } from './identity/anonymous'
export { generateSecretKey, getPublicKey, keyIdentity } from './identity/key'
export type { LocalIdentity } from './identity/key'
export {
  createNostrAttestation,
  nip46Signer,
  nostr,
  parseBunkerUrl,
  secretKeySigner,
  sessionAttestationEvent,
  verifyNostrAttestation,
} from './identity/nostr'
export type { Nip46Options, Nip46Transport, NostrOptions, NostrSigner } from './identity/nostr'
export {
  fetchJwks,
  oidc,
  publicJwk,
  signAttestationCert,
  staticJwks,
  verifyAttestation,
  verifyAttestationCert,
} from './identity/oidc'
export type {
  AttestationCert,
  AttestationResult,
  Jwk,
  JwksResolver,
  OidcOptions,
  SignCertOptions,
  VerifyAttestationOptions,
} from './identity/oidc'
export { capabilityHash, issueCapability, verifyCapability } from './identity/capability'
export type { Capability, CapabilityToken, IssueCapabilityOptions } from './identity/capability'

// crypto
export * as nip44 from './crypto/nip44'
export {
  bech32Decode,
  bech32Encode,
  decodeNsec,
  encodeNsec,
  eventHash,
  finalizeEvent,
  npubDecode,
  npubEncode,
  verifyEvent,
} from './crypto/nostr'
export type { NostrEvent, UnsignedEvent } from './crypto/nostr'

// signaling
export { SignalingHub, createSignalingHub, memorySignaling } from './signaling/memory'
export { unionAdapters, unionSignaling } from './signaling/union'

// transports
export { MemoryHub, createMemoryHub, memoryTransport } from './transport/memory'
export type { LinkConditions, MemoryHubOptions, MemoryLinkInfo, MemoryTransportOptions } from './transport/memory'
export { relayTransport } from './transport/relay'
export type { RelayTransport, RelayTransportOptions } from './transport/relay'

// room
export { createRoom } from './room/room'
export type * from './room/types'
export { action, any, defineProtocol, request, ValidationError } from './room/protocol'
export type {
  ActionDef,
  ActionInput,
  ActionNames,
  ActionOutput,
  Priority,
  ProtocolDef,
  ReliabilityOption,
  RequestDef,
  RequestInput,
  RequestNames,
  RequestOutput,
  ResponseInput,
  ResponseOutput,
  StandardSchemaV1,
} from './room/protocol'

// state
export type { LogItem, MapChange, SharedLog, SharedMap, StateSnapshot } from './state/store'
export { compareHlc, HlcClock } from './state/hlc'
export type { Hlc } from './state/hlc'

// telemetry + utilities
export { TelemetryBus } from './telemetry'
export { encodeCbor, decodeCbor } from './codec/cbor'
export { VirtualClock, realClock, seededRandom } from './util/clock'
export type { Clock } from './util/clock'
