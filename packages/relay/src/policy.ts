import type { AdminDb } from './db'
import type { Policy, PolicyProvider, RateLimit, RetentionRule } from './engines'
import { HttpError } from './util/http'

export const GLOBAL_REALM = '_global'

/** Policy document as stored in admin.db (Policy minus the hook, plus relay-level switches). */
export type StoredPolicy = Omit<Policy, 'writeAllowed'> & {
  /** Writes need a paid plan (Lightning payments). Global default: payments.required. */
  requirePayment?: boolean
}

export interface Ban {
  id: number
  type: 'ip' | 'pubkey'
  value: string
  reason: string
  createdAt: number
  expiresAt: number | null
  createdBy: string
}

export class BanStore {
  private ips = new Set<string>()
  private pubkeys = new Set<string>()
  private loadedAt = 0

  constructor(private adb: AdminDb) {
    this.reload()
  }

  reload() {
    const now = this.adb.now()
    this.ips.clear()
    this.pubkeys.clear()
    for (const b of this.list()) {
      if (b.expiresAt && b.expiresAt <= now) continue
      ;(b.type === 'ip' ? this.ips : this.pubkeys).add(b.value)
    }
    this.loadedAt = now
  }

  private fresh() {
    // Cheap expiry handling: rebuild the sets once a minute.
    if (this.adb.now() - this.loadedAt > 60) this.reload()
  }

  list(): Ban[] {
    const rows = this.adb.db.query('SELECT * FROM bans ORDER BY id DESC').all() as {
      id: number
      type: 'ip' | 'pubkey'
      value: string
      reason: string
      created_at: number
      expires_at: number | null
      created_by: string
    }[]
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      value: r.value,
      reason: r.reason,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      createdBy: r.created_by,
    }))
  }

  add(
    input: { type: unknown; value: unknown; reason?: unknown; expiresAt?: unknown },
    by: string,
  ): Ban {
    const type = input.type
    if (type !== 'ip' && type !== 'pubkey')
      throw new HttpError(400, 'invalid', "type must be 'ip' or 'pubkey'")
    const value = String(input.value ?? '')
      .trim()
      .toLowerCase()
    if (!value) throw new HttpError(400, 'invalid', 'value is required')
    if (type === 'pubkey' && !/^[0-9a-f]{64}$/.test(value))
      throw new HttpError(400, 'invalid', 'pubkey must be 64 hex chars')
    const expires = input.expiresAt == null ? null : Number(input.expiresAt)
    this.adb.db
      .query(
        `INSERT INTO bans (type, value, reason, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, value) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at`,
      )
      .run(type, value, String(input.reason ?? ''), this.adb.now(), expires, by)
    this.reload()
    return this.list().find((b) => b.type === type && b.value === value) as Ban
  }

  remove(id: number): Ban | null {
    const ban = this.list().find((b) => b.id === id) ?? null
    this.adb.db.query('DELETE FROM bans WHERE id = ?').run(id)
    this.reload()
    return ban
  }

  ipBanned(ip: string): boolean {
    this.fresh()
    return this.ips.has(ip.toLowerCase())
  }

  pubkeyBanned(pubkey: string): boolean {
    this.fresh()
    return this.pubkeys.has(pubkey.toLowerCase())
  }

  bannedPubkeys(): string[] {
    this.fresh()
    return [...this.pubkeys]
  }
}

const numArr = (v: unknown, key: string): number[] | undefined => {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x)))
    throw new HttpError(400, 'invalid', `${key} must be an integer list`)
  return v as number[]
}
const strArr = (v: unknown, key: string): string[] | undefined => {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new HttpError(400, 'invalid', `${key} must be a string list`)
  return (v as string[]).map((s) => s.toLowerCase())
}
const num = (v: unknown, key: string): number | undefined => {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0)
    throw new HttpError(400, 'invalid', `${key} must be a number >= 0`)
  return n
}
const rate = (v: unknown, key: string): RateLimit | undefined => {
  if (v === undefined || v === null) return undefined
  const o = v as Record<string, unknown>
  const count = num(o.count, `${key}.count`)
  const windowSec = num(o.windowSec, `${key}.windowSec`)
  if (count === undefined || windowSec === undefined)
    throw new HttpError(400, 'invalid', `${key} needs count and windowSec`)
  return { count, windowSec }
}

/** Validate a policy document from the admin API. Unknown keys are dropped. */
export function sanitizePolicy(input: unknown): StoredPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, 'invalid', 'policy must be an object')
  const p = input as Record<string, unknown>
  const out: StoredPolicy = {}
  if (p.pubkeys) {
    const o = p.pubkeys as Record<string, unknown>
    out.pubkeys = { allow: strArr(o.allow, 'pubkeys.allow'), deny: strArr(o.deny, 'pubkeys.deny') }
  }
  if (p.kinds) {
    const o = p.kinds as Record<string, unknown>
    out.kinds = { allow: numArr(o.allow, 'kinds.allow'), deny: numArr(o.deny, 'kinds.deny') }
  }
  if (p.rateLimits) {
    const o = p.rateLimits as Record<string, unknown>
    out.rateLimits = {
      perIp: rate(o.perIp, 'rateLimits.perIp'),
      perPubkey: rate(o.perPubkey, 'rateLimits.perPubkey'),
    }
  }
  if (p.maxEventSize !== undefined) out.maxEventSize = num(p.maxEventSize, 'maxEventSize')
  if (p.minPow !== undefined) out.minPow = num(p.minPow, 'minPow')
  if (p.authRequiredKinds !== undefined)
    out.authRequiredKinds = numArr(p.authRequiredKinds, 'authRequiredKinds')
  if (p.retention !== undefined) {
    if (!Array.isArray(p.retention)) throw new HttpError(400, 'invalid', 'retention must be a list')
    out.retention = p.retention.map(
      (r: Record<string, unknown>, i): RetentionRule => ({
        kinds: numArr(r.kinds, `retention[${i}].kinds`),
        maxAgeSec: num(r.maxAgeSec, `retention[${i}].maxAgeSec`),
        maxCount: num(r.maxCount, `retention[${i}].maxCount`),
      }),
    )
  }
  if (p.requirePayment !== undefined) out.requirePayment = !!p.requirePayment
  return JSON.parse(JSON.stringify(out)) as StoredPolicy
}

/**
 * PolicyProvider handed to the Nostr engine. Rules are data in admin.db, cached and hot-reloaded on
 * every PUT. Bans are merged into `pubkeys.deny`; payments plug in through `writeAllowed`.
 */
export class PolicyStore implements PolicyProvider {
  private cache = new Map<string, Policy>()

  constructor(
    private adb: AdminDb,
    private bans: BanStore,
    private opts: { paymentsRequired: () => boolean; isPaid: (pubkey: string) => boolean },
  ) {}

  stored(realm: string): StoredPolicy | null {
    const row = this.adb.db.query('SELECT policy FROM policies WHERE realm = ?').get(realm) as {
      policy: string
    } | null
    return row ? (JSON.parse(row.policy) as StoredPolicy) : null
  }

  put(realm: string, policy: StoredPolicy) {
    this.adb.db
      .query(
        'INSERT INTO policies (realm, policy, updated_at) VALUES (?, ?, ?) ON CONFLICT(realm) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at',
      )
      .run(realm, JSON.stringify(policy), this.adb.now())
    this.invalidate()
  }

  invalidate() {
    this.cache.clear()
  }

  get(realm: string | null): Policy {
    const key = realm ?? GLOBAL_REALM
    const hit = this.cache.get(key)
    if (hit) return hit
    const stored = this.stored(key) ?? {}
    const { requirePayment, ...rules } = stored
    const banned = this.bans.bannedPubkeys()
    const deny = [...new Set([...(rules.pubkeys?.deny ?? []), ...banned])]
    const needsPayment =
      requirePayment ?? (key === GLOBAL_REALM ? this.opts.paymentsRequired() : false)
    const policy: Policy = {
      ...rules,
      pubkeys: { ...rules.pubkeys, deny },
      writeAllowed: (pubkey: string) => {
        if (this.bans.pubkeyBanned(pubkey)) return false
        if (needsPayment) return this.opts.isPaid(pubkey)
        return true
      },
    }
    this.cache.set(key, policy)
    return policy
  }
}
