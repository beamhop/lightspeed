import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { api, cookieFrom, startTestRelay, type TestRelay } from './testing'
import { getPublicKey, randomHex, signEvent, totp } from './util/crypto'

let t: TestRelay
const adminSk = randomHex(32)
const adminPk = getPublicKey(adminSk)
let cookie = ''

beforeAll(async () => {
  t = await startTestRelay()
})
afterAll(() => t.close())

async function nostrLogin(sk: string) {
  const { body } = await api(t.base, '/api/admin/auth/challenge', { body: {} })
  const event = signEvent(sk, { kind: 27235, content: '', tags: [['challenge', body.challenge]] })
  return { res: await api(t.base, '/api/admin/auth/nostr', { body: { event } }), event }
}

describe('bootstrap', () => {
  test('first run mints a token; status reports pending', async () => {
    expect(t.bootstrapToken).toMatch(/^bht_[0-9a-f]{40}$/)
    const s = await api(t.base, '/api/admin/auth/status')
    expect(s.body).toEqual({ bootstrapPending: true, admins: false })
  })

  test('protected routes need a session', async () => {
    const r = await api(t.base, '/api/admin/apps')
    expect(r.status).toBe(401)
    expect(r.body).toEqual({
      error: { code: 'unauthenticated', message: 'admin session required' },
    })
  })

  test('wrong token is refused and audited', async () => {
    const r = await api(t.base, '/api/admin/auth/bootstrap', {
      body: { token: 'bht_nope', pubkey: adminPk },
    })
    expect(r.status).toBe(401)
  })

  test('valid token claims the first admin and returns a session cookie', async () => {
    const r = await api(t.base, '/api/admin/auth/bootstrap', {
      body: { token: t.bootstrapToken, pubkey: adminPk },
    })
    expect(r.status).toBe(200)
    expect(r.body.admin.pubkey).toBe(adminPk)
    const sc = r.headers.get('set-cookie') ?? ''
    expect(sc).toContain('bh_admin=')
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('SameSite=Strict')
    cookie = cookieFrom(r.headers)
    const me = await api(t.base, '/api/admin/me', { cookie })
    expect(me.body.admin.pubkey).toBe(adminPk)
    expect(me.body.session.method).toBe('bootstrap')
  })

  test('token is single use', async () => {
    const r = await api(t.base, '/api/admin/auth/bootstrap', {
      body: { token: t.bootstrapToken, pubkey: adminPk },
    })
    expect(r.status).toBe(409)
    expect((await api(t.base, '/api/admin/auth/status')).body.bootstrapPending).toBe(false)
  })
})

describe('CSRF protection', () => {
  test('cross-origin writes are refused', async () => {
    const r = await api(t.base, '/api/admin/apps', {
      cookie,
      body: { name: 'x' },
      origin: 'https://evil.example',
    })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('bad-origin')
  })

  test('non-JSON bodies are refused', async () => {
    const r = await fetch(`${t.base}/api/admin/apps`, {
      method: 'POST',
      headers: { cookie, origin: t.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    })
    expect(r.status).toBe(415)
  })

  test('cross-site fetch metadata without Origin is refused', async () => {
    const r = await api(t.base, '/api/admin/apps', {
      cookie,
      body: { name: 'x' },
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(r.status).toBe(403)
  })
})

describe('nostr login', () => {
  test('signed challenge from an allowlisted pubkey logs in', async () => {
    const { res } = await nostrLogin(adminSk)
    expect(res.status).toBe(200)
    expect(res.body.session.method).toBe('nostr')
    const c = cookieFrom(res.headers)
    expect((await api(t.base, '/api/admin/me', { cookie: c })).body.admin.pubkey).toBe(adminPk)
  })

  test('non-admin pubkey is forbidden', async () => {
    const { res } = await nostrLogin(randomHex(32))
    expect(res.status).toBe(403)
  })

  test('challenge cannot be replayed; wrong kind and bad sig rejected', async () => {
    const { res, event } = await nostrLogin(adminSk)
    expect(res.status).toBe(200)
    expect((await api(t.base, '/api/admin/auth/nostr', { body: { event } })).status).toBe(401)
    const { body } = await api(t.base, '/api/admin/auth/challenge', { body: {} })
    const wrongKind = signEvent(adminSk, { kind: 1, content: body.challenge, tags: [] })
    expect(
      (await api(t.base, '/api/admin/auth/nostr', { body: { event: wrongKind } })).status,
    ).toBe(401)
    const good = signEvent(adminSk, { kind: 27235, content: body.challenge, tags: [] })
    expect(
      (
        await api(t.base, '/api/admin/auth/nostr', {
          body: { event: { ...good, sig: '0'.repeat(128) } },
        })
      ).status,
    ).toBe(401)
    const stale = signEvent(adminSk, {
      kind: 27235,
      content: body.challenge,
      tags: [],
      created_at: Math.floor(Date.now() / 1000) - 3600,
    })
    expect((await api(t.base, '/api/admin/auth/nostr', { body: { event: stale } })).status).toBe(
      401,
    )
    // content-carried challenge works
    expect((await api(t.base, '/api/admin/auth/nostr', { body: { event: good } })).status).toBe(200)
  })
})

describe('password + TOTP', () => {
  let secret = ''
  let adminId = 0
  test('admin creates a password admin and receives the TOTP secret once', async () => {
    const r = await api(t.base, '/api/admin/admins', {
      cookie,
      body: { username: 'ops', password: 'correct horse battery' },
    })
    expect(r.status).toBe(201)
    secret = r.body.totp.secret
    adminId = r.body.admin.id
    expect(r.body.totp.uri).toStartWith('otpauth://totp/')
    expect(r.body.admin.hasTotp).toBe(true)
    const list = await api(t.base, '/api/admin/admins', { cookie })
    expect(list.body.admins.map((a: { username: string | null }) => a.username)).toContain('ops')
    expect(JSON.stringify(list.body)).not.toContain(secret)
  })

  test('weak passwords are rejected', async () => {
    const r = await api(t.base, '/api/admin/admins', {
      cookie,
      body: { username: 'weak', password: 'short' },
    })
    expect(r.status).toBe(400)
  })

  test('login needs password and a fresh TOTP code', async () => {
    const bad = await api(t.base, '/api/admin/auth/password', {
      body: { username: 'ops', password: 'wrong password!', totp: totp(secret) },
    })
    expect(bad.status).toBe(401)
    const noTotp = await api(t.base, '/api/admin/auth/password', {
      body: { username: 'ops', password: 'correct horse battery' },
    })
    expect(noTotp.status).toBe(401)
    const code = totp(secret)
    const ok = await api(t.base, '/api/admin/auth/password', {
      body: { username: 'ops', password: 'correct horse battery', totp: code },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.admin.username).toBe('ops')
    // same code cannot be used twice
    const replay = await api(t.base, '/api/admin/auth/password', {
      body: { username: 'ops', password: 'correct horse battery', totp: code },
    })
    expect(replay.status).toBe(401)
    const unknown = await api(t.base, '/api/admin/auth/password', {
      body: { username: 'ghost', password: 'whatever12345', totp: code },
    })
    expect(unknown.status).toBe(401)
  })

  test('sessions can be listed and revoked; logout clears the cookie', async () => {
    const login = await nostrLogin(adminSk)
    const c = cookieFrom(login.res.headers)
    const sessions = await api(t.base, '/api/admin/sessions', { cookie })
    const target = sessions.body.sessions.find(
      (s: { id: string }) => s.id === login.res.body.session.id,
    )
    expect(target).toBeDefined()
    expect(
      (await api(t.base, `/api/admin/sessions/${target.id}`, { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect((await api(t.base, '/api/admin/me', { cookie: c })).status).toBe(401)

    const l2 = cookieFrom((await nostrLogin(adminSk)).res.headers)
    const out = await api(t.base, '/api/admin/auth/logout', { cookie: l2, body: {} })
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await api(t.base, '/api/admin/me', { cookie: l2 })).status).toBe(401)
  })

  test('reset TOTP and remove admin (but never the last one)', async () => {
    const reset = await api(t.base, `/api/admin/admins/${adminId}/reset-totp`, { cookie, body: {} })
    expect(reset.body.totp.secret).not.toBe(secret)
    expect(
      (await api(t.base, `/api/admin/admins/${adminId}`, { method: 'DELETE', cookie })).status,
    ).toBe(200)
    const me = await api(t.base, '/api/admin/me', { cookie })
    expect(
      (await api(t.base, `/api/admin/admins/${me.body.admin.id}`, { method: 'DELETE', cookie }))
        .status,
    ).toBe(409)
  })
})

describe('apps', () => {
  let apiKey = ''
  let firstSecret = ''
  test('create, list, get, patch', async () => {
    const c = await api(t.base, '/api/admin/apps', {
      cookie,
      body: { name: 'My Game!', blossomQuotaBytes: 1000, policy: { kinds: { deny: [4] } } },
    })
    expect(c.status).toBe(201)
    expect(c.body.id).toBe('my-game')
    expect(c.body.turnSecret).toHaveLength(64)
    expect(c.body.blossomQuotaBytes).toBe(1000)
    expect(c.body.apiKey).toMatch(/^bhk_[0-9a-f]{48}$/)
    expect(c.body.policy).toEqual({ kinds: { deny: [4] } })
    apiKey = c.body.apiKey
    firstSecret = c.body.turnSecret
    expect(
      (await api(t.base, '/api/admin/apps', { cookie, body: { name: 'dup', id: 'my-game' } }))
        .status,
    ).toBe(409)
    expect(
      (await api(t.base, '/api/admin/apps', { cookie, body: { name: 'bad', id: 'Bad Id' } }))
        .status,
    ).toBe(400)
    const list = await api(t.base, '/api/admin/apps', { cookie })
    expect(list.body.apps.map((a: { id: string }) => a.id)).toContain('my-game')
    expect(list.body.apps[0].turnSecret).toBeUndefined()
    const p = await api(t.base, '/api/admin/apps/my-game', {
      method: 'PATCH',
      cookie,
      body: { plan: 'pro', turnMonthlyBytes: 5e9, bogus: 1 },
    })
    expect(p.body).toMatchObject({ plan: 'pro', turnMonthlyBytes: 5e9 })
    expect(
      (
        await api(t.base, '/api/admin/apps/my-game', {
          method: 'PATCH',
          cookie,
          body: { turnMaxBps: -1 },
        })
      ).status,
    ).toBe(400)
    expect((await api(t.base, '/api/admin/apps/nope', { cookie })).status).toBe(404)
  })

  test('rotate TURN secret and API key', async () => {
    const before = (await api(t.base, '/api/admin/apps/my-game', { cookie })).body
    expect(before.turnSecret).toBeUndefined()
    expect(before.turnSecretHint).toBe(`…${firstSecret.slice(-4)}`)
    const r1 = await api(t.base, '/api/admin/apps/my-game/rotate-turn-secret', { cookie, body: {} })
    expect(r1.body.turnSecret).not.toBe(firstSecret)
    const r2 = await api(t.base, '/api/admin/apps/my-game/rotate-api-key', { cookie, body: {} })
    expect(r2.body.apiKey).not.toBe(apiKey)
    const creds = (key: string) =>
      fetch(`${t.base}/a/my-game/turn-credentials`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      })
    expect((await creds(apiKey)).status).toBe(401)
    expect((await creds(r2.body.apiKey)).status).toBe(200)
  })

  test('usage endpoint', async () => {
    const u = await api(t.base, '/api/admin/apps/my-game/usage', { cookie })
    expect(u.body.app).toBe('my-game')
    expect(u.body.month.turnQuota).toBe(5e9)
    expect(
      u.body.days.find((d: { metric: string }) => d.metric === 'turn_credentials')?.value,
    ).toBe(1)
  })

  test('policies per realm and global', async () => {
    const g = await api(t.base, '/api/admin/policies/_global', {
      method: 'PUT',
      cookie,
      body: { policy: { minPow: 8, pubkeys: { deny: ['A'.repeat(64)] } } },
    })
    expect(g.body).toEqual({ minPow: 8, pubkeys: { deny: ['a'.repeat(64)] } })
    expect(t.nostr().opts.policy?.get(null).minPow).toBe(8)
    expect(
      (
        await api(t.base, '/api/admin/policies/_global', {
          method: 'PUT',
          cookie,
          body: { minPow: 'x' },
        })
      ).status,
    ).toBe(400)
    expect((await api(t.base, '/api/admin/policies/nope', { cookie })).status).toBe(404)
    expect((await api(t.base, '/api/admin/policies/my-game', { cookie })).body).toEqual({
      kinds: { deny: [4] },
    })
  })

  test('delete', async () => {
    expect(
      (await api(t.base, '/api/admin/apps/my-game', { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect((await api(t.base, '/api/admin/apps/my-game', { cookie })).status).toBe(404)
  })
})

describe('nostr, turn, bans, nip11, settings, backups', () => {
  test('event explorer and deletion through NIP-86 fallback', async () => {
    const sk = randomHex(32)
    const e1 = signEvent(sk, { kind: 1, content: 'find me', tags: [['t', 'beamhop']] })
    const e2 = signEvent(sk, { kind: 7, content: '+', tags: [] })
    await t.nostr().publish(e1, null)
    await t.nostr().publish(e2, null)
    const byKind = await api(t.base, '/api/admin/nostr/events?kind=1', { cookie })
    expect(byKind.body.events.map((e: { id: string }) => e.id)).toEqual([e1.id])
    const byTag = await api(t.base, '/api/admin/nostr/events?tag=t:beamhop', { cookie })
    expect(byTag.body.events).toHaveLength(1)
    const bySearch = await api(t.base, `/api/admin/nostr/events?search=find&author=${e1.pubkey}`, {
      cookie,
    })
    expect(bySearch.body.events).toHaveLength(1)
    expect(
      (await api(t.base, `/api/admin/nostr/events/${e1.id}`, { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect(t.nostr().query([{ ids: [e1.id] }])).toEqual([])
    expect(
      (await api(t.base, `/api/admin/nostr/events/${e1.id}`, { method: 'DELETE', cookie })).status,
    ).toBe(404)
    const subs = await api(t.base, '/api/admin/nostr/subscriptions', { cookie })
    expect(subs.body.stats).toHaveProperty('subscriptions')
  })

  test('TURN allocations list and kill', async () => {
    t.turn().allocs.push({ id: 'al1', username: '1:chat:x', transport: 'udp' })
    const l = await api(t.base, '/api/admin/turn/allocations', { cookie })
    expect(l.body.allocations).toHaveLength(1)
    expect(
      (await api(t.base, '/api/admin/turn/allocations/al1', { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect(
      (await api(t.base, '/api/admin/turn/allocations/al1', { method: 'DELETE', cookie })).status,
    ).toBe(404)
  })

  test('bans: pubkey bans feed the policy deny list; IP bans block HTTP', async () => {
    const pk = getPublicKey(randomHex(32))
    const b = await api(t.base, '/api/admin/bans', {
      cookie,
      body: { type: 'pubkey', value: pk, reason: 'spam' },
    })
    expect(b.status).toBe(201)
    expect(t.nostr().opts.policy?.get(null).pubkeys?.deny).toContain(pk)
    expect(t.nostr().opts.policy?.get(null).writeAllowed?.(pk)).toBe(false)
    expect((await api(t.base, '/api/admin/bans', { cookie })).body.bans).toHaveLength(1)
    expect(
      (await api(t.base, `/api/admin/bans/${b.body.ban.id}`, { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect(t.nostr().opts.policy?.get(null).pubkeys?.deny).not.toContain(pk)
    expect(
      (await api(t.base, '/api/admin/bans', { cookie, body: { type: 'mac', value: 'x' } })).status,
    ).toBe(400)

    const ipBan = await api(t.base, '/api/admin/bans', {
      cookie,
      body: { type: 'ip', value: '127.0.0.1' },
    })
    expect((await fetch(`${t.base}/healthz`)).status).toBe(403)
    // Lift the ban directly (we are locked out of HTTP now).
    t.relay.ctx.bans.remove(ipBan.body.ban.id)
    expect((await fetch(`${t.base}/healthz`)).status).toBe(200)
  })

  test('NIP-11 editor updates the shared info document', async () => {
    const r = await api(t.base, '/api/admin/nip11', {
      method: 'PUT',
      cookie,
      body: { info: { name: 'Renamed', description: 'd', evil: 1 } },
    })
    expect(r.body.name).toBe('Renamed')
    expect(r.body.evil).toBeUndefined()
    expect(t.nostr().info.name).toBe('Renamed')
  })

  test('settings: edit, validation, restart flags, secrets redacted', async () => {
    const g = await api(t.base, '/api/admin/settings', { cookie })
    expect(g.body.config.http.port).toBe(0)
    const p = await api(t.base, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: { blossom: { maxUploadBytes: 1234 }, http: { port: 8443 } },
    })
    expect(p.status).toBe(200)
    expect(p.body.restartRequired).toEqual(['http.port'])
    expect(t.relay.ctx.blossom.opts.maxUploadBytes).toBe(1234)
    expect(
      (
        await api(t.base, '/api/admin/settings', {
          method: 'PUT',
          cookie,
          body: { blossom: { maxUploadBytes: 'big' } },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await api(t.base, '/api/admin/settings', {
          method: 'PUT',
          cookie,
          body: { payments: { nwcUrl: 'x' } },
        })
      ).status,
    ).toBe(400)
    await api(t.base, '/api/admin/settings', {
      method: 'PUT',
      cookie,
      body: { blossom: { maxUploadBytes: 100 * 1024 * 1024 } },
    })
  })

  test('backups', async () => {
    const r = await api(t.base, '/api/admin/backups', { cookie, body: {} })
    expect(r.status).toBe(201)
    expect(r.body.backups[0].name).toMatch(/^admin-\d{8}T\d{6}Z\.db$/)
    expect(existsSync(join(t.dataDir, 'backups', r.body.backups[0].name))).toBe(true)
    expect(
      (await api(t.base, '/api/admin/backups', { cookie })).body.backups.length,
    ).toBeGreaterThan(0)
  })

  test('overview and alerts', async () => {
    const o = await api(t.base, '/api/admin/overview', { cookie })
    expect(o.body.counters).toHaveProperty('apps')
    expect(o.body.engines).toMatchObject({ nostr: true, turn: true })
    expect(Array.isArray(o.body.alerts)).toBe(true)
  })

  test('every write is audited with the acting admin', async () => {
    const log = await api(t.base, '/api/admin/audit?limit=500', { cookie })
    const actions = log.body.entries.map((e: { action: string }) => e.action)
    for (const a of [
      'admin.create',
      'auth.login',
      'auth.failed',
      'auth.logout',
      'app.create',
      'app.update',
      'app.rotate-turn-secret',
      'app.rotate-api-key',
      'app.delete',
      'policy.update',
      'nostr.event.delete',
      'turn.allocation.kill',
      'ban.create',
      'ban.delete',
      'nip11.update',
      'settings.update',
      'backup.create',
      'session.revoke',
      'admin.reset-totp',
      'admin.delete',
    ]) {
      expect(actions).toContain(a)
    }
    const create = log.body.entries.find(
      (e: { action: string; target: string }) =>
        e.action === 'app.create' && e.target === 'app:my-game',
    )
    expect(create.actor).toBe(`pubkey:${adminPk}`)
    expect(create.ip).toBe('127.0.0.1')
    const filtered = await api(t.base, '/api/admin/audit?action=app.', { cookie })
    expect(
      filtered.body.entries.every((e: { action: string }) => e.action.startsWith('app.')),
    ).toBe(true)
  })

  test('unknown admin route and wrong method', async () => {
    expect((await api(t.base, '/api/admin/nope', { cookie })).status).toBe(404)
    expect((await api(t.base, '/api/admin/overview', { method: 'DELETE', cookie })).status).toBe(
      405,
    )
  })
})
