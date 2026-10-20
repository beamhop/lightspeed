import type { AdminDb } from './db'
import {
  base32Encode,
  isHex64,
  randomBytes,
  randomHex,
  safeEqual,
  sha256Hex,
  tagValue,
  totpUri,
  verifyEvent,
  verifyTotp,
} from './util/crypto'
import { HttpError, parseCookies } from './util/http'

export const SESSION_COOKIE = 'bh_admin'
export const LOGIN_KIND = 27235
const CHALLENGE_TTL = 300
const LOGIN_SKEW = 120

export interface Admin {
  id: number
  pubkey: string | null
  username: string | null
  hasTotp: boolean
  createdAt: number
  createdBy: string
}

export interface Session {
  id: string
  adminId: number
  method: string
  ip: string
  userAgent: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
}

interface AdminRow {
  id: number
  pubkey: string | null
  username: string | null
  password_hash: string | null
  totp_secret: string | null
  totp_last_step: number
  created_at: number
  created_by: string
}

const adminFromRow = (r: AdminRow): Admin => ({
  id: r.id,
  pubkey: r.pubkey,
  username: r.username,
  hasTotp: !!r.totp_secret,
  createdAt: r.created_at,
  createdBy: r.created_by,
})

/** Audit actor string for an admin: `pubkey:<hex>` or `user:<name>`. */
export const actorOf = (a: Admin) => (a.pubkey ? `pubkey:${a.pubkey}` : `user:${a.username}`)

export interface NewAdminResult {
  admin: Admin
  /** Present for password admins: base32 TOTP secret + otpauth URI, shown once. */
  totp?: { secret: string; uri: string }
}

const USERNAME_RE = /^[a-zA-Z0-9_.@-]{2,64}$/

export class AdminAuth {
  private challenges = new Map<string, number>()

  constructor(
    private adb: AdminDb,
    private opts: { sessionTtlSec: number; nowMs?: () => number } = { sessionTtlSec: 7 * 86400 },
  ) {}

  private now() {
    return this.adb.now()
  }

  private nowMs() {
    return this.opts.nowMs ? this.opts.nowMs() : this.adb.now() * 1000
  }

  // ------------------------------------------------------------ admins

  adminCount(): number {
    return (this.adb.db.query('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n
  }

  listAdmins(): Admin[] {
    return (this.adb.db.query('SELECT * FROM admins ORDER BY id').all() as AdminRow[]).map(
      adminFromRow,
    )
  }

  getAdmin(id: number): Admin | null {
    const r = this.adb.db.query('SELECT * FROM admins WHERE id = ?').get(id) as AdminRow | null
    return r ? adminFromRow(r) : null
  }

  async createAdmin(
    input: { pubkey?: unknown; username?: unknown; password?: unknown },
    by: string,
  ): Promise<NewAdminResult> {
    const t = this.now()
    if (input.pubkey !== undefined && input.pubkey !== null && input.pubkey !== '') {
      const pubkey = String(input.pubkey).toLowerCase()
      if (!isHex64(pubkey)) throw new HttpError(400, 'invalid', 'pubkey must be 64 hex chars')
      if (this.adb.db.query('SELECT 1 FROM admins WHERE pubkey = ?').get(pubkey))
        throw new HttpError(409, 'exists', 'admin already exists')
      const r = this.adb.db
        .query('INSERT INTO admins (pubkey, created_at, created_by) VALUES (?, ?, ?)')
        .run(pubkey, t, by)
      return { admin: this.getAdmin(Number(r.lastInsertRowid)) as Admin }
    }
    const username = String(input.username ?? '')
    const password = String(input.password ?? '')
    if (!USERNAME_RE.test(username))
      throw new HttpError(400, 'invalid', 'username must be 2-64 chars of [a-zA-Z0-9_.@-]')
    if (password.length < 10)
      throw new HttpError(400, 'invalid', 'password must be at least 10 characters')
    if (this.adb.db.query('SELECT 1 FROM admins WHERE username = ?').get(username))
      throw new HttpError(409, 'exists', 'admin already exists')
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    const secret = base32Encode(randomBytes(20))
    const r = this.adb.db
      .query(
        'INSERT INTO admins (username, password_hash, totp_secret, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
      )
      .run(username, hash, secret, t, by)
    return {
      admin: this.getAdmin(Number(r.lastInsertRowid)) as Admin,
      totp: { secret, uri: totpUri(secret, username) },
    }
  }

  deleteAdmin(id: number): Admin {
    const a = this.getAdmin(id)
    if (!a) throw new HttpError(404, 'not-found', 'admin not found')
    if (this.adminCount() <= 1)
      throw new HttpError(409, 'last-admin', 'cannot remove the last admin')
    this.adb.db.query('DELETE FROM sessions WHERE admin_id = ?').run(id)
    this.adb.db.query('DELETE FROM admins WHERE id = ?').run(id)
    return a
  }

  resetTotp(id: number): { secret: string; uri: string } {
    const a = this.getAdmin(id)
    if (!a?.username) throw new HttpError(404, 'not-found', 'password admin not found')
    const secret = base32Encode(randomBytes(20))
    this.adb.db
      .query('UPDATE admins SET totp_secret = ?, totp_last_step = 0 WHERE id = ?')
      .run(secret, id)
    this.adb.db.query('DELETE FROM sessions WHERE admin_id = ?').run(id)
    return { secret, uri: totpUri(secret, a.username) }
  }

  // ------------------------------------------------------------ bootstrap

  /**
   * When no admin exists and no token is pending, mint a bootstrap token (stored hashed) and
   * return it so the caller can print it. Returns null otherwise.
   */
  ensureBootstrapToken(): string | null {
    if (this.adminCount() > 0) return null
    if (this.adb.getSetting<string>('bootstrap_token_hash')) return null
    return this.regenerateBootstrapToken()
  }

  regenerateBootstrapToken(): string {
    if (this.adminCount() > 0) throw new HttpError(409, 'claimed', 'relay already has an admin')
    const token = `bht_${randomHex(20)}`
    this.adb.setSetting('bootstrap_token_hash', sha256Hex(token))
    return token
  }

  bootstrapPending(): boolean {
    return this.adminCount() === 0 && !!this.adb.getSetting<string>('bootstrap_token_hash')
  }

  async bootstrap(input: {
    token?: unknown
    pubkey?: unknown
    username?: unknown
    password?: unknown
  }): Promise<NewAdminResult> {
    if (this.adminCount() > 0) throw new HttpError(409, 'claimed', 'relay already has an admin')
    const stored = this.adb.getSetting<string>('bootstrap_token_hash')
    if (!stored || typeof input.token !== 'string' || !safeEqual(stored, sha256Hex(input.token))) {
      throw new HttpError(401, 'bad-token', 'invalid bootstrap token')
    }
    const res = await this.createAdmin(input, 'bootstrap')
    this.adb.setSetting('bootstrap_token_hash', undefined)
    return res
  }

  // ------------------------------------------------------------ nostr login

  challenge(): string {
    const t = this.now()
    for (const [c, exp] of this.challenges) if (exp <= t) this.challenges.delete(c)
    if (this.challenges.size > 10_000)
      throw new HttpError(429, 'rate-limited', 'too many pending challenges')
    const c = randomHex(32)
    this.challenges.set(c, t + CHALLENGE_TTL)
    return c
  }

  /** Verify a kind 27235 event carrying a challenge (tag `challenge` or content) from an allowlisted pubkey. */
  loginNostr(event: unknown): Admin {
    if (!verifyEvent(event)) throw new HttpError(401, 'bad-event', 'invalid or unsigned event')
    if (event.kind !== LOGIN_KIND)
      throw new HttpError(401, 'bad-event', `event kind must be ${LOGIN_KIND}`)
    if (Math.abs(event.created_at - this.now()) > LOGIN_SKEW)
      throw new HttpError(401, 'stale', 'event created_at too far from now')
    const c = tagValue(event, 'challenge') ?? event.content
    const exp = this.challenges.get(c)
    if (!exp || exp <= this.now())
      throw new HttpError(401, 'bad-challenge', 'unknown or expired challenge')
    this.challenges.delete(c)
    const row = this.adb.db
      .query('SELECT * FROM admins WHERE pubkey = ?')
      .get(event.pubkey) as AdminRow | null
    if (!row) throw new HttpError(403, 'not-admin', 'pubkey is not an admin')
    return adminFromRow(row)
  }

  // ------------------------------------------------------------ password + TOTP

  async loginPassword(input: {
    username?: unknown
    password?: unknown
    totp?: unknown
  }): Promise<Admin> {
    const fail = () =>
      new HttpError(401, 'bad-credentials', 'invalid username, password or TOTP code')
    if (typeof input.username !== 'string' || typeof input.password !== 'string') throw fail()
    const row = this.adb.db
      .query('SELECT * FROM admins WHERE username = ?')
      .get(input.username) as AdminRow | null
    if (!row?.password_hash) {
      // Spend comparable time so usernames cannot be probed by latency.
      await Bun.password
        .verify(
          input.password,
          '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWg',
        )
        .catch(() => false)
      throw fail()
    }
    const ok = await Bun.password.verify(input.password, row.password_hash)
    if (!ok) throw fail()
    if (row.totp_secret) {
      const step = verifyTotp(row.totp_secret, String(input.totp ?? ''), this.nowMs())
      if (step === null || step <= row.totp_last_step) throw fail()
      this.adb.db.query('UPDATE admins SET totp_last_step = ? WHERE id = ?').run(step, row.id)
    }
    return adminFromRow(row)
  }

  async changePassword(id: number, password: string) {
    if (password.length < 10)
      throw new HttpError(400, 'invalid', 'password must be at least 10 characters')
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    this.adb.db
      .query('UPDATE admins SET password_hash = ? WHERE id = ? AND username IS NOT NULL')
      .run(hash, id)
  }

  // ------------------------------------------------------------ sessions

  createSession(
    admin: Admin,
    method: string,
    ip: string,
    userAgent: string,
  ): { token: string; session: Session } {
    const token = randomHex(32)
    const id = randomHex(8)
    const t = this.now()
    this.adb.db
      .query(
        `INSERT INTO sessions (id, token_hash, admin_id, method, ip, user_agent, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256Hex(token),
        admin.id,
        method,
        ip,
        userAgent.slice(0, 300),
        t,
        t + this.opts.sessionTtlSec,
        t,
      )
    return { token, session: this.getSession(id) as Session }
  }

  private getSession(id: string): Session | null {
    const r = this.adb.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Record<
      string,
      never
    > | null
    return r ? sessionFromRow(r) : null
  }

  /** Resolve the session cookie of a request. Expired sessions are deleted. */
  authenticate(req: Request): { session: Session; admin: Admin } | null {
    const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE]
    if (!token) return null
    const r = this.adb.db
      .query('SELECT * FROM sessions WHERE token_hash = ?')
      .get(sha256Hex(token)) as Record<string, never> | null
    if (!r) return null
    const session = sessionFromRow(r)
    const t = this.now()
    if (session.expiresAt <= t) {
      this.adb.db.query('DELETE FROM sessions WHERE id = ?').run(session.id)
      return null
    }
    const admin = this.getAdmin(session.adminId)
    if (!admin) return null
    if (t - session.lastSeenAt > 60)
      this.adb.db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(t, session.id)
    return { session, admin }
  }

  listSessions(): (Session & { admin: string })[] {
    const t = this.now()
    this.adb.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(t)
    const rows = this.adb.db
      .query(
        `SELECT s.*, COALESCE(a.username, a.pubkey) AS admin FROM sessions s JOIN admins a ON a.id = s.admin_id ORDER BY s.created_at DESC`,
      )
      .all() as (Record<string, never> & { admin: string })[]
    return rows.map((r) => ({ ...sessionFromRow(r), admin: r.admin }))
  }

  revokeSession(id: string): boolean {
    return this.adb.db.query('DELETE FROM sessions WHERE id = ?').run(id).changes > 0
  }

  cookie(token: string, opts: { secure: boolean; clear?: boolean }): string {
    const parts = [
      `${SESSION_COOKIE}=${opts.clear ? '' : token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${opts.clear ? 0 : this.opts.sessionTtlSec}`,
    ]
    if (opts.secure) parts.push('Secure')
    return parts.join('; ')
  }
}

function sessionFromRow(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    adminId: r.admin_id as number,
    method: r.method as string,
    ip: r.ip as string,
    userAgent: r.user_agent as string,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
    lastSeenAt: r.last_seen_at as number,
  }
}
