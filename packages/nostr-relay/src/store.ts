import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { dTag, expiration, isAddressable, isReplaceable } from './event'
import { searchWords, tagFilters } from './filter'
import type { Filter, NostrEvent, RetentionRule } from './types'

/** Realm key in the database: '' is the public relay. */
export const realmKey = (realm: string | null | undefined) => realm ?? ''

const MIGRATIONS: string[] = [
  // v1: events, tags, FTS5, moderation
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    realm TEXT NOT NULL,
    id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    d_tag TEXT,
    expires_at INTEGER,
    raw TEXT NOT NULL
  );
  CREATE UNIQUE INDEX events_realm_id ON events(realm, id);
  -- negentropy id/time index (and default ordering)
  CREATE INDEX events_realm_time_id ON events(realm, created_at, id);
  CREATE INDEX events_realm_pubkey_kind ON events(realm, pubkey, kind, created_at);
  CREATE INDEX events_realm_kind ON events(realm, kind, created_at);
  CREATE INDEX events_addr ON events(realm, kind, pubkey, d_tag) WHERE d_tag IS NOT NULL;
  CREATE INDEX events_expires ON events(expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE tags (
    seq INTEGER NOT NULL,
    realm TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX tags_lookup ON tags(realm, name, value, created_at);
  CREATE INDEX tags_seq ON tags(seq);
  CREATE VIRTUAL TABLE events_fts USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE mod_pubkeys (
    realm TEXT NOT NULL, pubkey TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (realm, pubkey, status)
  );
  CREATE TABLE mod_events (
    realm TEXT NOT NULL, id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (realm, id)
  );
  CREATE TABLE mod_kinds (
    realm TEXT NOT NULL, kind INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (realm, kind, status)
  );
  CREATE TABLE mod_ips (
    realm TEXT NOT NULL, ip TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (realm, ip)
  );
  CREATE TABLE relay_meta (
    realm TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (realm, key)
  );
  `,
]

export interface InsertResult {
  ok: boolean
  message: string
  /** True when the event was actually written. */
  stored: boolean
}

export interface QueryOptions {
  /** Kinds removed from results (e.g. auth-required kinds for unauthenticated readers). */
  excludeKinds?: number[]
  /** Hard cap for `limit`. */
  maxLimit?: number
  /** Limit used when a filter has none. */
  defaultLimit?: number
}

interface Row {
  seq: number
  raw: string
}

/** Builds `WHERE` SQL for one filter. Returns null when the filter can match nothing. */
function filterWhere(
  f: Filter,
  realm: string,
  now: number,
  opts: QueryOptions,
): { sql: string; params: SQLQueryBindings[]; search: string | null } | null {
  const where: string[] = ['e.realm = ?', '(e.expires_at IS NULL OR e.expires_at > ?)']
  const params: SQLQueryBindings[] = [realm, now]
  const inList = (col: string, vals: readonly (string | number)[]) => {
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`)
    params.push(...vals)
  }
  if (f.ids) {
    if (f.ids.length === 0) return null
    inList('e.id', f.ids)
  }
  if (f.authors) {
    if (f.authors.length === 0) return null
    inList('e.pubkey', f.authors)
  }
  if (f.kinds) {
    if (f.kinds.length === 0) return null
    inList('e.kind', f.kinds)
  }
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    where.push(`e.kind NOT IN (${opts.excludeKinds.map(() => '?').join(',')})`)
    params.push(...opts.excludeKinds)
  }
  if (f.since !== undefined) {
    where.push('e.created_at >= ?')
    params.push(f.since)
  }
  if (f.until !== undefined) {
    where.push('e.created_at <= ?')
    params.push(f.until)
  }
  for (const [name, values] of tagFilters(f)) {
    if (values.length === 0) return null
    where.push(
      `e.seq IN (SELECT t.seq FROM tags t WHERE t.realm = ? AND t.name = ? AND t.value IN (${values
        .map(() => '?')
        .join(',')}))`,
    )
    params.push(realm, name, ...values)
  }
  let search: string | null = null
  if (f.search !== undefined) {
    const words = searchWords(f.search)
    if (words.length > 0) search = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(' ')
  }
  return { sql: where.join(' AND '), params, search }
}

export class EventStore {
  readonly db: Database
  private stmt: Record<string, ReturnType<Database['query']>> = {}

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: false })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
    const q = (name: string, sql: string) => {
      this.stmt[name] = this.db.query(sql)
    }
    q('exists', 'SELECT seq FROM events WHERE realm = ? AND id = ?')
    q(
      'insert',
      'INSERT INTO events (realm, id, pubkey, kind, created_at, d_tag, expires_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    q('insertTag', 'INSERT INTO tags (seq, realm, name, value, created_at) VALUES (?, ?, ?, ?, ?)')
    q('insertFts', 'INSERT INTO events_fts (rowid, content) VALUES (?, ?)')
    q('delEvent', 'DELETE FROM events WHERE seq = ?')
    q('delTags', 'DELETE FROM tags WHERE seq = ?')
    q('delFts', 'DELETE FROM events_fts WHERE rowid = ?')
    q(
      'replaceable',
      'SELECT seq, id, created_at FROM events WHERE realm = ? AND pubkey = ? AND kind = ? AND d_tag IS NULL',
    )
    q(
      'addressable',
      'SELECT seq, id, created_at FROM events WHERE realm = ? AND pubkey = ? AND kind = ? AND d_tag = ?',
    )
    q(
      'deletedById',
      `SELECT 1 FROM tags t JOIN events e ON e.seq = t.seq
       WHERE t.realm = ? AND t.name = 'e' AND t.value = ? AND e.kind = 5 AND e.pubkey = ? LIMIT 1`,
    )
    q(
      'deletedByAddr',
      `SELECT 1 FROM tags t JOIN events e ON e.seq = t.seq
       WHERE t.realm = ? AND t.name = 'a' AND t.value = ? AND e.kind = 5 AND e.pubkey = ? AND e.created_at >= ? LIMIT 1`,
    )
    q('count', 'SELECT COUNT(*) AS n FROM events')
    q('expired', 'SELECT seq FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?')
    q('realms', 'SELECT DISTINCT realm FROM events')
  }

  private migrate() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    const row = this.db.query('SELECT MAX(version) AS v FROM migrations').get() as {
      v: number | null
    }
    const current = row.v ?? 0
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string)
        this.db
          .query('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
          .run(v + 1, Math.floor(Date.now() / 1000))
      })()
    }
  }

  get schemaVersion(): number {
    return (this.db.query('SELECT MAX(version) AS v FROM migrations').get() as { v: number }).v
  }

  private s(name: string) {
    return this.stmt[name] as ReturnType<Database['query']>
  }

  has(realm: string, id: string): boolean {
    return this.s('exists').get(realm, id) !== null
  }

  private deleteSeq(seq: number) {
    this.s('delEvent').run(seq)
    this.s('delTags').run(seq)
    this.s('delFts').run(seq)
  }

  deleteSeqs(seqs: number[]): number {
    if (seqs.length === 0) return 0
    this.db.transaction(() => {
      for (const s of seqs) this.deleteSeq(s)
    })()
    return seqs.length
  }

  /** Was this event deleted by a NIP-09 request from its author? */
  isDeleted(realm: string, e: NostrEvent): boolean {
    if (this.s('deletedById').get(realm, e.id, e.pubkey)) return true
    if (isAddressable(e.kind) || isReplaceable(e.kind)) {
      const addr = `${e.kind}:${e.pubkey}:${isAddressable(e.kind) ? dTag(e) : ''}`
      if (this.s('deletedByAddr').get(realm, addr, e.pubkey, e.created_at)) return true
    }
    return false
  }

  /** Stores a non-ephemeral event, applying replaceable/addressable and NIP-09 semantics. */
  insert(e: NostrEvent, realm: string): InsertResult {
    let result: InsertResult = { ok: true, message: '', stored: true }
    this.db.transaction(() => {
      if (this.has(realm, e.id)) {
        result = { ok: true, message: 'duplicate: already have this event', stored: false }
        return
      }
      if (e.kind !== 5 && this.isDeleted(realm, e)) {
        result = {
          ok: false,
          message: 'blocked: this event was deleted by its author',
          stored: false,
        }
        return
      }
      let d: string | null = null
      if (isReplaceable(e.kind) || isAddressable(e.kind)) {
        let existing: { seq: number; id: string; created_at: number }[]
        if (isAddressable(e.kind)) {
          d = dTag(e)
          existing = this.s('addressable').all(realm, e.pubkey, e.kind, d) as typeof existing
        } else {
          existing = this.s('replaceable').all(realm, e.pubkey, e.kind) as typeof existing
        }
        for (const old of existing) {
          if (old.created_at > e.created_at || (old.created_at === e.created_at && old.id < e.id)) {
            result = {
              ok: false,
              message: 'duplicate: have a newer version of this event',
              stored: false,
            }
            return
          }
        }
        for (const old of existing) this.deleteSeq(old.seq)
      }
      const raw = JSON.stringify(e)
      const info = this.s('insert').run(
        realm,
        e.id,
        e.pubkey,
        e.kind,
        e.created_at,
        d,
        expiration(e),
        raw,
      ) as { lastInsertRowid: number | bigint }
      const seq = Number(info.lastInsertRowid)
      for (const t of e.tags) {
        const name = t[0]
        const value = t[1]
        if (name !== undefined && name.length === 1 && value !== undefined && value.length <= 1024)
          this.s('insertTag').run(seq, realm, name, value, e.created_at)
      }
      if (e.content.length > 0) this.s('insertFts').run(seq, e.content)
      if (e.kind === 5) this.applyDeletion(e, realm)
    })()
    return result
  }

  /** NIP-09: remove events referenced by a kind 5 from the same author. */
  private applyDeletion(del: NostrEvent, realm: string) {
    const ids: string[] = []
    for (const t of del.tags) {
      if (t[0] === 'e' && t[1]) ids.push(t[1])
      else if (t[0] === 'a' && t[1]) {
        const [k, pk, ...rest] = t[1].split(':')
        const kind = Number(k)
        if (pk !== del.pubkey || !Number.isInteger(kind)) continue
        const d = rest.join(':')
        const rows = (
          isAddressable(kind)
            ? this.db
                .query(
                  'SELECT seq FROM events WHERE realm = ? AND kind = ? AND pubkey = ? AND d_tag = ? AND created_at <= ?',
                )
                .all(realm, kind, pk, d, del.created_at)
            : this.db
                .query(
                  'SELECT seq FROM events WHERE realm = ? AND kind = ? AND pubkey = ? AND created_at <= ?',
                )
                .all(realm, kind, pk, del.created_at)
        ) as { seq: number }[]
        for (const r of rows) this.deleteSeq(r.seq)
      }
    }
    if (ids.length > 0) {
      const rows = this.db
        .query(
          `SELECT seq FROM events WHERE realm = ? AND pubkey = ? AND kind != 5 AND id IN (${ids
            .map(() => '?')
            .join(',')})`,
        )
        .all(realm, del.pubkey, ...ids) as { seq: number }[]
      for (const r of rows) this.deleteSeq(r.seq)
    }
  }

  /** Delete by id regardless of author (admin / NIP-86 banevent). */
  deleteById(realm: string, id: string): boolean {
    const row = this.s('exists').get(realm, id) as { seq: number } | null
    if (!row) return false
    this.deleteSeqs([row.seq])
    return true
  }

  private rows(filters: Filter[], realm: string, opts: QueryOptions): Row[] {
    const now = Math.floor(Date.now() / 1000)
    const maxLimit = opts.maxLimit ?? 5000
    const out: Row[] = []
    const seen = new Set<number>()
    for (const f of filters) {
      const w = filterWhere(f, realm, now, opts)
      if (!w) continue
      const limit = Math.min(f.limit ?? opts.defaultLimit ?? maxLimit, maxLimit)
      if (limit === 0) continue
      let sql: string
      const params = [...w.params]
      if (w.search) {
        sql = `SELECT e.seq, e.raw FROM events e JOIN events_fts ON events_fts.rowid = e.seq
               WHERE events_fts MATCH ? AND ${w.sql} ORDER BY events_fts.rank LIMIT ?`
        params.unshift(w.search)
      } else {
        sql = `SELECT e.seq, e.raw FROM events e WHERE ${w.sql} ORDER BY e.created_at DESC, e.id ASC LIMIT ?`
      }
      params.push(limit)
      for (const r of this.db.query(sql).all(...params) as Row[]) {
        if (seen.has(r.seq)) continue
        seen.add(r.seq)
        out.push(r)
      }
    }
    return out
  }

  /** Raw JSON strings of matching events (newest first unless a search ranks them). */
  queryRaw(filters: Filter[], realm: string, opts: QueryOptions = {}): string[] {
    return this.rows(filters, realm, opts).map((r) => r.raw)
  }

  query(filters: Filter[], realm: string, opts: QueryOptions = {}): NostrEvent[] {
    const events = this.rows(filters, realm, opts).map((r) => JSON.parse(r.raw) as NostrEvent)
    if (!filters.some((f) => f.search) && filters.length > 1)
      events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    return events
  }

  count(filters: Filter[], realm: string, opts: QueryOptions = {}): number {
    const now = Math.floor(Date.now() / 1000)
    const parts: string[] = []
    const params: SQLQueryBindings[] = []
    for (const f of filters) {
      const w = filterWhere(f, realm, now, opts)
      if (!w) continue
      if (w.search) {
        parts.push(
          `SELECT e.seq FROM events e JOIN events_fts ON events_fts.rowid = e.seq WHERE events_fts MATCH ? AND ${w.sql}`,
        )
        params.push(w.search, ...w.params)
      } else {
        parts.push(`SELECT e.seq FROM events e WHERE ${w.sql}`)
        params.push(...w.params)
      }
    }
    if (parts.length === 0) return 0
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM (${parts.join(' UNION ')})`)
      .get(...params) as { n: number }
    return row.n
  }

  /** (created_at, id) pairs for NIP-77, at most `max` + 1 rows so callers can detect overflow. */
  negentropyItems(filter: Filter, realm: string, max: number, opts: QueryOptions = {}) {
    const now = Math.floor(Date.now() / 1000)
    const w = filterWhere({ ...filter, limit: undefined }, realm, now, opts)
    if (!w) return []
    const limit = Math.min(filter.limit ?? max + 1, max + 1)
    if (w.search) {
      return this.db
        .query(
          `SELECT e.created_at, e.id FROM events e JOIN events_fts ON events_fts.rowid = e.seq
           WHERE events_fts MATCH ? AND ${w.sql} LIMIT ?`,
        )
        .all(w.search, ...w.params, limit) as { created_at: number; id: string }[]
    }
    return this.db
      .query(
        `SELECT e.created_at, e.id FROM events e WHERE ${w.sql} ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(...w.params, limit) as { created_at: number; id: string }[]
  }

  totalEvents(): number {
    return (this.s('count').get() as { n: number }).n
  }

  realms(): string[] {
    return (this.s('realms').all() as { realm: string }[]).map((r) => r.realm)
  }

  /** NIP-40: delete expired events. */
  sweepExpired(now = Math.floor(Date.now() / 1000)): number {
    const rows = this.s('expired').all(now) as { seq: number }[]
    return this.deleteSeqs(rows.map((r) => r.seq))
  }

  /** Apply retention rules for one realm. */
  applyRetention(realm: string, rules: RetentionRule[], now = Math.floor(Date.now() / 1000)) {
    let deleted = 0
    for (const rule of rules) {
      const kindSql = rule.kinds?.length
        ? ` AND kind IN (${rule.kinds.map(() => '?').join(',')})`
        : ''
      const kinds = rule.kinds ?? []
      if (rule.maxAgeSeconds !== undefined) {
        const rows = this.db
          .query(`SELECT seq FROM events WHERE realm = ? AND created_at < ?${kindSql}`)
          .all(realm, now - rule.maxAgeSeconds, ...kinds) as { seq: number }[]
        deleted += this.deleteSeqs(rows.map((r) => r.seq))
      }
      if (rule.maxCount !== undefined) {
        const rows = this.db
          .query(
            `SELECT seq FROM events WHERE realm = ?${kindSql} ORDER BY created_at DESC, id ASC LIMIT -1 OFFSET ?`,
          )
          .all(realm, ...kinds, rule.maxCount) as { seq: number }[]
        deleted += this.deleteSeqs(rows.map((r) => r.seq))
      }
    }
    return deleted
  }

  backup(path: string) {
    this.db.query('VACUUM INTO ?').run(path)
  }

  close() {
    this.db.close()
  }
}
