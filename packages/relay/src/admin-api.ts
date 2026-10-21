import { parseTurnUsername } from '@beamhop/p2p/wire'
import { ackAlert } from './alerts'
import { appView } from './apps'
import { type Admin, actorOf, type Session } from './auth'
import { groupBackups, listBackups } from './backups'
import { defaultConfig, mergeKnown, type RelayConfig } from './config'
import type { RelayContext } from './context'
import type { Filter } from './engines'
import { GLOBAL_REALM, sanitizePolicy } from './policy'
import { DATA_METRICS, TURN_METRICS } from './usage'
import { isHex64 } from './util/crypto'
import { HttpError, json, readJson, toErrorResponse } from './util/http'

export const ADMIN_PREFIX = '/api/admin'

interface Req {
  req: Request
  url: URL
  params: string[]
  ip: string
  ctx: RelayContext
  admin: Admin | null
  session: Session | null
  /** Record an audit entry for this request (actor = current admin). */
  audit(action: string, target?: string, details?: unknown): void
  audited: boolean
  body<T = Record<string, unknown>>(): Promise<T>
}

type Handler = (r: Req) => Promise<Response> | Response

interface Route {
  method: string
  re: RegExp
  handler: Handler
  public?: boolean
}

const routes: Route[] = []
const route = (method: string, path: string, handler: Handler, opts: { public?: boolean } = {}) => {
  const re = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`)
  routes.push({ method, re, handler, public: opts.public })
}

const p = (r: Req, i: number) => decodeURIComponent(r.params[i] ?? '')
const secure = (r: Req) =>
  r.url.protocol === 'https:' || r.ctx.config.publicUrl.startsWith('https:')

function sessionResponse(
  r: Req,
  admin: Admin,
  method: string,
  extra: Record<string, unknown> = {},
): Response {
  const { token, session } = r.ctx.auth.createSession(
    admin,
    method,
    r.ip,
    r.req.headers.get('user-agent') ?? '',
  )
  r.ctx.adb.audit(actorOf(admin), 'auth.login', `session:${session.id}`, { method }, r.ip)
  r.audited = true
  return json(
    { ...meView(r, admin, session), ...extra },
    { headers: { 'set-cookie': r.ctx.auth.cookie(token, { secure: secure(r) }) } },
  )
}

/** The SPA's `Me` shape plus the full admin and session records. */
function meView(r: Req, admin: Admin, session: Session) {
  return {
    id: admin.id,
    pubkey: admin.pubkey ?? undefined,
    username: admin.username ?? undefined,
    role: admin.role,
    method: session.method,
    sessionId: session.id,
    bootstrapPending: r.ctx.auth.bootstrapPending(),
    admin,
    session: { id: session.id, method: session.method, expiresAt: session.expiresAt },
  }
}

function authFailed(r: Req, method: string, e: unknown): never {
  r.ctx.adb.audit(
    'anonymous',
    'auth.failed',
    '',
    { method, reason: e instanceof Error ? e.message : String(e) },
    r.ip,
  )
  r.audited = true
  throw e
}

// ---------------------------------------------------------------- auth

route('POST', '/auth/challenge', (r) => json({ challenge: r.ctx.auth.challenge() }), {
  public: true,
})

route(
  'POST',
  '/auth/nostr',
  async (r) => {
    const { event } = await r.body<{ event?: unknown }>()
    let admin: Admin
    try {
      admin = r.ctx.auth.loginNostr(event)
    } catch (e) {
      authFailed(r, 'nostr', e)
    }
    return sessionResponse(r, admin, 'nostr')
  },
  { public: true },
)

route(
  'POST',
  '/auth/password',
  async (r) => {
    const body = await r.body()
    let admin: Admin
    try {
      admin = await r.ctx.auth.loginPassword(body)
    } catch (e) {
      authFailed(r, 'password', e)
    }
    return sessionResponse(r, admin, 'password')
  },
  { public: true },
)

route(
  'POST',
  '/auth/bootstrap',
  async (r) => {
    const body = await r.body()
    let res: Awaited<ReturnType<RelayContext['auth']['bootstrap']>>
    try {
      res = await r.ctx.auth.bootstrap(body)
    } catch (e) {
      authFailed(r, 'bootstrap', e)
    }
    r.ctx.adb.audit(
      'bootstrap',
      'admin.create',
      `admin:${res.admin.id}`,
      { pubkey: res.admin.pubkey, username: res.admin.username },
      r.ip,
    )
    return sessionResponse(
      r,
      res.admin,
      'bootstrap',
      res.totp ? { totp: res.totp, totpSecret: res.totp.secret, totpUri: res.totp.uri } : {},
    )
  },
  { public: true },
)

route(
  'GET',
  '/auth/status',
  (r) =>
    json({ bootstrapPending: r.ctx.auth.bootstrapPending(), admins: r.ctx.auth.adminCount() > 0 }),
  { public: true },
)

route('POST', '/auth/logout', (r) => {
  if (r.session) r.ctx.auth.revokeSession(r.session.id)
  r.audit('auth.logout', `session:${r.session?.id}`)
  return json(
    { ok: true },
    { headers: { 'set-cookie': r.ctx.auth.cookie('', { secure: secure(r), clear: true }) } },
  )
})

route('GET', '/me', (r) => json(meView(r, r.admin as Admin, r.session as Session)))

route('POST', '/me/password', async (r) => {
  const { password } = await r.body<{ password?: string }>()
  if (!r.admin?.username)
    throw new HttpError(400, 'invalid', 'only password admins have a password')
  await r.ctx.auth.changePassword(r.admin.id, String(password ?? ''))
  r.audit('admin.password', `admin:${r.admin.id}`)
  return json({ ok: true })
})

// ---------------------------------------------------------------- overview

route('GET', '/overview', (r) => json(r.ctx.overview()))
route('GET', '/alerts', (r) => json({ alerts: r.ctx.alerts() }))
const ack = (r: Req) => {
  ackAlert(r.ctx.adb, p(r, 0), actorOf(r.admin as Admin))
  r.audit('alert.ack', p(r, 0))
  return json({ ok: true })
}
route('POST', '/alerts/:id/ack', ack)
route('POST', '/overview/alerts/:id/ack', ack)

// ---------------------------------------------------------------- apps

const appOr404 = (r: Req) => {
  const app = r.ctx.apps.get(p(r, 0))
  if (!app) throw new HttpError(404, 'not-found', `app ${p(r, 0)} not found`)
  return app
}

route('GET', '/apps', (r) => json({ apps: r.ctx.apps.list().map((a) => appView(a)) }))

route('POST', '/apps', async (r) => {
  const body = await r.body()
  const { app, apiKey } = r.ctx.apps.create(body as { name: string })
  if (body.policy !== undefined) r.ctx.policies.put(app.id, sanitizePolicy(body.policy))
  r.audit('app.create', `app:${app.id}`, { name: app.name })
  return json(
    { ...appView(app, { secret: true }), apiKey, policy: r.ctx.policies.stored(app.id) ?? {} },
    { status: 201 },
  )
})

route('GET', '/apps/:id', (r) => {
  const app = appOr404(r)
  return json({ ...appView(app), policy: r.ctx.policies.stored(app.id) ?? {} })
})

route('PATCH', '/apps/:id', async (r) => {
  appOr404(r)
  const body = await r.body()
  const app = r.ctx.apps.update(p(r, 0), body)
  if (body.policy !== undefined) r.ctx.policies.put(app.id, sanitizePolicy(body.policy))
  if (app.disabled) r.ctx.dataRelay.kickApp(app.id)
  r.audit('app.update', `app:${app.id}`, body)
  return json({ ...appView(app), policy: r.ctx.policies.stored(app.id) ?? {} })
})

route('DELETE', '/apps/:id', (r) => {
  appOr404(r)
  r.ctx.apps.delete(p(r, 0))
  r.ctx.policies.invalidate()
  r.ctx.dataRelay.kickApp(p(r, 0))
  r.audit('app.delete', `app:${p(r, 0)}`)
  return json({ ok: true })
})

route('POST', '/apps/:id/rotate-turn-secret', (r) => {
  appOr404(r)
  const app = r.ctx.apps.rotateTurnSecret(p(r, 0))
  r.audit('app.rotate-turn-secret', `app:${app.id}`)
  return json(appView(app, { secret: true }))
})

route('POST', '/apps/:id/rotate-api-key', (r) => {
  appOr404(r)
  const { app, apiKey } = r.ctx.apps.rotateApiKey(p(r, 0))
  r.audit('app.rotate-api-key', `app:${app.id}`)
  return json({ ...appView(app), apiKey })
})

route('GET', '/apps/:id/usage', (r) => {
  const app = appOr404(r)
  r.ctx.meter.flush()
  const q = r.url.searchParams
  const now = r.ctx.adb.now()
  const to = Number(q.get('to') ?? 0) || now
  const from = Number(q.get('from') ?? 0) || to - (Number(q.get('days') ?? 30) || 30) * 86400
  const days = Math.min(Math.ceil((now - from) / 86400) + 1, 400)
  const rows = r.ctx.adb.usage(app.id, days)
  const byDay = new Map<string, { bytesIn: number; bytesOut: number }>()
  for (const row of rows) {
    const d = byDay.get(row.day) ?? { bytesIn: 0, bytesOut: 0 }
    if (row.metric.endsWith('_bytes_in')) d.bytesIn += row.value
    if (row.metric.endsWith('_bytes_out')) d.bytesOut += row.value
    byDay.set(row.day, d)
  }
  const points = [...byDay]
    .map(([day, d]) => ({
      ts: Date.parse(`${day}T00:00:00Z`) / 1000,
      ...d,
      allocations: 0,
      events: 0,
    }))
    .filter((pt) => pt.ts >= from - 86400 && pt.ts <= to)
  const allocations = (r.ctx.turn?.allocations() ?? []).filter(
    (a) => parseTurnUsername(a.username)?.appId === app.id,
  ).length
  let events = 0
  try {
    events = r.ctx.nostr?.count?.([{}], app.id) ?? 0
  } catch {}
  return json({
    appId: app.id,
    from,
    to,
    points,
    totals: {
      bytes: points.reduce((n, pt) => n + pt.bytesIn + pt.bytesOut, 0),
      events,
      peakAllocations: allocations,
    },
    app: app.id,
    month: {
      turnBytes: r.ctx.meter.month(app.id, TURN_METRICS),
      turnQuota: app.turnMonthlyBytes,
      dataBytes: r.ctx.meter.month(app.id, DATA_METRICS),
      dataQuota: app.dataMonthlyBytes,
      blossomBytes: r.ctx.blossom.scopeUsage(app.id),
      blossomQuota: app.blossomQuotaBytes,
    },
    days: rows,
  })
})

// ---------------------------------------------------------------- nostr

const nostrOr503 = (r: Req) => {
  if (!r.ctx.nostr) throw new HttpError(503, 'engine-unavailable', 'Nostr engine is not running')
  return r.ctx.nostr
}
const realmParam = (r: Req): string | null => {
  const v = r.url.searchParams.get('realm')
  return v && v !== GLOBAL_REALM ? v : null
}

route('GET', '/nostr/events', (r) => {
  const q = r.url.searchParams
  const f: Filter = { limit: Math.min(Number(q.get('limit') ?? 100) || 100, 500) }
  const kinds = q
    .getAll('kind')
    .flatMap((k) => k.split(','))
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger)
  if (kinds.length) f.kinds = kinds
  const authors = q
    .getAll('author')
    .flatMap((a) => a.split(','))
    .filter(Boolean)
  if (authors.length) f.authors = authors
  for (const t of q.getAll('tag')) {
    const m = /^#?([a-zA-Z])[:=](.+)$/.exec(t)
    if (m) f[`#${m[1]}`] = [...(f[`#${m[1]}`] ?? []), m[2] as string]
  }
  if (q.get('search')) f.search = q.get('search') as string
  if (q.get('until')) f.until = Number(q.get('until'))
  if (q.get('since')) f.since = Number(q.get('since'))
  return json({ events: nostrOr503(r).query([f], realmParam(r)) })
})

route('DELETE', '/nostr/events/:id', async (r) => {
  nostrOr503(r)
  const id = p(r, 0)
  if (!isHex64(id)) throw new HttpError(400, 'invalid', 'event id must be 64 hex chars')
  const ok = await r.ctx.deleteNostrEvent(id, realmParam(r))
  if (!ok) throw new HttpError(404, 'not-found', 'event not found or engine refused the deletion')
  r.audit('nostr.event.delete', `event:${id}`, { realm: realmParam(r) })
  return json({ ok: true })
})

route('GET', '/nostr/subscriptions', (r) => {
  const n = nostrOr503(r)
  const subs = (n.subscriptions?.() ?? []).map((s) => ({
    id: `${s.connId}:${s.subId}`,
    clientId: String(s.connId),
    subId: s.subId,
    ip: s.ip,
    realm: s.realm,
    filters: s.filters,
    authed: s.authed ?? [],
    createdAt: 0,
    eventsSent: 0,
  }))
  return json({ subscriptions: subs, stats: n.stats() })
})

route('GET', '/policies/:realm', (r) => {
  const realm = p(r, 0)
  if (realm !== GLOBAL_REALM && !r.ctx.apps.get(realm))
    throw new HttpError(404, 'not-found', `realm ${realm} not found`)
  return json(r.ctx.policies.stored(realm) ?? {})
})

route('PUT', '/policies/:realm', async (r) => {
  const realm = p(r, 0)
  if (realm !== GLOBAL_REALM && !r.ctx.apps.get(realm))
    throw new HttpError(404, 'not-found', `realm ${realm} not found`)
  const body = await r.body<{ policy?: unknown }>()
  const policy = sanitizePolicy(body.policy ?? body)
  r.ctx.policies.put(realm, policy)
  r.audit('policy.update', `realm:${realm}`, policy)
  return json(policy)
})

route('GET', '/nip11', (r) => json(r.ctx.nip11))

route('PUT', '/nip11', async (r) => {
  const body = await r.body<Record<string, unknown>>()
  const info = (body.info ?? body) as Record<string, unknown>
  if (typeof info !== 'object' || Array.isArray(info))
    throw new HttpError(400, 'invalid', 'NIP-11 document must be an object')
  const allowed = [
    'name',
    'description',
    'pubkey',
    'contact',
    'icon',
    'banner',
    'privacy_policy',
    'terms_of_service',
    'posting_policy',
    'relay_countries',
    'language_tags',
    'tags',
  ]
  const clean = Object.fromEntries(Object.entries(info).filter(([k]) => allowed.includes(k)))
  r.ctx.adb.setSetting('nip11', clean)
  r.ctx.refreshNip11()
  r.audit('nip11.update', 'nip11', clean)
  return json(r.ctx.nip11)
})

// ---------------------------------------------------------------- TURN + bans

const addr = (v: unknown): string => {
  if (typeof v === 'string') return v
  const a = (Array.isArray(v) ? v[0] : v) as { address?: string; port?: number } | undefined
  if (!a?.address) return ''
  return a.address.includes(':') ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`
}

route('GET', '/turn/allocations', (r) =>
  json({
    allocations: (r.ctx.turn?.allocations() ?? []).map((a) => ({
      ...a,
      appId: parseTurnUsername(a.username)?.appId,
      client: addr(a.client),
      relayed: addr(a.relayed),
      raw: { client: a.client, relayed: a.relayed },
    })),
    stats: r.ctx.turn?.stats() ?? null,
    running: !!r.ctx.turn,
  }),
)

route('DELETE', '/turn/allocations/:id', (r) => {
  if (!r.ctx.turn) throw new HttpError(503, 'engine-unavailable', 'TURN engine is not running')
  if (!r.ctx.turn.kill(p(r, 0))) throw new HttpError(404, 'not-found', 'allocation not found')
  r.audit('turn.allocation.kill', `allocation:${p(r, 0)}`)
  return json({ ok: true })
})

const banView = (b: ReturnType<RelayContext['bans']['list']>[number]) => ({
  ...b,
  ...(b.type === 'ip' ? { ip: b.value } : { pubkey: b.value }),
})

route('GET', '/bans', (r) => json({ bans: r.ctx.bans.list().map(banView) }))

route('POST', '/bans', async (r) => {
  const body = await r.body()
  // SPA shape { ip, reason, durationSec } or relay shape { type, value, reason, expiresAt }.
  const input =
    body.ip !== undefined
      ? {
          type: 'ip',
          value: body.ip,
          reason: body.reason,
          expiresAt: body.durationSec ? r.ctx.adb.now() + Number(body.durationSec) : null,
        }
      : body
  const ban = r.ctx.bans.add(input as { type: unknown; value: unknown }, actorOf(r.admin as Admin))
  r.ctx.policies.invalidate()
  r.audit('ban.create', `${ban.type}:${ban.value}`, {
    reason: ban.reason,
    expiresAt: ban.expiresAt,
  })
  return json({ ...banView(ban), ban: banView(ban) }, { status: 201 })
})

route('DELETE', '/bans/:id', (r) => {
  const key = p(r, 0).toLowerCase()
  const id = /^\d+$/.test(key) ? Number(key) : r.ctx.bans.list().find((b) => b.value === key)?.id
  const ban = id === undefined ? null : r.ctx.bans.remove(id)
  if (!ban) throw new HttpError(404, 'not-found', 'ban not found')
  r.ctx.policies.invalidate()
  r.audit('ban.delete', `${ban.type}:${ban.value}`)
  return json({ ok: true })
})

// ---------------------------------------------------------------- media

route('GET', '/media/blobs', (r) => {
  const q = r.url.searchParams
  const app = q.get('app')
  return json({
    blobs: r.ctx.blossom
      .adminList({
        scope: app === null ? undefined : app === '_public' ? '' : app,
        pubkey: q.get('pubkey') ?? undefined,
        limit: Number(q.get('limit') ?? 200) || 200,
      })
      .map((b) => ({ ...b, url: `${r.ctx.baseUrl(r.req)}/${b.sha256}` })),
    stats: r.ctx.blossom.stats(),
  })
})

route('DELETE', '/media/blobs/:sha', (r) => {
  const sha = p(r, 0)
  if (!isHex64(sha)) throw new HttpError(400, 'invalid', 'sha256 must be 64 hex chars')
  if (!r.ctx.blossom.adminDelete(sha)) throw new HttpError(404, 'not-found', 'blob not found')
  r.audit('media.blob.delete', `blob:${sha}`)
  return json({ ok: true })
})

// ---------------------------------------------------------------- payments

route('GET', '/payments/plans', (r) => json({ plans: r.ctx.payments.plans(true) }))

route('POST', '/payments/plans', async (r) => {
  const body = await r.body()
  const plan = r.ctx.payments.savePlan(body)
  r.ctx.refreshNip11()
  r.audit(
    body.id === undefined ? 'payments.plan.create' : 'payments.plan.update',
    `plan:${plan.id}`,
    plan,
  )
  return json(plan, { status: body.id === undefined ? 201 : 200 })
})

route('GET', '/payments/invoices', (r) => {
  const q = r.url.searchParams
  return json({
    invoices: r.ctx.payments.invoices({
      status: q.get('status') ?? undefined,
      pubkey: q.get('pubkey') ?? undefined,
    }),
    revenueSats: r.ctx.payments.revenueSats(),
  })
})

route('GET', '/payments/paid', (r) => json({ paid: r.ctx.payments.paid() }))

route('POST', '/payments/paid', async (r) => {
  const body = await r.body<{ pubkey?: string; days?: number }>()
  const days = Number(body.days)
  if (!Number.isFinite(days) || days === 0)
    throw new HttpError(400, 'invalid', 'days must be a non-zero number')
  const paid = r.ctx.payments.grant(String(body.pubkey ?? '').toLowerCase(), days)
  r.audit('payments.paid.adjust', `pubkey:${paid.pubkey}`, { days })
  return json({ paid })
})

route('GET', '/payments/nwc', (r) => json(r.ctx.payments.nwcStatus()))

route('PUT', '/payments/nwc', async (r) => {
  // { uri?: string | null, lnurl?: string } (`url` accepted as an alias). Omitting uri keeps the
  // current wallet; null or '' disconnects it.
  const body = await r.body<{ uri?: string | null; url?: string | null; lnurl?: string }>()
  const key = 'uri' in body ? 'uri' : 'url' in body ? 'url' : null
  if (key) r.ctx.payments.setNwcUrl(String(body[key] ?? ''))
  if (typeof body.lnurl === 'string') r.ctx.payments.setLnurl(body.lnurl)
  r.ctx.refreshNip11()
  const nwc = r.ctx.payments.nwcStatus()
  r.audit('payments.nwc.update', 'nwc', { ...nwc, walletChanged: !!key })
  return json(nwc)
})

// ---------------------------------------------------------------- admins + sessions + audit

route('GET', '/admins', (r) => json({ admins: r.ctx.auth.listAdmins() }))

route('POST', '/admins', async (r) => {
  const res = await r.ctx.auth.createAdmin(await r.body(), actorOf(r.admin as Admin))
  r.audit('admin.create', `admin:${res.admin.id}`, {
    pubkey: res.admin.pubkey,
    username: res.admin.username,
  })
  return json(
    {
      ...res.admin,
      admin: res.admin,
      ...(res.totp ? { totp: res.totp, totpSecret: res.totp.secret, totpUri: res.totp.uri } : {}),
    },
    { status: 201 },
  )
})

route('DELETE', '/admins/:id', (r) => {
  const a = r.ctx.auth.deleteAdmin(Number(p(r, 0)))
  r.audit('admin.delete', `admin:${a.id}`, { pubkey: a.pubkey, username: a.username })
  return json({ ok: true })
})

route('POST', '/admins/:id/reset-totp', (r) => {
  const totp = r.ctx.auth.resetTotp(Number(p(r, 0)))
  r.audit('admin.reset-totp', `admin:${p(r, 0)}`)
  return json({ totp, totpSecret: totp.secret, totpUri: totp.uri })
})

route('GET', '/sessions', (r) =>
  json({
    sessions: r.ctx.auth.listSessions().map((s) => ({
      ...s,
      label: `${s.admin} (${s.method})`,
      current: s.id === r.session?.id,
    })),
    current: r.session?.id,
  }),
)

route('DELETE', '/sessions/:id', (r) => {
  if (!r.ctx.auth.revokeSession(p(r, 0))) throw new HttpError(404, 'not-found', 'session not found')
  r.audit('session.revoke', `session:${p(r, 0)}`)
  return json({ ok: true })
})

route('GET', '/audit', (r) => {
  const q = r.url.searchParams
  return json({
    entries: r.ctx.adb
      .auditLog({
        limit: Number(q.get('limit') ?? 100) || 100,
        before: Number(q.get('before') ?? 0) || undefined,
        actor: q.get('actor') ?? undefined,
        action: q.get('action') ?? undefined,
      })
      .map((e) => ({ ...e, ts: e.at, scope: e.target })),
  })
})

// ---------------------------------------------------------------- settings + backups

/** Keys that only take effect after a restart. */
const RESTART_KEYS = [
  'dataDir',
  'http.host',
  'http.port',
  'http.tlsCert',
  'http.tlsKey',
  'turn.enabled',
  'turn.realm',
  'turn.host',
  'turn.externalIp',
  'turn.udpPort',
  'turn.tcpPort',
  'turn.tlsPort',
  'turn.tlsCert',
  'turn.tlsKey',
  'turn.relayPortMin',
  'turn.relayPortMax',
  'backups.dir',
  'admin.distDir',
]
const SECRET_KEYS = ['metrics.token', 'payments.nwcUrl']

function redact(config: RelayConfig): RelayConfig {
  const c = structuredClone(config) as unknown as Record<string, Record<string, unknown>>
  for (const k of SECRET_KEYS) {
    const [s, f] = k.split('.') as [string, string]
    if (c[s]?.[f]) c[s][f] = '***'
  }
  return c as unknown as RelayConfig
}

function flatten(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

/** The admin SPA's `Settings` view of the effective config. */
function spaSettings(c: RelayConfig) {
  return {
    publicUrl: c.publicUrl,
    listeners: {
      https: c.http.port,
      turnUdp: c.turn.udpPort,
      turnTcp: c.turn.tcpPort,
      turnTls: c.turn.tlsPort,
      relayPorts: [c.turn.relayPortMin, c.turn.relayPortMax] as [number, number],
    },
    tls: { cert: c.http.tlsCert, key: c.http.tlsKey },
    logging: { level: c.log.level },
    // The path is fixed; the token is a secret and is only reported as set or not.
    metrics: { enabled: c.metrics.enabled, path: '/metrics', tokenSet: !!c.metrics.token },
    backups: {
      enabled: c.backups.enabled,
      hourUtc: c.backups.hour,
      retentionDays: c.backups.retentionDays,
    },
  }
}

type Spa = {
  publicUrl?: string
  listeners?: {
    https?: number
    turnUdp?: number
    turnTcp?: number
    turnTls?: number
    relayPorts?: number[]
  }
  tls?: { cert?: string; key?: string }
  logging?: { level?: string }
  metrics?: { enabled?: boolean }
  backups?: { enabled?: boolean; hourUtc?: number; retentionDays?: number }
}

/** Translate a SPA `Settings` document into a config patch containing only changed values. */
function fromSpaSettings(s: Spa, c: RelayConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const set = (sec: string, key: string, v: unknown, cur: unknown) => {
    if (v === undefined || v === cur) return
    if (sec === '') patch[key] = v
    else patch[sec] = { ...((patch[sec] as Record<string, unknown>) ?? {}), [key]: v }
  }
  set('', 'publicUrl', s.publicUrl, c.publicUrl)
  set('http', 'port', s.listeners?.https, c.http.port)
  set('turn', 'udpPort', s.listeners?.turnUdp, c.turn.udpPort)
  set('turn', 'tcpPort', s.listeners?.turnTcp, c.turn.tcpPort)
  set('turn', 'tlsPort', s.listeners?.turnTls, c.turn.tlsPort)
  set('turn', 'relayPortMin', s.listeners?.relayPorts?.[0], c.turn.relayPortMin)
  set('turn', 'relayPortMax', s.listeners?.relayPorts?.[1], c.turn.relayPortMax)
  set('http', 'tlsCert', s.tls?.cert, c.http.tlsCert)
  set('http', 'tlsKey', s.tls?.key, c.http.tlsKey)
  set('log', 'level', s.logging?.level, c.log.level)
  set('metrics', 'enabled', s.metrics?.enabled, c.metrics.enabled)
  set('backups', 'enabled', s.backups?.enabled, c.backups.enabled)
  set('backups', 'hour', s.backups?.hourUtc, c.backups.hour)
  set('backups', 'retentionDays', s.backups?.retentionDays, c.backups.retentionDays)
  return patch
}

route('GET', '/settings', (r) =>
  json({
    ...spaSettings(r.ctx.config),
    config: redact(r.ctx.config),
    overrides: r.ctx.adb.getSetting('config_overrides') ?? {},
    envLocked: r.ctx.loaded.envKeys,
    restartKeys: RESTART_KEYS,
    configPath: r.ctx.loaded.path,
  }),
)

route('PUT', '/settings', async (r) => {
  const body = await r.body<Record<string, unknown>>()
  const spa = 'listeners' in body || 'logging' in body || 'tls' in body
  const patch = (
    spa ? fromSpaSettings(body as Spa, r.ctx.config) : (body.config ?? body)
  ) as Record<string, unknown>
  const keys = flatten(patch)
  const locked = keys.filter((k) => r.ctx.loaded.envKeys.includes(k))
  if (locked.length)
    throw new HttpError(409, 'env-locked', `set by environment: ${locked.join(', ')}`)
  const secret = keys.filter((k) => SECRET_KEYS.includes(k))
  if (secret.length)
    throw new HttpError(400, 'invalid', `edit ${secret.join(', ')} through its dedicated endpoint`)
  if (keys.includes('dataDir'))
    throw new HttpError(400, 'invalid', 'dataDir cannot be changed at runtime')
  // Validate by merging onto the defaults (throws on bad types, drops unknown keys).
  let validated: Record<string, unknown>
  try {
    validated = mergeKnown(defaultConfig, patch) as unknown as Record<string, unknown>
  } catch (e) {
    throw new HttpError(400, 'invalid', (e as Error).message)
  }
  const known = keys.filter((k) => {
    const [s, f] = k.split('.') as [string, string | undefined]
    const sec = validated[s]
    return f ? !!sec && typeof sec === 'object' && f in (sec as object) : s in validated
  })
  const prev = (r.ctx.adb.getSetting<Record<string, Record<string, unknown>>>('config_overrides') ??
    {}) as Record<string, Record<string, unknown>>
  for (const k of known) {
    const [s, f] = k.split('.') as [string, string]
    const v = (validated[s] as Record<string, unknown>)[f]
    prev[s] = { ...(prev[s] ?? {}), [f]: v }
  }
  r.ctx.adb.setSetting('config_overrides', prev)
  r.ctx.applySettings()
  r.audit('settings.update', 'settings', Object.fromEntries(known.map((k) => [k, true])))
  return json({
    ...spaSettings(r.ctx.config),
    config: redact(r.ctx.config),
    overrides: prev,
    restartRequired: known.filter((k) => RESTART_KEYS.includes(k)),
  })
})

route('GET', '/backups', (r) => {
  const files = listBackups(r.ctx.backupDir)
  return json({ backups: groupBackups(files), files, dir: r.ctx.backupDir })
})

route('POST', '/backups', (r) => {
  const files = r.ctx.backup()
  r.audit('backup.create', 'backups', { files: files.map((f) => f.name) })
  const [backup] = groupBackups(files)
  return json({ ...backup, backups: files }, { status: 201 })
})

// ---------------------------------------------------------------- dispatcher

export function sameOrigin(req: Request, ctx: RelayContext): boolean {
  const origin = req.headers.get('origin')
  if (!origin) {
    const site = req.headers.get('sec-fetch-site')
    return !site || site === 'same-origin' || site === 'none'
  }
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  if (host === req.headers.get('host')) return true
  const allowed = [...ctx.config.admin.allowedOrigins, ctx.config.publicUrl].filter(Boolean)
  return allowed.some((a) => {
    try {
      return new URL(a).host === host
    } catch {
      return false
    }
  })
}

/** Handle `/api/admin/*` (except the stats WebSocket, upgraded by the server). */
export async function handleAdminApi(
  req: Request,
  url: URL,
  ctx: RelayContext,
  ip: string,
): Promise<Response> {
  const path = url.pathname.slice(ADMIN_PREFIX.length) || '/'
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  try {
    if (write) {
      // CSRF: SameSite=Strict cookie + Origin check + JSON-only bodies (no simple cross-site forms).
      if (!sameOrigin(req, ctx))
        throw new HttpError(403, 'bad-origin', 'cross-origin admin request refused')
      const ct = req.headers.get('content-type') ?? ''
      const hasBody =
        Number(req.headers.get('content-length') ?? 0) > 0 || req.headers.has('transfer-encoding')
      if (hasBody && !ct.includes('application/json'))
        throw new HttpError(415, 'bad-content-type', 'admin API accepts application/json only')
    }
    let matchedPath = false
    for (const rt of routes) {
      const m = rt.re.exec(path)
      if (!m) continue
      matchedPath = true
      if (rt.method !== req.method) continue
      const authed = ctx.auth.authenticate(req)
      if (!rt.public && !authed)
        throw new HttpError(401, 'unauthenticated', 'admin session required')
      let bodyCache: unknown
      const r: Req = {
        req,
        url,
        ip,
        ctx,
        params: m.slice(1),
        admin: authed?.admin ?? null,
        session: authed?.session ?? null,
        audited: false,
        audit(action, target = '', details = {}) {
          ctx.adb.audit(r.admin ? actorOf(r.admin) : 'anonymous', action, target, details, ip)
          r.audited = true
        },
        async body<T>() {
          if (bodyCache === undefined) bodyCache = await readJson(req)
          if (!bodyCache || typeof bodyCache !== 'object' || Array.isArray(bodyCache)) {
            throw new HttpError(400, 'invalid', 'JSON object body expected')
          }
          return bodyCache as T
        },
      }
      const res = await rt.handler(r)
      // Safety net: every successful write lands in the audit log.
      if (write && res.status < 400 && !r.audited) r.audit(`${req.method} ${path}`)
      return res
    }
    if (matchedPath)
      throw new HttpError(405, 'method-not-allowed', `${req.method} not allowed on ${path}`)
    throw new HttpError(404, 'not-found', `no admin route ${req.method} ${path}`)
  } catch (e) {
    if (!(e instanceof HttpError)) ctx.logger.error('admin api error', { path, error: e })
    return toErrorResponse(e)
  }
}
