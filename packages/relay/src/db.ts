import { Database } from 'bun:sqlite'

/** Ordered migrations; index + 1 = schema version stored in PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    turn_secret TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    blossom_quota_bytes INTEGER NOT NULL DEFAULT 0,
    plan TEXT NOT NULL DEFAULT 'free',
    turn_max_allocations INTEGER NOT NULL DEFAULT 0,
    turn_max_bps INTEGER NOT NULL DEFAULT 0,
    turn_monthly_bytes INTEGER NOT NULL DEFAULT 0,
    data_monthly_bytes INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE policies (realm TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT UNIQUE,
    username TEXT UNIQUE,
    password_hash TEXT,
    totp_secret TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE usage (
    app_id TEXT NOT NULL,
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, day, metric)
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    amount_sats INTEGER NOT NULL,
    duration_days INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE invoices (
    payment_hash TEXT PRIMARY KEY,
    bolt11 TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    plan_id INTEGER,
    amount_msat INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX invoices_pubkey ON invoices(pubkey);
  CREATE TABLE paid_pubkeys (
    pubkey TEXT PRIMARY KEY,
    plan_id INTEGER,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE TABLE bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('ip', 'pubkey')),
    value TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    created_by TEXT NOT NULL DEFAULT '',
    UNIQUE (type, value)
  );
  CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE blob_owners (
    sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sha256, scope, pubkey)
  );
  CREATE INDEX blob_owners_pubkey ON blob_owners(pubkey);
  CREATE TABLE alert_acks (id TEXT PRIMARY KEY, acked_at INTEGER NOT NULL, acked_by TEXT NOT NULL);
  `,
  // v2: fields used by the admin SPA (roles, app description, per-app Blossom limits)
  `
  ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE admins ADD COLUMN last_login_at INTEGER;
  ALTER TABLE apps ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE apps ADD COLUMN blossom_max_blob_bytes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE apps ADD COLUMN blossom_allowed_mime TEXT NOT NULL DEFAULT '[]';
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export class DowngradeError extends Error {}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  action: string
  target: string
  details: unknown
  ip: string
}

/** admin.db: apps, admins, sessions, policies, usage, payments, audit, bans, blobs, settings. */
export class AdminDb {
  readonly db: Database

  constructor(
    path: string,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    migrate(this.db)
  }

  get version(): number {
    return userVersion(this.db)
  }

  close() {
    this.db.close()
  }

  // ------------------------------------------------------------ settings (JSON values)

  getSetting<T>(key: string): T | undefined {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as {
      value: string
    } | null
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown) {
    if (value === undefined) {
      this.db.query('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this.db
      .query(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }

  // ------------------------------------------------------------ audit

  audit(actor: string, action: string, target = '', details: unknown = {}, ip = '') {
    this.db
      .query('INSERT INTO audit (at, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now(), actor, action, target, JSON.stringify(details ?? {}), ip)
  }

  auditLog(
    opts: { limit?: number; before?: number; actor?: string; action?: string } = {},
  ): AuditEntry[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.before) {
      where.push('id < ?')
      args.push(opts.before)
    }
    if (opts.actor) {
      where.push('actor = ?')
      args.push(opts.actor)
    }
    if (opts.action) {
      where.push('action LIKE ?')
      args.push(`${opts.action}%`)
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    args.push(Math.min(Math.max(opts.limit ?? 100, 1), 1000))
    const rows = this.db.query(sql).all(...args) as (Omit<AuditEntry, 'details'> & {
      details: string
    })[]
    return rows.map((r) => ({ ...r, details: JSON.parse(r.details) }))
  }

  // ------------------------------------------------------------ usage counters

  addUsage(appId: string, metric: string, value: number, at = this.now()) {
    if (!value) return
    const day = new Date(at * 1000).toISOString().slice(0, 10)
    this.db
      .query(
        'INSERT INTO usage (app_id, day, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, day, metric) DO UPDATE SET value = value + excluded.value',
      )
      .run(appId, day, metric, Math.round(value))
  }

  /** Sum of a metric since the start of the current UTC month. */
  monthUsage(appId: string, metrics: string[], at = this.now()): number {
    const month = new Date(at * 1000).toISOString().slice(0, 7)
    const ph = metrics.map(() => '?').join(',')
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(value), 0) AS v FROM usage WHERE app_id = ? AND day >= ? AND metric IN (${ph})`,
      )
      .get(appId, `${month}-01`, ...metrics) as { v: number }
    return row.v
  }

  usage(appId: string, days = 30): { day: string; metric: string; value: number }[] {
    const from = new Date((this.now() - days * 86400) * 1000).toISOString().slice(0, 10)
    return this.db
      .query(
        'SELECT day, metric, value FROM usage WHERE app_id = ? AND day >= ? ORDER BY day, metric',
      )
      .all(appId, from) as { day: string; metric: string; value: number }[]
  }
}

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

/** Run pending migrations; refuse to open a database written by a newer relay. */
export function migrate(db: Database, migrations: string[] = MIGRATIONS) {
  const current = userVersion(db)
  if (current > migrations.length) {
    throw new DowngradeError(
      `database schema v${current} is newer than this relay (v${migrations.length}); refusing to downgrade`,
    )
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v] as string)
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
}
