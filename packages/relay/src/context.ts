import type { Alert } from './alerts'
import type { AppStore } from './apps'
import type { AdminAuth } from './auth'
import type { BackupFile } from './backups'
import type { Blossom } from './blossom'
import type { LoadedConfig, RelayConfig } from './config'
import type { DataRelay } from './data-relay'
import type { AdminDb } from './db'
import type { Nip11Info, NostrRelay, TurnServer } from './engines'
import type { Logger } from './log'
import type { HttpCounters } from './metrics'
import type { Payments } from './payments'
import type { BanStore, PolicyStore } from './policy'
import type { UsageMeter } from './usage'

/** Everything route handlers need; implemented by the relay server. */
export interface RelayContext {
  config: RelayConfig
  loaded: Pick<LoadedConfig, 'path' | 'envKeys'>
  adb: AdminDb
  apps: AppStore
  bans: BanStore
  policies: PolicyStore
  auth: AdminAuth
  payments: Payments
  blossom: Blossom
  dataRelay: DataRelay
  meter: UsageMeter
  http: HttpCounters
  nostr: NostrRelay | null
  turn: TurnServer | null
  logger: Logger
  startedAt: number
  version: string
  backupDir: string
  /** Effective NIP-11 document (shared, mutated in place on edits). */
  nip11: Nip11Info
  refreshNip11(): void
  /** Re-apply admin.db config overrides onto live components. */
  applySettings(): void
  /** Close realm and data relay sockets of apps that are no longer active. */
  kickInactiveApps(): void
  alerts(): Alert[]
  overview(): Record<string, unknown>
  stats(): Record<string, unknown>
  backup(): BackupFile[]
  deleteNostrEvent(id: string, realm: string | null): Promise<boolean>
  /** Public base URL for links (config.publicUrl or derived from the request). */
  baseUrl(req: Request): string
}
