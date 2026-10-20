import { mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import { ADMIN_PREFIX, handleAdminApi, sameOrigin } from './admin-api'
import { type Alert, certExpiry, diskUsage, evaluateAlerts } from './alerts'
import { AppStore } from './apps'
import { AdminAuth } from './auth'
import { type BackupFile, listBackups, msUntilHour, pruneBackups, runBackup } from './backups'
import { Blossom, CORS_HEADERS } from './blossom'
import { type LoadedConfig, mergeKnown, type RelayConfig } from './config'
import type { RelayContext } from './context'
import { DataRelay, type DataSocketData } from './data-relay'
import { AdminDb } from './db'
import {
  loadNostrEngine,
  loadTurnEngine,
  type Nip11Info,
  type NostrRelay,
  type NostrRelayFactory,
  type NostrSocketData,
  type TurnServer,
  type TurnServerFactory,
} from './engines'
import { createLogger, type Logger } from './log'
import { HttpCounters, type MetricSample, renderPrometheus } from './metrics'
import { createNwcClient, type NwcClient } from './nwc'
import { payPage, qrSvg } from './pay-page'
import { Payments } from './payments'
import { BanStore, PolicyStore } from './policy'
import { adminDistFromPackage, resolveAdminDist, serveAdmin } from './static'
import { handleTurnCredentials, turnHooks } from './turn-credentials'
import { TURN_METRICS, UsageMeter } from './usage'
import { getPublicKey, normalizePubkey, randomHex, signEvent } from './util/crypto'
import { escapeHtml, HttpError, json, RateLimiter, readJson, toErrorResponse } from './util/http'
import { VERSION } from './version'

export interface RelayServerDeps {
  /** Nostr engine factory. Omitted = load `@beamhop/nostr-relay`; null = run without Nostr. */
  nostrFactory?: NostrRelayFactory | null
  /** TURN engine factory. Omitted = load `@beamhop/turn`; null = run without TURN. */
  turnFactory?: TurnServerFactory | null
  /** NWC client factory (tests inject a fake wallet). */
  nwcFactory?: (url: string) => NwcClient
  logger?: Logger
  /** Clock in unix seconds. */
  now?: () => number
  /** fetch used by Blossom PUT /mirror. */
  fetch?: typeof fetch
}

export interface StartResult {
  url: string
  port: number
  turn: { udp?: number; tcp?: number; tls?: number } | null
  /** Freshly minted bootstrap token (first run only). */
  bootstrapToken: string | null
}

export interface RelayServer {
  readonly ctx: RelayContext
  start(): Promise<StartResult>
  stop(): Promise<void>
  readonly port: number
  /** Re-read TLS cert/key and restart the listener (called automatically when files change). */
  reloadTls(): void
}

interface StatsSocketData {
  route: 'stats'
  adminId: number
}

type SocketData = NostrSocketData | DataSocketData | StatsSocketData

type BunServer = Server<SocketData>

const STATS_TOPIC = 'admin-stats'
const APP_PATH = /^\/a\/([a-z0-9][a-z0-9_-]{0,62})(\/.*)?$/

/** Build the relay. Nothing listens until `start()`. */
export function createRelayServer(
  config: RelayConfig | LoadedConfig,
  deps: RelayServerDeps = {},
): RelayServer {
  return new RelayServerImpl(config, deps)
}

class RelayServerImpl implements RelayServer, RelayContext {
  readonly config: RelayConfig
  readonly loaded: Pick<LoadedConfig, 'path' | 'envKeys'>
  private baseConfig: RelayConfig
  readonly adb: AdminDb
  readonly apps: AppStore
  readonly bans: BanStore
  readonly policies: PolicyStore
  readonly auth: AdminAuth
  readonly payments: Payments
  readonly blossom: Blossom
  readonly dataRelay: DataRelay
  readonly meter: UsageMeter
  readonly http = new HttpCounters()
  nostr: NostrRelay | null = null
  turn: TurnServer | null = null
  logger: Logger
  readonly startedAt = Math.floor(Date.now() / 1000)
  readonly version = VERSION
  readonly backupDir: string
  readonly nip11: Nip11Info = {}
  readonly relayPubkey: string
  private relaySecret: string
  private limiter: RateLimiter
  private server: BunServer | null = null
  private serveOpts: Parameters<typeof Bun.serve>[0] | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private backupTimer: ReturnType<typeof setTimeout> | null = null
  private nostrSockets = new WeakSet<object>()
  private adminDist: string | null
  private turnPorts: StartResult['turn'] = null
  private tlsMtime = 0
  private dataDir: string

  get ctx(): RelayContext {
    return this
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  constructor(
    cfg: RelayConfig | LoadedConfig,
    private deps: RelayServerDeps,
  ) {
    const loaded: LoadedConfig = 'config' in cfg ? cfg : { config: cfg, path: null, envKeys: [] }
    this.baseConfig = structuredClone(loaded.config)
    this.config = structuredClone(loaded.config)
    this.loaded = { path: loaded.path, envKeys: loaded.envKeys }
    this.logger = deps.logger ?? createLogger(this.config.log.level)
    this.dataDir = resolve(this.config.dataDir)
    mkdirSync(this.dataDir, { recursive: true })
    this.adb = new AdminDb(join(this.dataDir, 'admin.db'), deps.now)
    this.applyOverrides()
    this.backupDir = resolve(this.config.backups.dir || join(this.dataDir, 'backups'))

    let secret = this.adb.getSetting<string>('relay_secret')
    if (!secret) {
      secret = randomHex(32)
      this.adb.setSetting('relay_secret', secret)
    }
    this.relaySecret = secret
    this.relayPubkey = getPublicKey(secret)

    this.meter = new UsageMeter(this.adb)
    this.apps = new AppStore(this.adb, { blossomQuotaBytes: this.config.blossom.defaultQuotaBytes })
    this.bans = new BanStore(this.adb)
    this.payments = new Payments(this.adb, {
      nwcFactory: deps.nwcFactory ?? ((url) => createNwcClient(url)),
      nwcUrl: this.config.payments.nwcUrl,
      invoiceExpirySec: this.config.payments.invoiceExpirySec,
      logger: this.logger,
    })
    this.policies = new PolicyStore(this.adb, this.bans, {
      paymentsRequired: () => this.config.payments.required,
      isPaid: (pk) => this.payments.isPaid(pk),
      admins: () => [this.relayPubkey],
    })
    this.auth = new AdminAuth(this.adb, { sessionTtlSec: this.config.admin.sessionTtlHours * 3600 })
    this.blossom = new Blossom(this.adb, this.apps, this.bans, this.meter, {
      ...this.config.blossom,
      dir: join(this.dataDir, 'blobs'),
      fetch: deps.fetch,
    })
    this.dataRelay = new DataRelay(this.apps, this.bans, this.meter, { ...this.config.data })
    this.limiter = new RateLimiter(this.config.http.rateLimitPerMinute, 60_000)
    this.adminDist = resolveAdminDist(this.config.admin.distDir)
    this.refreshNip11()
  }

  // ------------------------------------------------------------ settings

  /** Effective config = file/env config + admin.db overrides (env-set keys win). */
  private applyOverrides() {
    const overrides =
      this.adb.getSetting<Record<string, Record<string, unknown>>>('config_overrides') ?? {}
    const filtered: Record<string, Record<string, unknown>> = {}
    for (const [s, sec] of Object.entries(overrides)) {
      for (const [k, v] of Object.entries(sec ?? {})) {
        if (this.loaded.envKeys.includes(`${s}.${k}`)) continue
        filtered[s] = { ...(filtered[s] ?? {}), [k]: v }
      }
    }
    const next = mergeKnown(this.baseConfig, filtered)
    for (const [k, v] of Object.entries(next)) {
      const cur = (this.config as unknown as Record<string, unknown>)[k]
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) Object.assign(cur, v)
      else (this.config as unknown as Record<string, unknown>)[k] = v
    }
  }

  applySettings() {
    this.applyOverrides()
    this.logger.level = this.config.log.level
    Object.assign(this.blossom.opts, this.config.blossom)
    Object.assign(this.dataRelay.opts, this.config.data)
    this.limiter = new RateLimiter(this.config.http.rateLimitPerMinute, 60_000)
    this.policies.invalidate()
    this.refreshNip11()
    this.scheduleBackup()
  }

  private publicBase(): string {
    if (this.config.publicUrl) return this.config.publicUrl.replace(/\/+$/, '')
    const scheme = this.config.http.tlsCert ? 'https' : 'http'
    const host =
      this.config.http.host === '0.0.0.0' || this.config.http.host === '::'
        ? 'localhost'
        : this.config.http.host
    return `${scheme}://${host}:${this.port || this.config.http.port}`
  }

  baseUrl(req: Request): string {
    if (this.config.publicUrl) return this.config.publicUrl.replace(/\/+$/, '')
    const u = new URL(req.url)
    const host = req.headers.get('host') ?? u.host
    const proto = this.config.http.trustProxy
      ? (req.headers.get('x-forwarded-proto') ?? u.protocol.slice(0, -1))
      : u.protocol.slice(0, -1)
    return `${proto}://${host}`
  }

  refreshNip11() {
    const c = this.config.nostr
    const overrides = this.adb.getSetting<Record<string, unknown>>('nip11') ?? {}
    const info: Nip11Info = {
      name: c.name,
      description: c.description,
      pubkey: c.pubkey || this.relayPubkey,
      self: this.relayPubkey,
      contact: c.contact || undefined,
      icon: c.icon || undefined,
      software: 'https://github.com/beamhop/lightspeed',
      version: VERSION,
      ...overrides,
      ...this.payments.nip11(this.publicBase()),
    }
    if (this.config.payments.required)
      info.limitation = { ...(info.limitation ?? {}), payment_required: true }
    for (const k of Object.keys(this.nip11)) delete this.nip11[k]
    Object.assign(this.nip11, JSON.parse(JSON.stringify(info)))
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<StartResult> {
    const nostrFactory =
      this.deps.nostrFactory === undefined ? await loadNostrEngine() : this.deps.nostrFactory
    if (nostrFactory) {
      this.nostr = nostrFactory({
        dbPath: join(this.dataDir, 'nostr.db'),
        info: this.nip11,
        policy: this.policies,
        auth: { relayUrl: this.publicBase().replace(/^http/, 'ws') },
        admins: [this.relayPubkey],
      })
    } else if (this.deps.nostrFactory === undefined) {
      this.logger.error(
        '@beamhop/nostr-relay does not export createNostrRelay; Nostr relay disabled',
      )
    }

    if (!this.adminDist && !this.config.admin.distDir) this.adminDist = await adminDistFromPackage()
    this.serveOpts = this.buildServeOptions()
    this.server = Bun.serve(this.serveOpts as Parameters<typeof Bun.serve>[0])
    this.tlsMtime = this.certMtime()
    this.refreshNip11()

    if (this.config.turn.enabled) {
      const turnFactory =
        this.deps.turnFactory === undefined ? await loadTurnEngine() : this.deps.turnFactory
      if (turnFactory) {
        const t = this.config.turn
        const tls =
          t.tlsPort > 0 && this.config.http.tlsCert && this.config.http.tlsKey
            ? { port: t.tlsPort, cert: this.config.http.tlsCert, key: this.config.http.tlsKey }
            : undefined
        this.turn = turnFactory({
          realm: t.realm,
          listen: { udp: t.udpPort, tcp: t.tcpPort, tls },
          host: t.host,
          externalIp: t.externalIp || undefined,
          relayPorts: [t.relayPortMin, t.relayPortMax],
          ...turnHooks(
            this.apps,
            this.meter,
            (pk) => this.bans.pubkeyBanned(pk),
            () => this.adb.now(),
          ),
        })
        try {
          this.turnPorts = await this.turn.start()
        } catch (e) {
          this.logger.error('TURN failed to start', { error: e })
          this.turn = null
        }
      } else if (this.deps.turnFactory === undefined) {
        this.logger.error('@beamhop/turn does not export createTurnServer; TURN disabled')
      }
    }

    this.timers.push(setInterval(() => this.safe(() => this.meter.flush()), 10_000))
    this.timers.push(setInterval(() => this.safe(() => this.payments.pollPending()), 15_000))
    this.timers.push(setInterval(() => this.publishStats(), 1000))
    this.timers.push(
      setInterval(
        () =>
          this.safe(() => {
            this.checkTls()
            this.alerts()
          }),
        60_000,
      ),
    )
    for (const t of this.timers) (t as { unref?: () => void }).unref?.()
    this.scheduleBackup()

    const bootstrapToken = this.auth.ensureBootstrapToken()
    const url = this.publicBase()
    if (bootstrapToken) {
      this.logger.warn('no admin yet: claim the relay with this bootstrap token', {
        bootstrapToken,
        admin: `${url}/admin`,
      })
    } else if (this.auth.bootstrapPending()) {
      this.logger.warn(
        'admin bootstrap pending; mint a new token with `beamhop relay bootstrap-token`',
      )
    }
    this.logger.info('relay listening', {
      url,
      port: this.port,
      nostr: !!this.nostr,
      turn: this.turnPorts,
      admin: this.adminDist ? 'spa' : 'placeholder',
    })
    return { url, port: this.port, turn: this.turnPorts, bootstrapToken }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.backupTimer) clearTimeout(this.backupTimer)
    this.server?.stop(true)
    this.server = null
    await this.turn?.stop().catch(() => {})
    this.nostr?.close()
    this.payments.close()
    this.safe(() => this.meter.flush())
    this.adb.close()
  }

  private safe(fn: () => unknown) {
    try {
      const r = fn()
      if (r instanceof Promise)
        r.catch((e) => this.logger.error('background task failed', { error: e }))
    } catch (e) {
      this.logger.error('background task failed', { error: e })
    }
  }

  // ------------------------------------------------------------ TLS

  private tlsOptions() {
    const { tlsCert, tlsKey } = this.config.http
    if (!tlsCert || !tlsKey) return undefined
    return { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) }
  }

  private certMtime(): number {
    const { tlsCert, tlsKey } = this.config.http
    if (!tlsCert || !tlsKey) return 0
    try {
      return statSync(tlsCert).mtimeMs + statSync(tlsKey).mtimeMs
    } catch {
      return 0
    }
  }

  private checkTls() {
    const m = this.certMtime()
    if (m && m !== this.tlsMtime) {
      this.tlsMtime = m
      this.reloadTls()
    }
  }

  reloadTls() {
    if (!this.server || !this.serveOpts) return
    const port = this.server.port
    this.serveOpts = { ...this.serveOpts, port, tls: this.tlsOptions() } as typeof this.serveOpts
    // Stop accepting on the old listener (in-flight connections finish), then rebind with new certs.
    this.server.stop(false)
    this.server = Bun.serve(this.serveOpts as Parameters<typeof Bun.serve>[0])
    this.logger.info('TLS certificate reloaded', { port })
  }

  // ------------------------------------------------------------ HTTP + WebSocket

  private buildServeOptions() {
    const ws = {
      maxPayloadLength: Math.max(1 << 20, this.config.data.maxFrameBytes + 64),
      idleTimeout: 120,
      open: (s: ServerWebSocket<SocketData>) => {
        const d = s.data
        if (this.nostrSockets.has(d))
          return this.nostr?.websocket.open(s as ServerWebSocket<NostrSocketData>)
        const r = (d as { route?: string }).route
        if (r === 'data') return this.dataRelay.open(s as ServerWebSocket<DataSocketData>)
        if (r === 'stats') {
          s.subscribe(STATS_TOPIC)
          s.send(JSON.stringify(this.stats()))
        }
      },
      message: (s: ServerWebSocket<SocketData>, msg: string | Buffer) => {
        const d = s.data
        if (this.nostrSockets.has(d))
          return this.nostr?.websocket.message(s as ServerWebSocket<NostrSocketData>, msg)
        if ((d as { route?: string }).route === 'data')
          return this.dataRelay.message(s as ServerWebSocket<DataSocketData>, msg)
      },
      close: (s: ServerWebSocket<SocketData>, code: number, reason: string) => {
        const d = s.data
        if (this.nostrSockets.has(d))
          return this.nostr?.websocket.close(s as ServerWebSocket<NostrSocketData>, code, reason)
        if ((d as { route?: string }).route === 'data')
          return this.dataRelay.close(s as ServerWebSocket<DataSocketData>)
      },
      drain: (s: ServerWebSocket<SocketData>) => {
        if (this.nostrSockets.has(s.data))
          this.nostr?.websocket.drain?.(s as ServerWebSocket<NostrSocketData>)
      },
    }
    return {
      hostname: this.config.http.host,
      port: this.config.http.port,
      tls: this.tlsOptions(),
      maxRequestBodySize: Math.max(this.config.blossom.maxUploadBytes + (1 << 20), 8 << 20),
      fetch: (req: Request, server: BunServer) => this.fetch(req, server),
      websocket: ws,
      error: (err: Error) => {
        this.logger.error('unhandled request error', { error: err })
        return json(
          { error: { code: 'internal', message: 'internal server error' } },
          { status: 500 },
        )
      },
    }
  }

  private clientIp(req: Request, server: BunServer): string {
    if (this.config.http.trustProxy) {
      const xff = req.headers.get('x-forwarded-for')
      if (xff) return xff.split(',').pop()?.trim() ?? ''
    }
    return server.requestIP(req)?.address ?? ''
  }

  async fetch(req: Request, server: BunServer): Promise<Response | undefined> {
    const url = new URL(req.url)
    const ip = this.clientIp(req, server)
    let label = 'other'
    let res: Response | undefined
    try {
      if (this.bans.ipBanned(ip)) throw new HttpError(403, 'banned', 'your address is banned')
      if (url.pathname !== '/healthz' && url.pathname !== '/metrics' && !this.limiter.hit(ip)) {
        throw new HttpError(429, 'rate-limited', 'too many requests')
      }
      ;[label, res] = await this.route(req, url, server, ip)
    } catch (e) {
      if (!(e instanceof HttpError))
        this.logger.error('request failed', { path: url.pathname, error: e })
      res = toErrorResponse(e)
      if (
        e instanceof HttpError &&
        (url.pathname.startsWith('/a/') || url.pathname === '/upload')
      ) {
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
      }
    }
    this.http.record(label, res ? res.status : 101)
    return res
  }

  private upgrade(req: Request, server: BunServer, data: SocketData): Response | undefined {
    if (server.upgrade(req, { data })) return undefined
    throw new HttpError(400, 'upgrade-failed', 'WebSocket upgrade failed')
  }

  private isUpgrade(req: Request) {
    return req.headers.get('upgrade')?.toLowerCase() === 'websocket'
  }

  private async route(
    req: Request,
    url: URL,
    server: BunServer,
    ip: string,
  ): Promise<[string, Response | undefined]> {
    const path = url.pathname
    if (path === '/healthz') return ['healthz', this.health()]
    if (path === '/metrics') return ['metrics', this.metricsResponse(req)]
    if (path === `${ADMIN_PREFIX}/stats`) {
      const a = this.auth.authenticate(req)
      if (!a) throw new HttpError(401, 'unauthenticated', 'admin session required')
      if (!sameOrigin(req, this))
        throw new HttpError(403, 'bad-origin', 'cross-origin request refused')
      if (!this.isUpgrade(req)) return ['admin-stats', json(this.stats())]
      return ['admin-stats', this.upgrade(req, server, { route: 'stats', adminId: a.admin.id })]
    }
    if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`))
      return ['admin-api', await handleAdminApi(req, url, this, ip)]
    if (path === '/admin' || path.startsWith('/admin/'))
      return ['admin-ui', await serveAdmin(this.adminDist, path)]
    if (path === '/pay' || path.startsWith('/pay/')) return ['pay', await this.pay(req, url)]

    const am = APP_PATH.exec(path)
    if (am) {
      const appId = am[1] as string
      const rest = am[2] ?? ''
      const app = this.apps.active(appId)
      if (!app) throw new HttpError(404, 'not-found', `app ${appId} not found`)
      if (rest === '' || rest === '/')
        return ['realm', await this.nostrRoute(req, server, appId, ip)]
      if (rest === '/data') {
        if (!this.isUpgrade(req))
          throw new HttpError(426, 'upgrade-required', 'connect with a WebSocket')
        return ['data', this.upgrade(req, server, this.dataRelay.socketData(appId, ip))]
      }
      if (rest === '/turn-credentials')
        return ['turn-credentials', await handleTurnCredentials(req, appId, this)]
      const b = await this.blossom.handle(req, rest, appId, this.baseUrl(req))
      if (b) return ['blossom', b]
      throw new HttpError(404, 'not-found', 'not found')
    }
    if (path === '/') return ['relay', await this.nostrRoute(req, server, null, ip)]
    if (path === '/favicon.ico') return ['other', new Response(null, { status: 204 })]
    const b = await this.blossom.handle(req, path, '', this.baseUrl(req))
    if (b) return ['blossom', b]
    throw new HttpError(404, 'not-found', 'not found')
  }

  private async nostrRoute(
    req: Request,
    server: BunServer,
    realm: string | null,
    ip: string,
  ): Promise<Response | undefined> {
    const accept = req.headers.get('accept') ?? ''
    const ct = req.headers.get('content-type') ?? ''
    if (this.isUpgrade(req)) {
      if (!this.nostr)
        throw new HttpError(503, 'engine-unavailable', 'Nostr relay engine is not running')
      const data = this.nostr.socketData({ realm, ip })
      this.nostrSockets.add(data)
      return this.upgrade(req, server, data)
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (req.method === 'GET' && accept.includes('application/nostr+json')) {
      if (this.nostr) return this.nostr.handleInfo(req, realm)
      return json(this.nip11, {
        headers: { ...CORS_HEADERS, 'content-type': 'application/nostr+json' },
      })
    }
    if (req.method === 'POST' && ct.includes('application/nostr+json+rpc')) {
      if (!this.nostr)
        throw new HttpError(503, 'engine-unavailable', 'Nostr relay engine is not running')
      return this.nostr.handleManagement(req, realm)
    }
    if (req.method === 'GET' || req.method === 'HEAD') return this.landing(realm)
    throw new HttpError(405, 'method-not-allowed', 'method not allowed')
  }

  private landing(realm: string | null): Response {
    const name = escapeHtml(String(this.nip11.name ?? 'Beamhop relay'))
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0E1A;color:#E6E8F2;font:16px/1.5 system-ui,sans-serif;padding:16px}
h1{color:#5EEAD4}a{color:#8B7BFF}</style></head><body><main><h1>${name}</h1>
<p>${escapeHtml(String(this.nip11.description ?? ''))}</p>
<p>This is a Nostr relay${realm ? ` realm for app <b>${escapeHtml(realm)}</b>` : ''}. Connect with a WebSocket client.</p>
<p>${this.payments.enabled ? '<a href="/pay">Pay for write access</a> · ' : ''}<a href="/admin">Admin</a></p></main></body></html>`
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  // ------------------------------------------------------------ /pay

  private async pay(req: Request, url: URL): Promise<Response> {
    const path = url.pathname
    const base = this.baseUrl(req)
    if (path === '/pay' && req.method === 'GET') {
      const html = payPage({
        relayName: String(this.nip11.name ?? 'Beamhop relay'),
        plans: this.payments.plans(),
        enabled: this.payments.enabled,
        base: '',
      })
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'referrer-policy': 'same-origin',
        },
      })
    }
    if (path === '/pay/plans' && req.method === 'GET') {
      return json({
        plans: this.payments.plans(),
        enabled: this.payments.enabled,
        payments_url: `${base}/pay`,
      })
    }
    if (path === '/pay/invoice' && req.method === 'POST') {
      const body = await readJson<{ pubkey?: string; planId?: number }>(req)
      const pubkey = normalizePubkey(String(body.pubkey ?? ''))
      if (!pubkey) throw new HttpError(400, 'invalid', 'pubkey must be an npub or 64 hex chars')
      if (!this.limiter.hit(`invoice:${pubkey}`, 20))
        throw new HttpError(429, 'rate-limited', 'too many invoices')
      const inv = await this.payments.createInvoice(pubkey, Number(body.planId))
      return json(
        {
          invoice: inv.bolt11,
          paymentHash: inv.paymentHash,
          amountSats: inv.amountMsat / 1000,
          expiresAt: inv.expiresAt,
          qr: qrSvg(inv.bolt11),
        },
        { status: 201 },
      )
    }
    const im = /^\/pay\/invoice\/([0-9a-f]{64})$/.exec(path)
    if (im && req.method === 'GET') {
      const inv = await this.payments.checkInvoice(im[1] as string)
      if (!inv) throw new HttpError(404, 'not-found', 'invoice not found')
      const paidUntil = this.payments.paid().find((p) => p.pubkey === inv.pubkey)?.expiresAt ?? null
      return json({ status: inv.status, pubkey: inv.pubkey, paidUntil })
    }
    const sm = /^\/pay\/status\/([^/]+)$/.exec(path)
    if (sm && req.method === 'GET') {
      const pubkey = normalizePubkey(decodeURIComponent(sm[1] as string))
      if (!pubkey) throw new HttpError(400, 'invalid', 'pubkey must be an npub or 64 hex chars')
      const rec = this.payments.paid().find((p) => p.pubkey === pubkey)
      return json({ pubkey, paid: this.payments.isPaid(pubkey), expiresAt: rec?.expiresAt ?? null })
    }
    throw new HttpError(404, 'not-found', 'not found')
  }

  // ------------------------------------------------------------ observability

  private health(): Response {
    const ok = !!this.server
    return json(
      {
        status: ok ? (this.nostr ? 'ok' : 'degraded') : 'down',
        version: VERSION,
        uptime: Math.floor(Date.now() / 1000) - this.startedAt,
        nostr: !!this.nostr,
        turn: !!this.turn,
      },
      { status: ok ? 200 : 503 },
    )
  }

  private turnQuotaExhausted() {
    return this.apps
      .list()
      .filter((a) => a.turnMonthlyBytes > 0)
      .map((a) => ({
        app: a.id,
        used: this.meter.month(a.id, TURN_METRICS),
        quota: a.turnMonthlyBytes,
      }))
      .filter((q) => q.used >= q.quota)
  }

  alerts(): Alert[] {
    const alerts = evaluateAlerts(this.adb, {
      dataDir: this.dataDir,
      diskPercent: this.config.alerts.diskPercent,
      errorRate: this.http.errorRate(),
      errorRateThreshold: this.config.alerts.errorRate,
      certPath: this.config.http.tlsCert,
      certDays: this.config.alerts.certDays,
      turnQuotaExhausted: this.turnQuotaExhausted(),
    })
    this.alertCount = alerts.filter((a) => !a.acked).length
    return alerts
  }

  private diskStats() {
    const d = diskUsage(this.dataDir)
    return d
      ? { usedBytes: d.totalBytes - d.freeBytes, totalBytes: d.totalBytes, usedRatio: d.usedRatio }
      : { usedBytes: 0, totalBytes: 0, usedRatio: 0 }
  }

  /** Frame pushed on /api/admin/stats every second (admin SPA `StatsMessage` + relay extras). */
  stats(): Record<string, unknown> {
    let requests = 0
    for (const v of this.http.byClass.values()) requests += v
    const n = this.nostr?.stats()
    const t = this.turn?.stats()
    const uptimeSec = Math.floor(Date.now() / 1000) - this.startedAt
    const now = Date.now()
    return {
      type: 'stats',
      ts: now,
      at: now,
      uptimeSec,
      uptime: uptimeSec,
      nostr: {
        events: n?.events ?? 0,
        subscriptions: n?.subscriptions ?? 0,
        clients: n?.clients ?? 0,
        eventsPerSec: n?.eventsPerSec ?? 0,
      },
      turn: {
        allocations: t?.allocations ?? 0,
        bytesIn: t?.bytesIn ?? 0,
        bytesOut: t?.bytesOut ?? 0,
        bps: t?.bps ?? 0,
      },
      engines: { nostr: !!this.nostr, turn: !!this.turn },
      disk: this.diskStats(),
      alerts: this.alertCount,
      data: this.dataRelay.stats(),
      http: { requests, errorRate: this.http.errorRate() },
      blossom: this.blossom.stats(),
    }
  }

  private alertCount = 0

  private publishStats() {
    if (!this.server || this.server.subscriberCount(STATS_TOPIC) === 0) return
    try {
      this.server.publish(STATS_TOPIC, JSON.stringify(this.stats()))
    } catch (e) {
      this.logger.error('stats publish failed', { error: e })
    }
  }

  overview(): Record<string, unknown> {
    const certExp = certExpiry(this.config.http.tlsCert)
    const stats = this.stats()
    const alerts = this.alerts()
    const blobs = this.blossom.stats()
    return {
      // admin SPA `Overview`
      nostr: stats.nostr,
      turn: stats.turn,
      disk: stats.disk,
      uptimeSec: stats.uptimeSec,
      apps: this.apps.count(),
      blobs: { count: blobs.blobs, bytes: blobs.bytes },
      alerts,
      version: VERSION,
      startedAt: this.startedAt,
      uptime: Math.floor(Date.now() / 1000) - this.startedAt,
      counters: {
        apps: this.apps.count(),
        admins: this.auth.adminCount(),
        paidPubkeys: this.payments.paid().filter((p) => p.expiresAt > this.adb.now()).length,
        revenueSats: this.payments.revenueSats(),
        data: stats.data,
        http: stats.http,
      },
      engines: { nostr: !!this.nostr, turn: !!this.turn, turnPorts: this.turnPorts },
      tls: { enabled: !!this.config.http.tlsCert, expiresAt: certExp },
    }
  }

  private metricsResponse(req: Request): Response {
    const token = this.config.metrics.token
    if (token && req.headers.get('authorization') !== `Bearer ${token}`) {
      throw new HttpError(401, 'unauthenticated', 'metrics token required')
    }
    const g = (
      name: string,
      help: string,
      value: number,
      labels?: Record<string, string>,
    ): MetricSample => ({
      name,
      help,
      type: 'gauge',
      values: [{ value, labels }],
    })
    const n = this.nostr?.stats()
    const t = this.turn?.stats()
    const d = this.dataRelay.stats()
    const b = this.blossom.stats()
    const disk = diskUsage(this.dataDir)
    const alerts = this.alerts()
    const usage = this.meter.totalRows()
    const samples: MetricSample[] = [
      g('beamhop_up', 'Relay process is up', 1),
      {
        name: 'beamhop_build_info',
        help: 'Build information',
        type: 'gauge',
        values: [{ value: 1, labels: { version: VERSION } }],
      },
      g(
        'beamhop_uptime_seconds',
        'Seconds since start',
        Math.floor(Date.now() / 1000) - this.startedAt,
      ),
      {
        name: 'beamhop_http_requests_total',
        help: 'HTTP requests by status class',
        type: 'counter',
        values: [...this.http.byClass].map(([cls, value]) => ({ labels: { class: cls }, value })),
      },
      {
        name: 'beamhop_http_route_requests_total',
        help: 'HTTP requests by route',
        type: 'counter',
        values: [...this.http.byRoute].map(([route, value]) => ({ labels: { route }, value })),
      },
      g(
        'beamhop_http_error_ratio',
        '5xx share over the last 5 minutes',
        this.http.errorRate() ?? 0,
      ),
      g('beamhop_engine_up', 'Nostr engine running', this.nostr ? 1 : 0, { engine: 'nostr' }),
      g('beamhop_engine_up', 'TURN engine running', this.turn ? 1 : 0, { engine: 'turn' }),
      g('beamhop_nostr_events', 'Stored Nostr events', n?.events ?? 0),
      g('beamhop_nostr_subscriptions', 'Open Nostr subscriptions', n?.subscriptions ?? 0),
      g('beamhop_nostr_clients', 'Connected Nostr clients', n?.clients ?? 0),
      g(
        'beamhop_nostr_events_per_second',
        'Accepted Nostr events per second',
        n?.eventsPerSec ?? 0,
      ),
      g('beamhop_turn_allocations', 'Active TURN allocations', t?.allocations ?? 0),
      {
        name: 'beamhop_turn_bytes_total',
        help: 'TURN relayed bytes',
        type: 'counter',
        values: [
          { labels: { direction: 'in' }, value: t?.bytesIn ?? 0 },
          { labels: { direction: 'out' }, value: t?.bytesOut ?? 0 },
        ],
      },
      g('beamhop_turn_bps', 'TURN relayed bits per second', t?.bps ?? 0),
      g('beamhop_data_connections', 'Data relay WebSocket connections', d.connections),
      g('beamhop_data_peers', 'Authenticated data relay peers', d.peers),
      {
        name: 'beamhop_data_frames_total',
        help: 'Data relay frames forwarded',
        type: 'counter',
        values: [{ value: d.framesForwarded }],
      },
      {
        name: 'beamhop_app_usage_bytes_total',
        help: 'Per-app usage since process start',
        type: 'counter',
        values: usage.map((u) => ({ labels: { app: u.app, metric: u.metric }, value: u.value })),
      },
      g('beamhop_blossom_blobs', 'Stored blobs', b.blobs),
      g('beamhop_blossom_bytes', 'Stored blob bytes', b.bytes),
      g('beamhop_apps', 'Configured apps', this.apps.count()),
      g(
        'beamhop_paid_pubkeys',
        'Pubkeys with an active paid plan',
        this.payments.paid().filter((p) => p.expiresAt > this.adb.now()).length,
      ),
      g('beamhop_disk_used_ratio', 'Used fraction of the data volume', disk?.usedRatio ?? 0),
      g('beamhop_alerts_active', 'Active alerts', alerts.length),
    ]
    const exp = certExpiry(this.config.http.tlsCert)
    if (exp !== null)
      samples.push(
        g('beamhop_tls_cert_expiry_seconds', 'TLS certificate notAfter (unix seconds)', exp),
      )
    return new Response(renderPrometheus(samples), {
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    })
  }

  // ------------------------------------------------------------ backups + nostr admin

  backup(): BackupFile[] {
    this.meter.flush()
    const files = runBackup(this.backupDir, {
      admin: this.adb.db,
      nostr: join(this.dataDir, 'nostr.db'),
    })
    pruneBackups(this.backupDir, this.config.backups.retentionDays)
    this.logger.info('backup written', { files: files.map((f) => f.name) })
    return files
  }

  private scheduleBackup() {
    if (this.backupTimer) clearTimeout(this.backupTimer)
    this.backupTimer = null
    if (!this.config.backups.enabled || !this.server) return
    this.backupTimer = setTimeout(() => {
      this.safe(() => {
        this.backup()
        this.adb.audit('system', 'backup.create', 'backups', {
          scheduled: true,
          count: listBackups(this.backupDir).length,
        })
      })
      this.scheduleBackup()
    }, msUntilHour(this.config.backups.hour))
    ;(this.backupTimer as { unref?: () => void }).unref?.()
  }

  async deleteNostrEvent(id: string, realm: string | null): Promise<boolean> {
    if (!this.nostr) return false
    if (this.nostr.deleteEvent) return this.nostr.deleteEvent(id, realm)
    // Fallback: NIP-86 `banevent` with NIP-98 auth signed by the relay's own key (info.self / pubkey).
    const url = `${this.publicBase()}${realm ? `/a/${realm}` : '/'}`
    const body = JSON.stringify({ method: 'banevent', params: [id, 'deleted by admin'] })
    const payload = new Bun.CryptoHasher('sha256').update(body).digest('hex')
    const auth = signEvent(this.relaySecret, {
      kind: 27235,
      content: '',
      tags: [
        ['u', url],
        ['method', 'POST'],
        ['payload', payload],
      ],
    })
    const res = await this.nostr.handleManagement(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/nostr+json+rpc',
          authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
        },
        body,
      }),
      realm,
    )
    if (!res.ok) return false
    const j = (await res.json().catch(() => ({}))) as { error?: unknown }
    return !j.error
  }
}
