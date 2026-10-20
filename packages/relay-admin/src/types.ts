// Domain types for the @beamhop/relay admin API (see CLAUDE.md "admin API").
// Shapes the contract does not pin down are kept small and every reader normalizes missing fields.

export type Hex = string

export interface NostrEvent {
  id: Hex
  pubkey: Hex
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: Hex
}

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'pubkey' | 'sig'> & { pubkey?: Hex }

export interface ApiErrorBody {
  error: { code: string; message: string }
}

// ---- auth ----
export type AdminRole = 'owner' | 'admin'

export interface Me {
  id: string
  pubkey?: Hex
  username?: string
  role: AdminRole
  method: 'nostr' | 'password' | 'bootstrap'
  sessionId: string
  /** True while the relay still has an unclaimed bootstrap token (no admins yet). */
  bootstrapPending?: boolean
}

// ---- overview + stats ----
export type AlertLevel = 'info' | 'warning' | 'critical'

export interface Alert {
  id: string
  level: AlertLevel
  code: string
  message: string
  createdAt: number
  acknowledged?: boolean
  /** Optional deep link target, e.g. { app: 'abc' } or { client: '1.2.3.4' }. */
  target?: { app?: string; client?: string; ip?: string }
}

export interface NostrStats {
  events: number
  subscriptions: number
  clients: number
  eventsPerSec: number
}

export interface TurnStats {
  allocations: number
  bytesIn: number
  bytesOut: number
  bps: number
}

export interface DiskStats {
  usedBytes: number
  totalBytes: number
}

export interface Overview {
  nostr: NostrStats
  turn: TurnStats
  disk: DiskStats
  uptimeSec: number
  version?: string
  apps: number
  blobs?: { count: number; bytes: number }
  alerts: Alert[]
}

/** Pushed every second over WebSocket /api/admin/stats. */
export interface StatsMessage {
  type: 'stats'
  ts: number
  nostr: NostrStats
  turn: TurnStats
  disk?: DiskStats
  uptimeSec?: number
  alerts?: number
}

// ---- policies ----
export interface RateLimit {
  /** Events allowed per window. 0 = unlimited. */
  events: number
  windowSec: number
}

export interface RetentionRule {
  kinds: number[]
  /** Max age in seconds; 0/undefined = keep forever. */
  maxAgeSec?: number
  /** Max events kept per pubkey for these kinds. */
  maxCount?: number
}

export interface Policy {
  pubkeys: { allow: Hex[]; deny: Hex[] }
  kinds: { allow: number[]; deny: number[] }
  rateLimits: { perIp: RateLimit; perPubkey: RateLimit }
  maxEventSize: number
  minPow: number
  authRequiredKinds: number[]
  retention: RetentionRule[]
}

export const GLOBAL_REALM = '_global'

// ---- NIP-11 ----
export interface Nip11Info {
  name?: string
  description?: string
  pubkey?: Hex
  contact?: string
  icon?: string
  banner?: string
  supported_nips?: number[]
  software?: string
  version?: string
  limitation?: Record<string, number | boolean>
  posting_policy?: string
  payments_url?: string
  [k: string]: unknown
}

// ---- apps ----
export interface AppQuotas {
  maxAllocations?: number
  maxMbps?: number
  gbPerMonth?: number
  maxBlobBytes?: number
  maxStorageBytes?: number
  allowedMime?: string[]
}

export interface App {
  id: string
  name: string
  description?: string
  createdAt: number
  enabled: boolean
  plan?: string
  quotas: AppQuotas
  /** Masked secret hints, never full values (e.g. "…a1b2"). */
  turnSecretHint?: string
  apiKeyHint?: string
  usage?: { bytesMonth: number; allocations: number; events: number; blobsBytes: number }
}

export interface AppCreated extends App {
  /** Only returned once at creation time. */
  turnSecret: string
  apiKey: string
}

export interface AppPatch {
  name?: string
  description?: string
  enabled?: boolean
  plan?: string
  quotas?: AppQuotas
}

export interface UsagePoint {
  ts: number
  bytesIn: number
  bytesOut: number
  allocations: number
  events: number
}

export interface AppUsage {
  appId: string
  from: number
  to: number
  points: UsagePoint[]
  totals: { bytes: number; events: number; peakAllocations: number }
}

// ---- nostr explorer ----
export interface EventQuery {
  kind?: number | number[]
  author?: Hex
  /** "#t=value" style: "t:value" */
  tag?: string
  search?: string
  limit?: number
  until?: number
  realm?: string
}

export interface Subscription {
  id: string
  clientId: string
  ip: string
  realm: string | null
  filters: Record<string, unknown>[]
  createdAt: number
  eventsSent: number
}

// ---- TURN ----
export interface Allocation {
  id: string
  username: string
  appId?: string
  transport: 'udp' | 'tcp' | 'tls'
  client: string
  relayed: string
  bytesIn: number
  bytesOut: number
  createdAt: number
  expiresAt: number
}

export interface Ban {
  id: string
  ip: string
  reason?: string
  createdAt: number
  expiresAt?: number | null
  createdBy?: string
}

export interface NewBan {
  ip: string
  reason?: string
  durationSec?: number | null
}

// ---- media ----
export interface MediaBlob {
  sha256: Hex
  size: number
  type: string
  uploaded: number
  pubkey: Hex
  app?: string
  url?: string
}

// ---- payments ----
export interface Plan {
  id: string
  name: string
  priceSats: number
  periodDays: number
  description?: string
  appId?: string | null
  active: boolean
}

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'refunded'

export interface Invoice {
  id: string
  planId: string
  pubkey: Hex
  amountSats: number
  status: InvoiceStatus
  createdAt: number
  paidAt?: number | null
  bolt11?: string
}

export interface PaidPubkey {
  pubkey: Hex
  planId: string
  appId?: string | null
  since: number
  expiresAt: number
}

export interface NwcStatus {
  connected: boolean
  walletPubkey?: Hex
  relay?: string
  lnurl?: string
  balanceSats?: number
}

// ---- admins ----
export interface Admin {
  id: string
  pubkey?: Hex
  username?: string
  role: AdminRole
  totpEnabled: boolean
  createdAt: number
  lastLoginAt?: number | null
}

export interface NewAdmin {
  pubkey?: Hex
  username?: string
  password?: string
  role: AdminRole
}

export interface Session {
  id: string
  adminId: string
  label: string
  ip: string
  userAgent?: string
  createdAt: number
  lastSeenAt: number
  current?: boolean
}

export interface AuditEntry {
  id: string
  ts: number
  actor: string
  action: string
  scope: string
  details?: Record<string, unknown>
  ip?: string
}

// ---- settings ----
export interface Settings {
  publicUrl: string
  listeners: {
    https: number
    turnUdp: number
    turnTcp: number
    turnTls: number
    relayPorts: [number, number]
  }
  tls: { cert: string; key: string; auto: boolean }
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; json: boolean }
  metrics: { enabled: boolean; path: string }
  backups: { enabled: boolean; hourUtc: number; retentionDays: number; s3Url?: string }
}

export interface Backup {
  id: string
  createdAt: number
  sizeBytes: number
  files: string[]
  status: 'running' | 'done' | 'failed'
}

export interface Page<T> {
  items: T[]
  next?: string | number | null
}
