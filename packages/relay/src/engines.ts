// Contracts for the two engines the relay embeds, copied from CLAUDE.md ("Integration contracts").
// The relay codes only against these interfaces; `server.ts` loads the real packages through
// `loadNostrEngine()` / `loadTurnEngine()` and tests inject in-process fakes.
import type { ServerWebSocket } from 'bun'

// ---------------------------------------------------------------- Nostr

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface Filter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [tag: `#${string}`]: string[] | undefined
}

/** NIP-11 relay information document. Open-ended: engines and admins may add fields. */
export interface Nip11Info {
  name?: string
  description?: string
  pubkey?: string
  contact?: string
  software?: string
  version?: string
  supported_nips?: number[]
  icon?: string
  banner?: string
  payments_url?: string
  fees?: {
    admission?: { amount: number; unit: string }[]
    subscription?: { amount: number; unit: string; period: number }[]
    publication?: { kinds?: number[]; amount: number; unit: string }[]
  }
  limitation?: Record<string, unknown>
  [key: string]: unknown
}

export interface RateLimit {
  /** Events (or messages) allowed per window. */
  count: number
  windowSec: number
}

export interface RetentionRule {
  kinds?: number[]
  /** Maximum age in seconds; omitted = keep forever. */
  maxAgeSec?: number
  /** Maximum stored events for the kinds; omitted = unlimited. */
  maxCount?: number
}

/**
 * Policy covers pubkey allow/deny, kind allow/deny, rate limits per IP/pubkey, max event size,
 * NIP-13 min PoW, auth-required kinds, retention per kind and the writeAllowed hook.
 * The exact field names are the relay's assumption of the engine contract (see README).
 */
export interface Policy {
  pubkeys?: { allow?: string[]; deny?: string[] }
  kinds?: { allow?: number[]; deny?: number[] }
  rateLimits?: { perIp?: RateLimit; perPubkey?: RateLimit }
  maxEventSize?: number
  minPow?: number
  authRequiredKinds?: number[]
  retention?: RetentionRule[]
  /** Called for every write after the static rules; false rejects the event ("restricted:"). */
  writeAllowed?(pubkey: string): boolean
}

export interface PolicyProvider {
  get(realm: string | null): Policy
}

/** Opaque per-socket state created by the engine. */
export type NostrSocketData = object

export interface NostrRelayWebSocketHandlers {
  open(ws: ServerWebSocket<NostrSocketData>): void
  message(ws: ServerWebSocket<NostrSocketData>, msg: string | Buffer): void
  close(ws: ServerWebSocket<NostrSocketData>, code: number, reason: string): void
  drain?(ws: ServerWebSocket<NostrSocketData>): void
}

export interface NostrRelay {
  /** Bun WebSocket handlers. ws.data must be a NostrSocketData. */
  websocket: NostrRelayWebSocketHandlers
  socketData(ctx: { realm: string | null; ip: string }): NostrSocketData
  handleInfo(req: Request, realm: string | null): Response
  handleManagement(req: Request, realm: string | null): Promise<Response>
  publish(event: NostrEvent, realm?: string | null): Promise<{ ok: boolean; message: string }>
  query(filters: Filter[], realm?: string | null): NostrEvent[]
  stats(): { events: number; subscriptions: number; clients: number; eventsPerSec: number }
  onEvent(cb: (e: NostrEvent, realm: string | null) => void): () => void
  close(): void
  // Optional, non-contract extras the relay uses when present.
  deleteEvent?(id: string, realm?: string | null): boolean
  subscriptions?(): unknown[]
}

export interface NostrRelayOptions {
  dbPath: string
  info: Nip11Info
  policy?: PolicyProvider
  auth?: { relayUrl: string }
}

export type NostrRelayFactory = (opts: NostrRelayOptions) => NostrRelay

// ---------------------------------------------------------------- TURN

export interface AllocationInfo {
  id: string
  username: string
  transport: string
  client?: unknown
  relayed?: unknown
  bytesIn?: number
  bytesOut?: number
  createdAt?: number
  expiresAt?: number
  [key: string]: unknown
}

export interface TurnUsage {
  username: string
  allocationId: string
  bytesIn: number
  bytesOut: number
}

export interface TurnQuota {
  maxAllocations?: number
  maxBps?: number
  allowed?: boolean
}

export interface TurnServerOptions {
  realm: string
  listen: { udp?: number; tcp?: number; tls?: { port: number; cert: string; key: string } }
  host?: string
  externalIp?: string
  relayPorts: [number, number]
  credentials(username: string): { password: string } | null
  quota?(username: string): TurnQuota
  onUsage?(u: TurnUsage): void
}

export interface TurnServer {
  start(): Promise<{ udp?: number; tcp?: number; tls?: number }>
  stop(): Promise<void>
  allocations(): AllocationInfo[]
  kill(id: string): boolean
  stats(): { allocations: number; bytesIn: number; bytesOut: number; bps: number }
}

export type TurnServerFactory = (opts: TurnServerOptions) => TurnServer

// ---------------------------------------------------------------- loaders

/**
 * Load `createNostrRelay` from `@beamhop/nostr-relay`. Returns null when the package does not
 * (yet) export it, so the relay can boot degraded instead of crashing.
 */
export async function loadNostrEngine(): Promise<NostrRelayFactory | null> {
  try {
    const mod = (await import('@beamhop/nostr-relay')) as Record<string, unknown>
    return typeof mod.createNostrRelay === 'function'
      ? (mod.createNostrRelay as NostrRelayFactory)
      : null
  } catch {
    return null
  }
}

/** Load `createTurnServer` from `@beamhop/turn` (null when unavailable). */
export async function loadTurnEngine(): Promise<TurnServerFactory | null> {
  try {
    const mod = (await import('@beamhop/turn')) as Record<string, unknown>
    return typeof mod.createTurnServer === 'function'
      ? (mod.createTurnServer as TurnServerFactory)
      : null
  } catch {
    return null
  }
}
