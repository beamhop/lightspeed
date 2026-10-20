import type { AdminDb } from './db'
import { randomHex, safeEqual, sha256Hex } from './util/crypto'
import { HttpError } from './util/http'

export interface AppRecord {
  id: string
  name: string
  turnSecret: string
  apiKeyPrefix: string
  blossomQuotaBytes: number
  plan: string
  turnMaxAllocations: number
  turnMaxBps: number
  turnMonthlyBytes: number
  dataMonthlyBytes: number
  disabled: boolean
  createdAt: number
  updatedAt: number
}

interface AppRow {
  id: string
  name: string
  turn_secret: string
  api_key_hash: string
  api_key_prefix: string
  blossom_quota_bytes: number
  plan: string
  turn_max_allocations: number
  turn_max_bps: number
  turn_monthly_bytes: number
  data_monthly_bytes: number
  disabled: number
  created_at: number
  updated_at: number
}

export const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** Fields an admin may PATCH. */
export const APP_EDITABLE = {
  name: 'name',
  blossomQuotaBytes: 'blossom_quota_bytes',
  plan: 'plan',
  turnMaxAllocations: 'turn_max_allocations',
  turnMaxBps: 'turn_max_bps',
  turnMonthlyBytes: 'turn_monthly_bytes',
  dataMonthlyBytes: 'data_monthly_bytes',
  disabled: 'disabled',
} as const

function fromRow(r: AppRow): AppRecord {
  return {
    id: r.id,
    name: r.name,
    turnSecret: r.turn_secret,
    apiKeyPrefix: r.api_key_prefix,
    blossomQuotaBytes: r.blossom_quota_bytes,
    plan: r.plan,
    turnMaxAllocations: r.turn_max_allocations,
    turnMaxBps: r.turn_max_bps,
    turnMonthlyBytes: r.turn_monthly_bytes,
    dataMonthlyBytes: r.data_monthly_bytes,
    disabled: !!r.disabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const newApiKey = () => `bhk_${randomHex(24)}`
const newTurnSecret = () => randomHex(32)

/** App (realm) records with an in-memory cache for the hot paths (TURN, data relay). */
export class AppStore {
  private cache = new Map<string, AppRecord | null>()

  constructor(
    private adb: AdminDb,
    private defaults: { blossomQuotaBytes: number } = { blossomQuotaBytes: 0 },
  ) {}

  private invalidate(id?: string) {
    if (id) this.cache.delete(id)
    else this.cache.clear()
  }

  get(id: string): AppRecord | null {
    if (this.cache.has(id)) return this.cache.get(id) ?? null
    const row = this.adb.db.query('SELECT * FROM apps WHERE id = ?').get(id) as AppRow | null
    const app = row ? fromRow(row) : null
    this.cache.set(id, app)
    return app
  }

  /** An app that exists and is not disabled. */
  active(id: string): AppRecord | null {
    const a = this.get(id)
    return a && !a.disabled ? a : null
  }

  list(): AppRecord[] {
    return (this.adb.db.query('SELECT * FROM apps ORDER BY created_at, id').all() as AppRow[]).map(
      fromRow,
    )
  }

  count(): number {
    return (this.adb.db.query('SELECT COUNT(*) AS n FROM apps').get() as { n: number }).n
  }

  /** Create an app. Returns the record and the plaintext API key (shown once). */
  create(
    input: { id?: string; name: string } & Partial<Record<keyof typeof APP_EDITABLE, unknown>>,
  ): {
    app: AppRecord
    apiKey: string
  } {
    const name = String(input.name ?? '').trim()
    if (!name) throw new HttpError(400, 'invalid', 'name is required')
    let id = input.id ? String(input.id) : slugify(name)
    if (!APP_ID_RE.test(id)) {
      if (input.id) throw new HttpError(400, 'invalid', 'id must match [a-z0-9][a-z0-9_-]{0,62}')
      id = randomHex(4)
    }
    if (this.get(id)) {
      if (input.id) throw new HttpError(409, 'exists', `app ${id} already exists`)
      id = `${id.slice(0, 54)}-${randomHex(3)}`
    }
    const apiKey = newApiKey()
    const t = this.adb.now()
    this.adb.db
      .query(
        `INSERT INTO apps (id, name, turn_secret, api_key_hash, api_key_prefix, blossom_quota_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        newTurnSecret(),
        sha256Hex(apiKey),
        apiKey.slice(0, 10),
        this.defaults.blossomQuotaBytes,
        t,
        t,
      )
    this.invalidate(id)
    const { name: _n, id: _i, ...rest } = input
    const app = Object.keys(rest).length ? this.update(id, rest) : (this.get(id) as AppRecord)
    return { app, apiKey }
  }

  update(id: string, patch: Record<string, unknown>): AppRecord {
    if (!this.get(id)) throw new HttpError(404, 'not-found', `app ${id} not found`)
    const sets: string[] = []
    const args: (string | number)[] = []
    for (const [k, v] of Object.entries(patch)) {
      const col = APP_EDITABLE[k as keyof typeof APP_EDITABLE]
      if (!col) continue
      if (k === 'name' || k === 'plan') {
        const s = String(v ?? '').trim()
        if (!s) throw new HttpError(400, 'invalid', `${k} must be a non-empty string`)
        args.push(s)
      } else if (k === 'disabled') {
        args.push(v ? 1 : 0)
      } else {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0)
          throw new HttpError(400, 'invalid', `${k} must be a number >= 0`)
        args.push(Math.floor(n))
      }
      sets.push(`${col} = ?`)
    }
    if (sets.length) {
      sets.push('updated_at = ?')
      args.push(this.adb.now(), id)
      this.adb.db.query(`UPDATE apps SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      this.invalidate(id)
    }
    return this.get(id) as AppRecord
  }

  delete(id: string): boolean {
    const r = this.adb.db.query('DELETE FROM apps WHERE id = ?').run(id)
    this.adb.db.query('DELETE FROM policies WHERE realm = ?').run(id)
    this.invalidate(id)
    return r.changes > 0
  }

  rotateTurnSecret(id: string): AppRecord {
    if (!this.get(id)) throw new HttpError(404, 'not-found', `app ${id} not found`)
    this.adb.db
      .query('UPDATE apps SET turn_secret = ?, updated_at = ? WHERE id = ?')
      .run(newTurnSecret(), this.adb.now(), id)
    this.invalidate(id)
    return this.get(id) as AppRecord
  }

  rotateApiKey(id: string): { app: AppRecord; apiKey: string } {
    if (!this.get(id)) throw new HttpError(404, 'not-found', `app ${id} not found`)
    const apiKey = newApiKey()
    this.adb.db
      .query('UPDATE apps SET api_key_hash = ?, api_key_prefix = ?, updated_at = ? WHERE id = ?')
      .run(sha256Hex(apiKey), apiKey.slice(0, 10), this.adb.now(), id)
    this.invalidate(id)
    return { app: this.get(id) as AppRecord, apiKey }
  }

  verifyApiKey(id: string, apiKey: string): boolean {
    const row = this.adb.db.query('SELECT api_key_hash FROM apps WHERE id = ?').get(id) as {
      api_key_hash: string
    } | null
    return !!row && safeEqual(row.api_key_hash, sha256Hex(apiKey))
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** Public view for the admin API (no secrets except the TURN secret admins need for self-minting). */
export function appView(app: AppRecord, opts: { secret?: boolean } = {}) {
  const { turnSecret, ...rest } = app
  return opts.secret ? { ...rest, turnSecret } : rest
}
