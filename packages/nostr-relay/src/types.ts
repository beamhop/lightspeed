import type { ServerWebSocket } from 'bun'
import type { Negentropy } from './negentropy'

/** A signed Nostr event (NIP-01). */
export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** NIP-01 filter, plus NIP-50 `search`. Tag filters use `#<letter>` keys. */
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

/** NIP-11 relay information document. Unknown keys are passed through. */
export interface Nip11Info {
  name?: string
  description?: string
  banner?: string
  icon?: string
  pubkey?: string
  self?: string
  contact?: string
  supported_nips?: number[]
  software?: string
  version?: string
  privacy_policy?: string
  terms_of_service?: string
  posting_policy?: string
  payments_url?: string
  fees?: Record<string, unknown>
  limitation?: {
    max_message_length?: number
    max_subscriptions?: number
    max_limit?: number
    max_subid_length?: number
    max_event_tags?: number
    max_content_length?: number
    min_pow_difficulty?: number
    auth_required?: boolean
    payment_required?: boolean
    restricted_writes?: boolean
    created_at_lower_limit?: number
    created_at_upper_limit?: number
    default_limit?: number
  }
  retention?: unknown[]
  relay_countries?: string[]
  language_tags?: string[]
  tags?: string[]
  [key: string]: unknown
}

/** Token bucket: `rate` tokens per second, bucket size `burst`. */
export interface RateLimit {
  rate: number
  burst: number
}

/** A retention rule applied by the sweeper. Without `kinds` it applies to every kind. */
export interface RetentionRule {
  kinds?: number[]
  /** Delete matching events older than this many seconds. */
  maxAgeSeconds?: number
  /** Keep at most this many matching events (newest first) per realm. */
  maxCount?: number
}

/**
 * Policy for one realm (or the public relay when realm is `null`). Plain data except the
 * optional `writeAllowed` hook. Every field is optional; an empty policy allows everything.
 */
export interface Policy {
  pubkeys?: {
    /** When non-empty, only these pubkeys (or ones `writeAllowed` accepts) may write. */
    allow?: string[]
    /** Always rejected ("blocked:"). */
    deny?: string[]
  }
  kinds?: {
    /** When non-empty, only these kinds are accepted. */
    allow?: number[]
    deny?: number[]
  }
  rateLimits?: {
    /** EVENT messages per client IP. */
    ip?: RateLimit
    /** EVENT messages per event author. */
    pubkey?: RateLimit
    /** REQ/COUNT/NEG-OPEN messages per client IP. */
    reqIp?: RateLimit
  }
  /** Maximum serialized event size in bytes. */
  maxEventBytes?: number
  /** Maximum WebSocket message size in bytes. */
  maxMessageBytes?: number
  /** NIP-13 minimum proof-of-work difficulty (leading zero bits of the id). */
  minPow?: number
  /** Require NIP-42 AUTH before any REQ, COUNT, EVENT or NEG-OPEN. */
  authRequired?: boolean
  /** Kinds that need NIP-42 AUTH to publish or to read. */
  authRequiredKinds?: number[]
  /** Retention rules enforced by the periodic sweeper. */
  retention?: RetentionRule[]
  /** Reject events with created_at further than this many seconds in the future (default 900). */
  maxFutureSeconds?: number
  /** Reject events with created_at older than this many seconds (default: no limit). */
  maxPastSeconds?: number
  maxSubscriptions?: number
  maxFilters?: number
  /** Cap on filter `limit` (default 5000). */
  maxLimit?: number
  maxEventTags?: number
  maxContentLength?: number
  /** Maximum number of records a NEG-OPEN may reconcile (default 500000). */
  maxNegentropyRecords?: number
  /** Pubkeys allowed to call the NIP-86 management API for this realm. */
  admins?: string[]
  /** NIP-11 fields overriding the base info document for this realm. */
  info?: Partial<Nip11Info>
  /**
   * Write hook (used by payments). When defined, a pubkey that is not on `pubkeys.allow`
   * must make this return true to write.
   */
  writeAllowed?: (pubkey: string, event: NostrEvent) => boolean | Promise<boolean>
}

export interface PolicyProvider {
  get(realm: string | null): Policy
}

/** Per-connection state. Created by `relay.socketData()` and attached as `ws.data`. */
export interface NostrSocketData {
  readonly kind: 'nostr'
  readonly connId: number
  realm: string | null
  ip: string
  challenge: string
  authed: Set<string>
  subs: Map<string, Filter[]>
  negs: Map<string, Negentropy>
  connectedAt: number
}

export type NostrWebSocket = ServerWebSocket<NostrSocketData>

export interface NostrRelayOptions {
  /** SQLite file path; ':memory:' allowed. */
  dbPath: string
  /** NIP-11 base document (merged with per-realm overrides). */
  info: Nip11Info
  /** Global and per-realm rules; default allow-all. */
  policy?: PolicyProvider
  /** NIP-42: the relay URL clients must put in the `relay` tag. */
  auth?: { relayUrl: string }
  /** Verify Schnorr signatures on this many Worker threads (0 = inline, default). */
  verifyWorkers?: number
  /** Sweeper period for NIP-40 expiry and retention, ms (default 60000, 0 disables). */
  sweepIntervalMs?: number
  /** Global NIP-86 admins in addition to `Policy.admins`. */
  admins?: string[]
  /** NIP-77 responder frame size limit in bytes (0 = unlimited, default). */
  negentropyFrameSizeLimit?: number
}

export interface PublishResult {
  ok: boolean
  message: string
}

export interface RelayStats {
  events: number
  subscriptions: number
  clients: number
  eventsPerSec: number
}

export interface WebSocketHandlers {
  open(ws: NostrWebSocket): void
  message(ws: NostrWebSocket, msg: string | Buffer): void
  close(ws: NostrWebSocket, code: number, reason: string): void
  drain?(ws: NostrWebSocket): void
}

export interface SubscriptionInfo {
  connId: number
  realm: string | null
  ip: string
  subId: string
  filters: Filter[]
  authed: string[]
}

/** Moderation state written by NIP-86 (persisted in the database, layered over policy). */
export interface Moderation {
  banPubkey(realm: string | null, pubkey: string, reason?: string): void
  unbanPubkey(realm: string | null, pubkey: string): void
  listBannedPubkeys(realm: string | null): { pubkey: string; reason: string }[]
  allowPubkey(realm: string | null, pubkey: string, reason?: string): void
  unallowPubkey(realm: string | null, pubkey: string): void
  listAllowedPubkeys(realm: string | null): { pubkey: string; reason: string }[]
  banEvent(realm: string | null, id: string, reason?: string): void
  unbanEvent(realm: string | null, id: string): void
  listBannedEvents(realm: string | null): { id: string; reason: string }[]
  allowKind(realm: string | null, kind: number): void
  disallowKind(realm: string | null, kind: number): void
  listAllowedKinds(realm: string | null): number[]
  listDisallowedKinds(realm: string | null): number[]
  blockIp(realm: string | null, ip: string, reason?: string): void
  unblockIp(realm: string | null, ip: string): void
  listBlockedIps(realm: string | null): { ip: string; reason: string }[]
  setInfo(realm: string | null, key: 'name' | 'description' | 'icon', value: string): void
}

export interface NostrRelay {
  /** Bun WebSocket handlers. ws.data must be a NostrSocketData. */
  websocket: WebSocketHandlers
  socketData(ctx: { realm: string | null; ip: string }): NostrSocketData
  /** NIP-11 (Accept: application/nostr+json). */
  handleInfo(req: Request, realm: string | null): Response
  /** NIP-86 + NIP-98. */
  handleManagement(req: Request, realm: string | null): Promise<Response>
  publish(event: NostrEvent, realm?: string | null): Promise<PublishResult>
  query(filters: Filter[], realm?: string | null): NostrEvent[]
  /** NIP-45 count over the same filter semantics as `query`. */
  count(filters: Filter[], realm?: string | null): number
  /** Delete one stored event by id (admin). Returns true when something was removed. */
  deleteEvent(id: string, realm?: string | null): boolean
  stats(): RelayStats
  /** Live subscriptions (for admin views). */
  subscriptions(): SubscriptionInfo[]
  onEvent(cb: (e: NostrEvent, realm: string | null) => void): () => void
  /** Moderation state shared with NIP-86. */
  moderation: Moderation
  /** Run the NIP-40 expiry + retention sweeper now. Returns deleted row count. */
  sweep(): number
  /** Online backup with VACUUM INTO. */
  backup(path: string): void
  close(): void
}
