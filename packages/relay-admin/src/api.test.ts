import { describe, expect, test } from 'bun:test'
import { ApiError, asList, buildQuery, createApi, normalizePolicy } from './api'
import { createMockApi } from './mock/server'
import { GLOBAL_REALM } from './types'

function recorder(
  respond: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 200 }),
) {
  const calls: { url: string; method: string; body: unknown; credentials?: RequestCredentials }[] =
    []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init.credentials,
    })
    return respond(url, init)
  }) as typeof fetch
  return { calls, f }
}

describe('buildQuery / asList', () => {
  test('skips empty values and joins arrays', () => {
    expect(buildQuery({ kind: [1, 7], author: undefined, search: '', limit: 50 })).toBe(
      '?kind=1%2C7&limit=50',
    )
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ kind: [] })).toBe('')
  })
  test('accepts arrays, {items} and keyed objects', () => {
    expect(asList([1, 2])).toEqual([1, 2])
    expect(asList({ items: [3] })).toEqual([3])
    expect(asList({ apps: [4] }, 'apps')).toEqual([4])
    expect(asList({ total: 1, rows: [5] })).toEqual([5])
    expect(asList(null)).toEqual([])
  })
})

describe('createApi', () => {
  test('maps endpoints to the contract paths and methods', async () => {
    const { calls, f } = recorder(
      (url) => new Response(url.includes('/apps') && !url.includes('rotate') ? '[]' : '{}'),
    )
    const api = createApi({ fetch: f })
    await api.auth.challenge()
    await api.auth.password('ops', 'pw', '123456')
    await api.apps.list()
    await api.apps.update('a b', { enabled: false })
    await api.apps.rotateTurnSecret('x')
    await api.apps.rotateApiKey('x')
    await api.nostr.events({
      kind: [1, 7],
      author: 'ab',
      tag: 't:nostr',
      search: 'hi',
      limit: 20,
      until: 99,
    })
    await api.nostr.deleteEvent('e1')
    await api.policies.put(GLOBAL_REALM, normalizePolicy({}))
    await api.turn.kill('al1')
    await api.bans.add({ ip: '1.2.3.4', durationSec: 60 })
    await api.media.blobs({ app: 'x' })
    await api.payments.setNwc({ uri: null })
    await api.admins.revokeSession('s1')
    await api.backups.run()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/admin/auth/challenge',
      'POST /api/admin/auth/password',
      'GET /api/admin/apps',
      'PATCH /api/admin/apps/a%20b',
      'POST /api/admin/apps/x/rotate-turn-secret',
      'POST /api/admin/apps/x/rotate-api-key',
      'GET /api/admin/nostr/events?kind=1%2C7&author=ab&tag=t%3Anostr&search=hi&limit=20&until=99',
      'DELETE /api/admin/nostr/events/e1',
      'PUT /api/admin/policies/_global',
      'DELETE /api/admin/turn/allocations/al1',
      'POST /api/admin/bans',
      'GET /api/admin/media/blobs?app=x',
      'PUT /api/admin/payments/nwc',
      'DELETE /api/admin/sessions/s1',
      'POST /api/admin/backups',
    ])
    expect(calls[1]?.body).toEqual({ username: 'ops', password: 'pw', totp: '123456' })
    expect(calls.every((c) => c.credentials === 'include')).toBe(true)
  })

  test('parses error bodies into ApiError and reports 401', async () => {
    let unauthorized = 0
    const { f } = recorder((url) =>
      url.endsWith('/me')
        ? new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }), {
            status: 401,
          })
        : new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such app' } }), {
            status: 404,
          }),
    )
    const api = createApi({ fetch: f, onUnauthorized: () => unauthorized++ })
    const e1 = await api.auth.me().catch((e) => e)
    expect(e1).toBeInstanceOf(ApiError)
    expect(e1.status).toBe(401)
    expect(e1.unauthorized).toBe(true)
    expect(unauthorized).toBe(1)
    const e2 = await api.apps.get('nope').catch((e) => e)
    expect(e2.code).toBe('not_found')
    expect(e2.message).toBe('No such app')
    expect(unauthorized).toBe(1)
  })

  test('network failures become ApiError(0)', async () => {
    const api = createApi({
      fetch: (async () => {
        throw new TypeError('offline')
      }) as unknown as typeof fetch,
    })
    const e = await api.overview.get().catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.status).toBe(0)
    expect(e.code).toBe('network')
  })

  test('baseUrl override and empty 204 bodies', async () => {
    const { calls, f } = recorder(() => new Response(null, { status: 204 }))
    const api = createApi({ fetch: f, baseUrl: 'https://relay.example/api/admin/' })
    expect(await api.auth.logout()).toBeNull()
    expect(calls[0]?.url).toBe('https://relay.example/api/admin/auth/logout')
  })

  test('normalizePolicy fills defaults', () => {
    const p = normalizePolicy({ minPow: 8, kinds: { allow: [1], deny: [] } as never })
    expect(p.minPow).toBe(8)
    expect(p.kinds.allow).toEqual([1])
    expect(p.pubkeys).toEqual({ allow: [], deny: [] })
    expect(p.rateLimits.perIp.windowSec).toBe(60)
  })
})

describe('mock API end-to-end through the typed client', () => {
  test('auth gate, CRUD and audit trail', async () => {
    const mock = createMockApi()
    const api = createApi({ fetch: mock.fetch })
    await expect(api.apps.list()).rejects.toMatchObject({ status: 401 })
    await expect(api.auth.password('ops', 'pw', '12')).rejects.toMatchObject({
      code: 'totp_required',
    })
    const me = await api.auth.password('ops', 'pw', '123456')
    expect(me.username).toBe('ops')

    const created = await api.apps.create({ name: 'Test app' })
    expect(created.turnSecret).toHaveLength(40)
    expect(created.apiKey.startsWith('bh_')).toBe(true)
    const listed = await api.apps.list()
    expect(listed[0]?.id).toBe(created.id)
    expect((listed[0] as unknown as Record<string, unknown>).turnSecret).toBeUndefined()

    const { turnSecret } = await api.apps.rotateTurnSecret(created.id)
    expect(turnSecret).not.toBe(created.turnSecret)
    expect((await api.apps.get(created.id)).turnSecretHint).toBe(`…${turnSecret.slice(-4)}`)

    const before = (await api.turn.allocations()).length
    const first = (await api.turn.allocations())[0]
    await api.turn.kill(first?.id as string)
    expect((await api.turn.allocations()).length).toBe(before - 1)

    const events = await api.nostr.events({ kind: [1], limit: 5 })
    expect(events.length).toBeLessThanOrEqual(5)
    expect(events.every((e) => e.kind === 1)).toBe(true)

    const audit = await api.admins.audit({ limit: 3 })
    expect(audit.map((a) => a.action)).toEqual([
      'turn.kill',
      'apps.rotate-turn-secret',
      'apps.create',
    ])

    const policy = await api.policies.get(GLOBAL_REALM)
    await api.policies.put(GLOBAL_REALM, { ...policy, minPow: 12 })
    expect((await api.policies.get(GLOBAL_REALM)).minPow).toBe(12)
  })
})
