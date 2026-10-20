import type { Database } from 'bun:sqlite'
import { realmKey } from './store'
import type { Moderation } from './types'

/** Cached view of the moderation tables for one realm. */
export interface ModerationSnapshot {
  bannedPubkeys: Set<string>
  allowedPubkeys: Set<string>
  bannedEvents: Set<string>
  allowedKinds: Set<number>
  disallowedKinds: Set<number>
  blockedIps: Set<string>
  meta: Record<string, string>
}

/** NIP-86 state persisted in SQLite and cached in memory per realm. */
export class ModerationStore implements Moderation {
  private cache = new Map<string, ModerationSnapshot>()

  constructor(private db: Database) {}

  snapshot(realm: string | null): ModerationSnapshot {
    const r = realmKey(realm)
    let s = this.cache.get(r)
    if (s) return s
    const pubkeys = this.db
      .query('SELECT pubkey, status FROM mod_pubkeys WHERE realm = ?')
      .all(r) as { pubkey: string; status: string }[]
    const kinds = this.db.query('SELECT kind, status FROM mod_kinds WHERE realm = ?').all(r) as {
      kind: number
      status: string
    }[]
    s = {
      bannedPubkeys: new Set(pubkeys.filter((p) => p.status === 'ban').map((p) => p.pubkey)),
      allowedPubkeys: new Set(pubkeys.filter((p) => p.status === 'allow').map((p) => p.pubkey)),
      bannedEvents: new Set(
        (this.db.query('SELECT id FROM mod_events WHERE realm = ?').all(r) as { id: string }[]).map(
          (x) => x.id,
        ),
      ),
      allowedKinds: new Set(kinds.filter((k) => k.status === 'allow').map((k) => k.kind)),
      disallowedKinds: new Set(kinds.filter((k) => k.status === 'deny').map((k) => k.kind)),
      blockedIps: new Set(
        (this.db.query('SELECT ip FROM mod_ips WHERE realm = ?').all(r) as { ip: string }[]).map(
          (x) => x.ip,
        ),
      ),
      meta: Object.fromEntries(
        (
          this.db.query('SELECT key, value FROM relay_meta WHERE realm = ?').all(r) as {
            key: string
            value: string
          }[]
        ).map((m) => [m.key, m.value]),
      ),
    }
    this.cache.set(r, s)
    return s
  }

  private run(realm: string | null, sql: string, ...params: (string | number)[]) {
    this.db.query(sql).run(realmKey(realm), ...params)
    this.cache.delete(realmKey(realm))
  }

  banPubkey(realm: string | null, pubkey: string, reason = '') {
    this.run(
      realm,
      "DELETE FROM mod_pubkeys WHERE realm = ? AND pubkey = ? AND status = 'allow'",
      pubkey,
    )
    this.run(
      realm,
      "INSERT OR REPLACE INTO mod_pubkeys (realm, pubkey, status, reason) VALUES (?, ?, 'ban', ?)",
      pubkey,
      reason,
    )
  }
  unbanPubkey(realm: string | null, pubkey: string) {
    this.run(
      realm,
      "DELETE FROM mod_pubkeys WHERE realm = ? AND pubkey = ? AND status = 'ban'",
      pubkey,
    )
  }
  listBannedPubkeys(realm: string | null) {
    return this.db
      .query("SELECT pubkey, reason FROM mod_pubkeys WHERE realm = ? AND status = 'ban'")
      .all(realmKey(realm)) as { pubkey: string; reason: string }[]
  }
  allowPubkey(realm: string | null, pubkey: string, reason = '') {
    this.run(
      realm,
      "DELETE FROM mod_pubkeys WHERE realm = ? AND pubkey = ? AND status = 'ban'",
      pubkey,
    )
    this.run(
      realm,
      "INSERT OR REPLACE INTO mod_pubkeys (realm, pubkey, status, reason) VALUES (?, ?, 'allow', ?)",
      pubkey,
      reason,
    )
  }
  unallowPubkey(realm: string | null, pubkey: string) {
    this.run(
      realm,
      "DELETE FROM mod_pubkeys WHERE realm = ? AND pubkey = ? AND status = 'allow'",
      pubkey,
    )
  }
  listAllowedPubkeys(realm: string | null) {
    return this.db
      .query("SELECT pubkey, reason FROM mod_pubkeys WHERE realm = ? AND status = 'allow'")
      .all(realmKey(realm)) as { pubkey: string; reason: string }[]
  }
  banEvent(realm: string | null, id: string, reason = '') {
    this.run(
      realm,
      'INSERT OR REPLACE INTO mod_events (realm, id, reason) VALUES (?, ?, ?)',
      id,
      reason,
    )
  }
  unbanEvent(realm: string | null, id: string) {
    this.run(realm, 'DELETE FROM mod_events WHERE realm = ? AND id = ?', id)
  }
  listBannedEvents(realm: string | null) {
    return this.db
      .query('SELECT id, reason FROM mod_events WHERE realm = ?')
      .all(realmKey(realm)) as { id: string; reason: string }[]
  }
  allowKind(realm: string | null, kind: number) {
    this.run(realm, "DELETE FROM mod_kinds WHERE realm = ? AND kind = ? AND status = 'deny'", kind)
    this.run(
      realm,
      "INSERT OR IGNORE INTO mod_kinds (realm, kind, status) VALUES (?, ?, 'allow')",
      kind,
    )
  }
  disallowKind(realm: string | null, kind: number) {
    this.run(realm, "DELETE FROM mod_kinds WHERE realm = ? AND kind = ? AND status = 'allow'", kind)
    this.run(
      realm,
      "INSERT OR IGNORE INTO mod_kinds (realm, kind, status) VALUES (?, ?, 'deny')",
      kind,
    )
  }
  listAllowedKinds(realm: string | null) {
    return [...this.snapshot(realm).allowedKinds].sort((a, b) => a - b)
  }
  listDisallowedKinds(realm: string | null) {
    return [...this.snapshot(realm).disallowedKinds].sort((a, b) => a - b)
  }
  blockIp(realm: string | null, ip: string, reason = '') {
    this.run(
      realm,
      'INSERT OR REPLACE INTO mod_ips (realm, ip, reason) VALUES (?, ?, ?)',
      ip,
      reason,
    )
  }
  unblockIp(realm: string | null, ip: string) {
    this.run(realm, 'DELETE FROM mod_ips WHERE realm = ? AND ip = ?', ip)
  }
  listBlockedIps(realm: string | null) {
    return this.db.query('SELECT ip, reason FROM mod_ips WHERE realm = ?').all(realmKey(realm)) as {
      ip: string
      reason: string
    }[]
  }
  setInfo(realm: string | null, key: 'name' | 'description' | 'icon', value: string) {
    this.run(
      realm,
      'INSERT OR REPLACE INTO relay_meta (realm, key, value) VALUES (?, ?, ?)',
      key,
      value,
    )
  }
}
