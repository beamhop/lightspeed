// In-browser mock of the relay admin API: a fetch implementation plus a fake stats WebSocket.
// Enabled with ?mock=1 or VITE_MOCK=1; also used by the unit tests.

import { normalizePolicy } from '../api'
import type { WsFactory, WsLike } from '../stats'
import type { App, NostrEvent, Policy, StatsMessage } from '../types'
import { createMockDb, type MockDb, prng } from './data'

export interface MockOptions {
  db?: MockDb
  latencyMs?: number
  /** Stats tick interval for the fake WebSocket. */
  tickMs?: number
  /** Start already signed in (handy for screenshots/tests). */
  signedIn?: boolean
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const err = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } })

export function createMockApi(opts: MockOptions = {}) {
  const db = opts.db ?? createMockDb()
  if (opts.signedIn) db.loggedIn = true
  const rnd = prng(99)
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const nowSec = () => Math.floor(Date.now() / 1000)
  const audit = (action: string, scope: string, details?: Record<string, unknown>) => {
    db.audit.unshift({
      id: `aud-${hex(6)}`,
      ts: nowSec(),
      actor: db.me.pubkey ?? db.me.username ?? db.me.id,
      action,
      scope,
      ip: '127.0.0.1',
      ...(details ? { details } : {}),
    })
  }
  const publicApp = (a: MockDb['apps'][number]): App => {
    const { turnSecret: _t, apiKey: _k, ...rest } = a
    return rest
  }
  const meBody = () => ({ ...db.me, sessionId: 'sess-current', bootstrapPending: false })

  let lastStats = makeStats()
  function makeStats(): StatsMessage {
    const t = Date.now()
    const wave = Math.sin(t / 9000)
    db.totalEvents += Math.floor(20 + rnd() * 40)
    return {
      type: 'stats',
      ts: t,
      nostr: {
        events: db.totalEvents,
        subscriptions: db.subscriptions.length + Math.floor(rnd() * 6),
        clients: 41 + Math.floor(wave * 6 + rnd() * 4),
        eventsPerSec: Math.max(0, 28 + wave * 12 + (rnd() - 0.5) * 10),
      },
      turn: {
        allocations: db.allocations.length,
        bytesIn: 0,
        bytesOut: 0,
        bps: Math.max(0, (38 + wave * 15 + (rnd() - 0.5) * 12) * 1e6),
      },
      disk: { usedBytes: 61.4 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      uptimeSec: Math.floor((t - db.startedAt) / 1000),
      alerts: db.alerts.filter((a) => !a.acknowledged).length,
    }
  }

  async function route(
    method: string,
    path: string,
    q: URLSearchParams,
    body: any,
  ): Promise<Response> {
    const m = (re: RegExp) => re.exec(path)
    let r: RegExpExecArray | null

    // ---- auth (public) ----
    if (method === 'POST' && path === '/auth/challenge') return json(200, { challenge: hex(32) })
    if (method === 'POST' && path === '/auth/nostr') {
      const ev = body?.event as NostrEvent | undefined
      if (ev?.kind !== 27235) return err(400, 'bad_event', 'Expected a kind 27235 event')
      db.loggedIn = true
      db.me = { id: 'adm-1', pubkey: ev.pubkey, role: 'owner', method: 'nostr' }
      audit('auth.login', 'session')
      return json(200, meBody())
    }
    if (method === 'POST' && path === '/auth/password') {
      if (!body?.username || !body?.password)
        return err(400, 'missing', 'Username and password required')
      if (body.password === 'wrong')
        return err(401, 'invalid_credentials', 'Invalid username, password or code')
      if (!/^\d{6}$/.test(String(body.totp ?? '')))
        return err(401, 'totp_required', 'Enter the 6-digit code from your authenticator')
      db.loggedIn = true
      db.me = { id: 'adm-2', username: body.username, role: 'admin', method: 'password' }
      audit('auth.login', 'session')
      return json(200, meBody())
    }
    if (method === 'POST' && path === '/auth/bootstrap') {
      if (!body?.token) return err(400, 'missing', 'Bootstrap token required')
      if (body.token === 'used')
        return err(409, 'already_claimed', 'This relay already has an owner')
      db.loggedIn = true
      db.me = body.pubkey
        ? { id: 'adm-1', pubkey: body.pubkey, role: 'owner', method: 'bootstrap' }
        : { id: 'adm-1', username: body.username, role: 'owner', method: 'bootstrap' }
      audit('auth.bootstrap', 'relay')
      return json(200, {
        ...meBody(),
        ...(body.pubkey
          ? {}
          : {
              totpUri: `otpauth://totp/Beamhop:${body.username}?secret=${hex(32)
                .toUpperCase()
                .replace(/[0189]/g, 'A')}&issuer=Beamhop`,
            }),
      })
    }
    if (!db.loggedIn) return err(401, 'unauthorized', 'Sign in required')
    if (method === 'POST' && path === '/auth/logout') {
      db.loggedIn = false
      return json(200, {})
    }
    if (method === 'GET' && path === '/me') return json(200, meBody())

    // ---- overview ----
    if (method === 'GET' && path === '/overview') {
      const s = lastStats
      return json(200, {
        nostr: s.nostr,
        turn: s.turn,
        disk: s.disk,
        uptimeSec: s.uptimeSec,
        version: '0.1.0-mock',
        apps: db.apps.length,
        blobs: { count: db.blobs.length, bytes: db.blobs.reduce((a, b) => a + b.size, 0) },
        alerts: db.alerts,
      })
    }
    if (method === 'POST' && (r = m(/^\/overview\/alerts\/([^/]+)\/ack$/))) {
      const a = db.alerts.find((x) => x.id === r?.[1])
      if (!a) return err(404, 'not_found', 'No such alert')
      a.acknowledged = true
      audit('alerts.ack', a.id)
      return json(200, {})
    }

    // ---- apps ----
    if (path === '/apps' && method === 'GET') return json(200, db.apps.map(publicApp))
    if (path === '/apps' && method === 'POST') {
      if (!body?.name?.trim()) return err(400, 'invalid', 'Name is required')
      const app = {
        id: hex(12),
        name: body.name.trim(),
        description: body.description ?? '',
        createdAt: nowSec(),
        enabled: true,
        plan: body.plan ?? 'free',
        quotas: { maxAllocations: 20, maxMbps: 10, gbPerMonth: 50 },
        turnSecret: hex(40),
        apiKey: `bh_${hex(32)}`,
        usage: { bytesMonth: 0, allocations: 0, events: 0, blobsBytes: 0 },
        turnSecretHint: '',
        apiKeyHint: '',
      }
      app.turnSecretHint = `…${app.turnSecret.slice(-4)}`
      app.apiKeyHint = `…${app.apiKey.slice(-4)}`
      db.apps.unshift(app as MockDb['apps'][number])
      audit('apps.create', app.id, { name: app.name })
      return json(201, {
        ...publicApp(app as MockDb['apps'][number]),
        turnSecret: app.turnSecret,
        apiKey: app.apiKey,
      })
    }
    if ((r = m(/^\/apps\/([^/]+)(\/[a-z-]+)?$/))) {
      const app = db.apps.find((a) => a.id === r?.[1])
      if (!app) return err(404, 'not_found', 'No such app')
      const sub = r[2]
      if (!sub && method === 'GET') return json(200, publicApp(app))
      if (!sub && method === 'PATCH') {
        Object.assign(app, body, body?.quotas ? { quotas: { ...app.quotas, ...body.quotas } } : {})
        audit('apps.update', app.id, body)
        return json(200, publicApp(app))
      }
      if (!sub && method === 'DELETE') {
        db.apps = db.apps.filter((a) => a !== app)
        audit('apps.delete', app.id)
        return json(200, {})
      }
      if (sub === '/rotate-turn-secret' && method === 'POST') {
        app.turnSecret = hex(40)
        app.turnSecretHint = `…${app.turnSecret.slice(-4)}`
        audit('apps.rotate-turn-secret', app.id)
        return json(200, { turnSecret: app.turnSecret })
      }
      if (sub === '/rotate-api-key' && method === 'POST') {
        app.apiKey = `bh_${hex(32)}`
        app.apiKeyHint = `…${app.apiKey.slice(-4)}`
        audit('apps.rotate-api-key', app.id)
        return json(200, { apiKey: app.apiKey })
      }
      if (sub === '/usage' && method === 'GET') {
        const to = nowSec()
        const points = Array.from({ length: 30 }, (_, i) => ({
          ts: to - (29 - i) * 86400,
          bytesIn: Math.floor(rnd() * 2e9),
          bytesOut: Math.floor(rnd() * 2e9),
          allocations: Math.floor(rnd() * 40),
          events: Math.floor(rnd() * 4000),
        }))
        return json(200, {
          appId: app.id,
          from: points[0]?.ts,
          to,
          points,
          totals: {
            bytes: points.reduce((a, p) => a + p.bytesIn + p.bytesOut, 0),
            events: points.reduce((a, p) => a + p.events, 0),
            peakAllocations: Math.max(...points.map((p) => p.allocations)),
          },
        })
      }
    }

    // ---- nostr ----
    if (method === 'GET' && path === '/nostr/events') {
      let list = db.events
      const kinds = q.get('kind')?.split(',').filter(Boolean).map(Number)
      if (kinds?.length) list = list.filter((e) => kinds.includes(e.kind))
      const author = q.get('author')
      if (author) list = list.filter((e) => e.pubkey.startsWith(author))
      const tag = q.get('tag')
      if (tag) {
        const [k, v] = tag.split(':')
        list = list.filter((e) => e.tags.some((t) => t[0] === k && (!v || t[1] === v)))
      }
      const search = q.get('search')?.toLowerCase()
      if (search) list = list.filter((e) => e.content.toLowerCase().includes(search))
      const until = Number(q.get('until') ?? 0)
      if (until) list = list.filter((e) => e.created_at < until)
      return json(200, list.slice(0, Number(q.get('limit') ?? 50)))
    }
    if (method === 'DELETE' && (r = m(/^\/nostr\/events\/([^/]+)$/))) {
      db.events = db.events.filter((e) => e.id !== r?.[1])
      audit('nostr.delete-event', r[1] as string)
      return json(200, {})
    }
    if (method === 'GET' && path === '/nostr/subscriptions') return json(200, db.subscriptions)

    // ---- policies / nip11 ----
    if ((r = m(/^\/policies\/([^/]+)$/))) {
      const realm = decodeURIComponent(r[1] as string)
      if (method === 'GET') return json(200, db.policies[realm] ?? normalizePolicy(null))
      if (method === 'PUT') {
        db.policies[realm] = normalizePolicy(body as Policy)
        audit('policies.put', realm)
        return json(200, db.policies[realm])
      }
    }
    if (path === '/nip11') {
      if (method === 'GET') return json(200, db.nip11)
      if (method === 'PUT') {
        db.nip11 = body
        audit('nip11.put', 'relay')
        return json(200, db.nip11)
      }
    }

    // ---- turn / bans ----
    if (method === 'GET' && path === '/turn/allocations') {
      for (const a of db.allocations) {
        a.bytesIn += Math.floor(rnd() * 2e6)
        a.bytesOut += Math.floor(rnd() * 2e6)
      }
      return json(200, db.allocations)
    }
    if (method === 'DELETE' && (r = m(/^\/turn\/allocations\/([^/]+)$/))) {
      const before = db.allocations.length
      db.allocations = db.allocations.filter((a) => a.id !== r?.[1])
      if (before === db.allocations.length) return err(404, 'not_found', 'No such allocation')
      audit('turn.kill', r[1] as string)
      return json(200, {})
    }
    if (path === '/bans' && method === 'GET') return json(200, db.bans)
    if (path === '/bans' && method === 'POST') {
      if (!body?.ip) return err(400, 'invalid', 'IP required')
      const ban = {
        id: `ban-${hex(6)}`,
        ip: body.ip,
        reason: body.reason,
        createdAt: nowSec(),
        expiresAt: body.durationSec ? nowSec() + body.durationSec : null,
        createdBy: db.me.pubkey ?? db.me.username,
      }
      db.bans.unshift(ban)
      audit('bans.add', body.ip)
      return json(201, ban)
    }
    if (method === 'DELETE' && (r = m(/^\/bans\/(.+)$/))) {
      const key = decodeURIComponent(r[1] as string)
      db.bans = db.bans.filter((b) => b.id !== key && b.ip !== key)
      audit('bans.remove', key)
      return json(200, {})
    }

    // ---- media ----
    if (method === 'GET' && path === '/media/blobs') {
      let list = db.blobs
      const app = q.get('app')
      const pk = q.get('pubkey')
      if (app) list = list.filter((b) => b.app === app)
      if (pk) list = list.filter((b) => b.pubkey.startsWith(pk))
      return json(200, list)
    }
    if (method === 'DELETE' && (r = m(/^\/media\/blobs\/([^/]+)$/))) {
      db.blobs = db.blobs.filter((b) => b.sha256 !== r?.[1])
      audit('media.delete', r[1] as string)
      return json(200, {})
    }

    // ---- payments ----
    if (path === '/payments/plans' && method === 'GET') return json(200, db.plans)
    if (path === '/payments/plans' && method === 'POST') {
      const plan = { ...body, id: hex(8) }
      db.plans.push(plan)
      audit('payments.create-plan', plan.id)
      return json(201, plan)
    }
    if (path === '/payments/invoices') return json(200, db.invoices)
    if (path === '/payments/paid') return json(200, db.paid)
    if (path === '/payments/nwc' && method === 'GET') return json(200, db.nwc)
    if (path === '/payments/nwc' && method === 'PUT') {
      if (body?.uri === undefined) {
        db.nwc = { ...db.nwc, lnurl: body?.lnurl ?? db.nwc.lnurl }
        audit('payments.lnurl', 'wallet')
        return json(200, db.nwc)
      }
      db.nwc = body.uri
        ? {
            connected: true,
            walletPubkey: hex(64),
            relay: 'wss://relay.example/nwc',
            lnurl: body.lnurl ?? db.nwc.lnurl,
            balanceSats: 0,
          }
        : { connected: false, lnurl: body?.lnurl ?? db.nwc.lnurl }
      audit('payments.nwc', 'wallet')
      return json(200, db.nwc)
    }

    // ---- admins ----
    if (path === '/admins' && method === 'GET') return json(200, db.admins)
    if (path === '/admins' && method === 'POST') {
      const a = {
        id: `adm-${hex(4)}`,
        pubkey: body.pubkey,
        username: body.username,
        role: body.role ?? 'admin',
        totpEnabled: false,
        createdAt: nowSec(),
        lastLoginAt: null,
      }
      db.admins.push(a)
      audit('admins.add', a.id)
      return json(
        201,
        body.username
          ? {
              ...a,
              totpUri: `otpauth://totp/Beamhop:${body.username}?secret=${hex(16).toUpperCase()}`,
            }
          : a,
      )
    }
    if ((r = m(/^\/admins\/([^/]+)(\/reset-totp)?$/))) {
      const a = db.admins.find((x) => x.id === r?.[1])
      if (!a) return err(404, 'not_found', 'No such admin')
      if (r[2] && method === 'POST') {
        a.totpEnabled = false
        audit('admins.reset-totp', a.id)
        return json(200, {})
      }
      if (method === 'DELETE') {
        if (a.role === 'owner' && db.admins.filter((x) => x.role === 'owner').length === 1)
          return err(409, 'last_owner', 'Cannot remove the last owner')
        db.admins = db.admins.filter((x) => x !== a)
        db.sessions = db.sessions.filter((s) => s.adminId !== a.id)
        audit('admins.remove', a.id)
        return json(200, {})
      }
    }
    if (path === '/sessions' && method === 'GET') return json(200, db.sessions)
    if (method === 'DELETE' && (r = m(/^\/sessions\/([^/]+)$/))) {
      db.sessions = db.sessions.filter((s) => s.id !== r?.[1])
      audit('sessions.revoke', r[1] as string)
      if (r[1] === 'sess-current') db.loggedIn = false
      return json(200, {})
    }
    if (path === '/audit') {
      const limit = Number(q.get('limit') ?? 100)
      return json(200, db.audit.slice(0, limit))
    }

    // ---- settings / backups ----
    if (path === '/settings' && method === 'GET') return json(200, db.settings)
    if (path === '/settings' && method === 'PUT') {
      db.settings = body
      audit('settings.put', 'relay')
      return json(200, db.settings)
    }
    if (path === '/backups' && method === 'GET') return json(200, db.backups)
    if (path === '/backups' && method === 'POST') {
      const b = {
        id: `bk-${hex(4)}`,
        createdAt: nowSec(),
        sizeBytes: 420e6,
        files: ['nostr.db', 'admin.db'],
        status: 'done' as const,
      }
      db.backups.unshift(b)
      audit('backups.run', b.id)
      return json(201, b)
    }

    return err(404, 'not_found', `No mock route for ${method} ${path}`)
  }

  const mockFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://mock.local',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const prefix = '/api/admin'
    if (!url.pathname.startsWith(prefix))
      return err(404, 'not_found', 'Mock only serves /api/admin')
    let body: unknown = null
    if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body)
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs))
    return route(method, url.pathname.slice(prefix.length) || '/', url.searchParams, body)
  }

  /** Fake stats WebSocket: opens async, emits a stats frame every tick while signed in. */
  const createSocket: WsFactory = () => {
    const tick = opts.tickMs ?? 1000
    let timer: ReturnType<typeof setInterval> | null = null
    const sock: WsLike = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close() {
        if (timer) clearInterval(timer)
        timer = null
        if (sock.readyState === 3) return
        sock.readyState = 3
        sock.onclose?.({ code: 1000 })
      },
    }
    setTimeout(() => {
      if (sock.readyState === 3) return
      if (!db.loggedIn) {
        sock.readyState = 3
        sock.onclose?.({ code: 4401, reason: 'unauthorized' })
        return
      }
      sock.readyState = 1
      sock.onopen?.({})
      const emit = () => {
        lastStats = makeStats()
        sock.onmessage?.({ data: JSON.stringify(lastStats) })
      }
      emit()
      timer = setInterval(emit, tick)
    }, 5)
    return sock
  }

  return { db, fetch: mockFetch as typeof fetch, createSocket }
}

export type MockApi = ReturnType<typeof createMockApi>

/** Pre-fill the stats history so charts aren't empty on first paint. */
export function seedHistory(count = 90, now = Date.now()): StatsMessage[] {
  const rnd = prng(5)
  return Array.from({ length: count }, (_, i) => {
    const t = now - (count - i) * 1000
    const wave = Math.sin(t / 9000)
    return {
      type: 'stats' as const,
      ts: t,
      nostr: {
        events: 0,
        subscriptions: 20,
        clients: 41 + Math.floor(wave * 6),
        eventsPerSec: 28 + wave * 12 + (rnd() - 0.5) * 10,
      },
      turn: {
        allocations: 14,
        bytesIn: 0,
        bytesOut: 0,
        bps: (38 + wave * 15 + (rnd() - 0.5) * 12) * 1e6,
      },
    }
  })
}
