import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay, WsClient } from './testing'
import { getPublicKey, randomHex, signEvent } from './util/crypto'

let t: TestRelay
let cookie: string
let appId: string

beforeAll(async () => {
  t = await startTestRelay({ nostr: { name: 'Test relay' } })
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
  const r = await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Chat App', id: 'chat' } })
  appId = r.body.app.id
})
afterAll(() => t.close())

describe('routing', () => {
  test('healthz', async () => {
    const r = await api(t.base, '/healthz')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ok', nostr: true, turn: true })
  })

  test('NIP-11 at / and per realm via the engine', async () => {
    const pub = await fetch(`${t.base}/`, { headers: { accept: 'application/nostr+json' } }).then(
      (r) => r.json(),
    )
    expect(pub).toMatchObject({
      name: 'Test relay',
      realm: null,
      software: 'https://github.com/beamhop/lightspeed',
    })
    expect(pub.self).toHaveLength(64)
    const realm = await fetch(`${t.base}/a/${appId}`, {
      headers: { accept: 'application/nostr+json' },
    }).then((r) => r.json())
    expect(realm.realm).toBe(appId)
  })

  test('landing page, unknown app, unknown path', async () => {
    const land = await fetch(`${t.base}/`)
    expect(land.headers.get('content-type')).toContain('text/html')
    expect(await land.text()).toContain('Test relay')
    expect((await api(t.base, '/a/nope')).status).toBe(404)
    expect((await api(t.base, '/a/nope/turn-credentials', { method: 'POST' })).status).toBe(404)
    const nf = await api(t.base, '/does/not/exist')
    expect(nf.status).toBe(404)
    expect(nf.body.error.code).toBe('not-found')
  })

  test('admin SPA placeholder when no build is present', async () => {
    const r = await fetch(`${t.base}/admin/apps/chat`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('Beamhop relay admin')
  })

  test('public relay and realm relay are separate Nostr namespaces', async () => {
    const sk = randomHex(32)
    const pub = await WsClient.open(`${t.wsBase}/`)
    const realm = await WsClient.open(`${t.wsBase}/a/${appId}`)
    realm.send(JSON.stringify(['REQ', 's1', { kinds: [1] }]))
    await realm.next((m) => m[0] === 'EOSE')
    const e = signEvent(sk, { kind: 1, content: 'hello public', tags: [] })
    pub.send(JSON.stringify(['EVENT', e]))
    expect(await pub.next((m) => m[0] === 'OK')).toEqual(['OK', e.id, true, ''])
    const e2 = signEvent(sk, { kind: 1, content: 'hello realm', tags: [] })
    realm.send(JSON.stringify(['EVENT', e2]))
    const got = await realm.next((m) => m[0] === 'EVENT')
    expect(got[2].id).toBe(e2.id)
    expect(
      t
        .nostr()
        .query([{ kinds: [1] }], null)
        .map((x) => x.id),
    ).toEqual([e.id])
    expect(
      t
        .nostr()
        .query([{ kinds: [1] }], appId)
        .map((x) => x.id),
    ).toEqual([e2.id])
    pub.close()
    realm.close()
  })

  test('nostr websocket on unknown realm is refused', async () => {
    await expect(WsClient.open(`${t.wsBase}/a/unknown`)).rejects.toThrow()
  })

  test('engines receive the contract options', () => {
    const n = t.nostr().opts
    expect(n.dbPath.endsWith('nostr.db')).toBe(true)
    expect(n.policy?.get(null).writeAllowed?.('a'.repeat(64))).toBe(true)
    const turn = t.turn().opts
    expect(turn.relayPorts).toEqual([50000, 50100])
    expect(typeof turn.credentials).toBe('function')
  })

  test('metrics in Prometheus text format', async () => {
    const r = await fetch(`${t.base}/metrics`)
    expect(r.headers.get('content-type')).toContain('text/plain')
    const text = await r.text()
    expect(text).toContain('# TYPE beamhop_up gauge')
    expect(text).toMatch(/beamhop_http_requests_total\{class="2xx"\} \d+/)
    expect(text).toContain('beamhop_apps 1')
    expect(text).toContain('beamhop_turn_allocations 0')
    expect(text).toContain('beamhop_engine_up{engine="nostr"} 1')
    expect(text).toMatch(/beamhop_nostr_events \d+/)
  })

  test('admin stats WebSocket requires a session and pushes stats', async () => {
    await expect(WsClient.open(`${t.wsBase}/api/admin/stats`)).rejects.toThrow()
    const ws = await WsClient.open(`${t.wsBase}/api/admin/stats`, { cookie, origin: t.base })
    const first = await ws.next((m) => m.type === 'stats')
    expect(first).toMatchObject({ type: 'stats', data: { connections: expect.any(Number) } })
    expect(first.nostr).toHaveProperty('events')
    const second = await ws.next((m) => m.type === 'stats', 2500)
    expect(second.at).toBeGreaterThanOrEqual(first.at)
    ws.close()
  })
})

describe('degraded engines', () => {
  test('runs without Nostr/TURN engines and reports it', async () => {
    const d = await startTestRelay({}, { nostrFactory: null, turnFactory: null })
    try {
      const h = await api(d.base, '/healthz')
      expect(h.body).toMatchObject({ status: 'degraded', nostr: false, turn: false })
      const info = await fetch(`${d.base}/`, { headers: { accept: 'application/nostr+json' } })
      expect(info.headers.get('content-type')).toContain('application/nostr+json')
      expect((await fetch(`${d.base}/`, { headers: { upgrade: 'websocket' } })).status).toBe(503)
    } finally {
      await d.close()
    }
  })
})

describe('rate limiting and bans', () => {
  test('per-IP HTTP rate limit', async () => {
    const r = await startTestRelay({ http: { rateLimitPerMinute: 3 } })
    try {
      const codes = []
      for (let i = 0; i < 5; i++) codes.push((await fetch(`${r.base}/pay/plans`)).status)
      expect(codes).toEqual([200, 200, 200, 429, 429])
      expect((await fetch(`${r.base}/healthz`)).status).toBe(200)
    } finally {
      await r.close()
    }
  })
})
