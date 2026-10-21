// Drives the relay's admin API through the admin SPA's own typed client (@beamhop/relay-admin/api)
// so response shapes stay compatible with what the UI reads.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApi } from '@beamhop/relay-admin/api'
import { startTestRelay, type TestRelay, WsClient } from './testing'
import { getPublicKey, randomHex, signEvent } from './util/crypto'

let t: TestRelay
let cookie = ''
const sk = randomHex(32)
const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Fw.example&secret=${'c'.repeat(64)}`

/** fetch that behaves like a same-origin browser: sends Origin + the session cookie, keeps Set-Cookie. */
const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('origin', t.base)
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(input, { ...init, headers })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0] as string
  return res
}) as typeof fetch

let api: ReturnType<typeof createApi>

beforeAll(async () => {
  t = await startTestRelay()
  api = createApi({ baseUrl: `${t.base}/api/admin`, fetch: browserFetch })
})
afterAll(() => t.close())

describe('admin SPA client against the relay', () => {
  test('bootstrap + me', async () => {
    const me = await api.auth.bootstrap({
      token: t.bootstrapToken as string,
      pubkey: getPublicKey(sk),
    })
    expect(me).toMatchObject({ role: 'owner', method: 'bootstrap', pubkey: getPublicKey(sk) })
    expect(me.sessionId).toBeTruthy()
    const again = await api.auth.me()
    expect(again.sessionId).toBe(me.sessionId)
    expect(again.bootstrapPending).toBe(false)
  })

  test('nostr login with challenge, u and method tags', async () => {
    const { challenge } = await api.auth.challenge()
    const ev = signEvent(sk, {
      kind: 27235,
      content: '',
      tags: [
        ['challenge', challenge],
        ['u', `${t.base}/api/admin/auth/nostr`],
        ['method', 'POST'],
      ],
    })
    const me = await api.auth.nostr(ev)
    expect(me.method).toBe('nostr')
  })

  test('overview + stats frame', async () => {
    const o = await api.overview.get()
    expect(o.nostr).toMatchObject({ events: expect.any(Number), clients: expect.any(Number) })
    expect(o.turn).toMatchObject({ allocations: 0 })
    expect(o.disk.totalBytes).toBeGreaterThan(0)
    expect(typeof o.uptimeSec).toBe('number')
    expect(o.apps).toBe(0)
    expect(Array.isArray(o.alerts)).toBe(true)
    const ws = await WsClient.open(`${t.wsBase}/api/admin/stats`, { cookie, origin: t.base })
    const frame = await ws.next((m) => m.type === 'stats')
    expect(frame).toMatchObject({
      type: 'stats',
      ts: expect.any(Number),
      uptimeSec: expect.any(Number),
      nostr: {
        events: expect.any(Number),
        subscriptions: expect.any(Number),
        clients: expect.any(Number),
        eventsPerSec: expect.any(Number),
      },
      turn: {
        allocations: 0,
        bytesIn: expect.any(Number),
        bytesOut: expect.any(Number),
        bps: expect.any(Number),
      },
      disk: { usedBytes: expect.any(Number), totalBytes: expect.any(Number) },
      alerts: expect.any(Number),
    })
    ws.close()
  })

  test('apps: create, quotas, enable/disable, rotate, usage', async () => {
    const created = await api.apps.create({ name: 'Chat', description: 'demo' })
    expect(created).toMatchObject({ id: 'chat', name: 'Chat', description: 'demo', enabled: true })
    expect(created.turnSecret).toHaveLength(64)
    expect(created.apiKey).toStartWith('bhk_')
    const list = await api.apps.list()
    expect(list.map((a) => a.id)).toEqual(['chat'])
    expect(list[0]?.turnSecretHint).toBe(`…${created.turnSecret.slice(-4)}`)
    const updated = await api.apps.update('chat', {
      enabled: false,
      quotas: {
        maxAllocations: 3,
        maxMbps: 2,
        gbPerMonth: 1.5,
        maxStorageBytes: 1000,
        maxBlobBytes: 100,
        allowedMime: ['image/*'],
      },
    })
    expect(updated.enabled).toBe(false)
    expect(updated.quotas).toEqual({
      maxAllocations: 3,
      maxMbps: 2,
      gbPerMonth: 1.5,
      maxStorageBytes: 1000,
      maxBlobBytes: 100,
      allowedMime: ['image/*'],
    })
    const app = t.relay.ctx.apps.get('chat')
    expect(app).toMatchObject({
      turnMaxBps: 2_000_000,
      turnMonthlyBytes: 1_500_000_000,
      disabled: true,
    })
    await api.apps.update('chat', { enabled: true })
    const rs = await api.apps.rotateTurnSecret('chat')
    expect(rs.turnSecret).not.toBe(created.turnSecret)
    const rk = await api.apps.rotateApiKey('chat')
    expect(rk.apiKey).not.toBe(created.apiKey)
    const usage = await api.apps.usage('chat')
    expect(usage).toMatchObject({
      appId: 'chat',
      points: expect.any(Array),
      totals: { bytes: 0, peakAllocations: 0 },
    })
  })

  test('policies round-trip and translate to the engine shape', async () => {
    const p = await api.policies.get('_global')
    expect(p.rateLimits.perIp).toEqual({ events: 0, windowSec: 60 })
    await api.policies.put('_global', {
      ...p,
      rateLimits: { perIp: { events: 10, windowSec: 60 }, perPubkey: { events: 0, windowSec: 60 } },
      maxEventSize: 4096,
      retention: [{ kinds: [1], maxAgeSec: 86400 }],
    })
    const back = await api.policies.get('_global')
    expect(back.maxEventSize).toBe(4096)
    const engine = t.nostr().opts.policy?.get(null)
    expect(engine?.rateLimits?.ip).toEqual({ rate: 10 / 60, burst: 10 })
    expect(engine?.rateLimits?.pubkey).toBeUndefined()
    expect(engine?.maxEventBytes).toBe(4096)
    expect(engine?.retention).toEqual([{ kinds: [1], maxAgeSeconds: 86400 }])
    expect(engine?.admins).toEqual([t.nostr().info.self as string])
  })

  test('nip11, events, subscriptions', async () => {
    const info = await api.nip11.put({ name: 'Renamed relay' })
    expect(info.name).toBe('Renamed relay')
    expect((await api.nip11.get()).name).toBe('Renamed relay')
    const e = signEvent(sk, { kind: 1, content: 'x', tags: [['t', 'beam']] })
    await t.nostr().publish(e, 'chat')
    expect(await api.nostr.events({ kind: [1, 7], tag: 't:beam', realm: 'chat' })).toHaveLength(1)
    expect(await api.nostr.events({ kind: 1 })).toHaveLength(0)
    expect(Array.isArray(await api.nostr.subscriptions())).toBe(true)
  })

  test('bans by IP with duration; delete by id or IP', async () => {
    const ban = await api.bans.add({ ip: '203.0.113.9', reason: 'abuse', durationSec: 3600 })
    expect(ban).toMatchObject({ ip: '203.0.113.9', reason: 'abuse' })
    expect(ban.expiresAt).toBeGreaterThan(Date.now() / 1000)
    expect((await api.bans.list()).map((b) => b.ip)).toEqual(['203.0.113.9'])
    await api.bans.remove('203.0.113.9')
    expect(await api.bans.list()).toEqual([])
  })

  test('payments: wallet, lnurl keeps wallet, plans', async () => {
    expect((await api.payments.nwc()).connected).toBe(false)
    const st = await api.payments.setNwc({ uri: NWC })
    expect(st).toMatchObject({
      connected: true,
      walletPubkey: 'b'.repeat(64),
      relay: 'wss://w.example',
    })
    const kept = await api.payments.setNwc({ lnurl: 'pay@relay.example' })
    expect(kept).toMatchObject({ connected: true, lnurl: 'pay@relay.example' })
    const plan = await api.payments.createPlan({
      name: 'Month',
      priceSats: 1000,
      periodDays: 30,
      active: true,
    })
    expect(plan).toMatchObject({ name: 'Month', priceSats: 1000, periodDays: 30, active: true })
    expect((await api.payments.plans()).length).toBe(1)
    expect(await api.payments.invoices()).toEqual([])
    expect(await api.payments.paid()).toEqual([])
    expect((await api.payments.setNwc({ uri: null })).connected).toBe(false)
  })

  test('admins, sessions, audit', async () => {
    const a = await api.admins.add({
      username: 'ops',
      password: 'long enough password',
      role: 'admin',
    })
    expect(a).toMatchObject({ username: 'ops', role: 'admin', totpEnabled: true })
    expect(a.totpUri).toStartWith('otpauth://')
    const reset = await api.admins.resetTotp(String(a.id))
    expect(reset.totpUri).toStartWith('otpauth://')
    await api.admins.remove(String(a.id))
    const admins = await api.admins.list()
    expect(admins.map((x) => x.role)).toEqual(['owner'])
    const sessions = await api.admins.sessions()
    expect(sessions.some((s) => s.current)).toBe(true)
    expect(sessions[0]?.label).toBeTruthy()
    const audit = await api.admins.audit({ limit: 200 })
    expect(audit[0]).toMatchObject({
      ts: expect.any(Number),
      actor: expect.any(String),
      scope: expect.any(String),
    })
    expect(audit.map((x) => x.action)).toContain('admin.reset-totp')
  })

  test('settings in the SPA shape', async () => {
    const s = await api.settings.get()
    expect(s.listeners.https).toBe(0)
    expect(s.logging.level).toBe('info')
    const next = await api.settings.put({
      ...s,
      logging: { ...s.logging, level: 'warn' },
      backups: { ...s.backups, retentionDays: 7 },
    })
    expect(next.logging.level).toBe('warn')
    expect(next.backups.retentionDays).toBe(7)
    expect(t.relay.ctx.config.backups.retentionDays).toBe(7)
    const off = await api.settings.put({ ...next, metrics: { ...next.metrics, enabled: false } })
    expect(off.metrics).toEqual({ enabled: false, path: '/metrics', tokenSet: false })
    expect(t.relay.ctx.config.metrics.enabled).toBe(false)
    await api.settings.put({ ...off, metrics: { ...off.metrics, enabled: true } })
  })

  test('backups and alert ack', async () => {
    const b = await api.backups.run()
    const id = b.id
    expect(typeof id).toBe('string')
    expect(b.status).toBe('done')
    expect(b.files.some((f) => f.startsWith('admin-'))).toBe(true)
    const list = await api.backups.list()
    expect(list[0]?.id).toBe(id)
    await api.overview.ackAlert('disk')
  })

  test('logout', async () => {
    await api.auth.logout()
    await expect(api.auth.me()).rejects.toMatchObject({ status: 401 })
  })
})
