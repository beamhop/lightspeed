import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parseTurnUsername, type TurnCredentialsResponse, turnPassword } from '@beamhop/p2p/wire'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay } from './testing'
import { getPublicKey, randomHex, signEvent } from './util/crypto'

let t: TestRelay
let cookie: string
let apiKey: string
let secret: string

beforeAll(async () => {
  t = await startTestRelay({ turn: { publicHost: 'turn.example.org', credentialTtl: 600 } })
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
  const r = await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Game', id: 'game' } })
  apiKey = r.body.apiKey
  secret = r.body.app.turnSecret
})
afterAll(() => t.close())

const mint = (headers: Record<string, string>, body?: unknown) =>
  fetch(`${t.base}/a/game/turn-credentials`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('POST /a/<appId>/turn-credentials', () => {
  test('API key: credential verifies with turnPassword and the app secret', async () => {
    const pubkey = getPublicKey(randomHex(32))
    const res = await mint(
      { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      { pubkey },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as TurnCredentialsResponse
    expect(body.ttl).toBe(600)
    expect(body.iceServers[0]).toEqual({ urls: 'stun:turn.example.org:3478' })
    const turn = body.iceServers[1] as { urls: string[]; username: string; credential: string }
    expect(turn.urls).toEqual([
      'turn:turn.example.org:3478?transport=udp',
      'turn:turn.example.org:3478?transport=tcp',
    ])
    const u = parseTurnUsername(turn.username)
    expect(u?.appId).toBe('game')
    expect(u?.pubkey).toBe(pubkey)
    const now = Math.floor(Date.now() / 1000)
    expect(u?.expiry).toBeGreaterThanOrEqual(now + 599)
    expect(u?.expiry).toBeLessThanOrEqual(now + 601)
    expect(turn.credential).toBe(turnPassword(secret, turn.username))
    // The TURN engine's credential lookup returns the same password.
    expect(t.turn().opts.credentials(turn.username)).toEqual({ password: turn.credential })
  })

  test('NIP-98 auth binds the credential to the signer', async () => {
    const sk = randomHex(32)
    const ev = signEvent(sk, {
      kind: 27235,
      content: '',
      tags: [
        ['u', `${t.base}/a/game/turn-credentials`],
        ['method', 'POST'],
      ],
    })
    const res = await mint({ authorization: `Nostr ${btoa(JSON.stringify(ev))}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as TurnCredentialsResponse
    const turn = body.iceServers[1] as { username: string; credential: string }
    expect(parseTurnUsername(turn.username)?.pubkey).toBe(getPublicKey(sk))
    expect(turn.credential).toBe(turnPassword(secret, turn.username))

    const wrongUrl = signEvent(sk, {
      kind: 27235,
      content: '',
      tags: [
        ['u', `${t.base}/a/other/turn-credentials`],
        ['method', 'POST'],
      ],
    })
    expect((await mint({ authorization: `Nostr ${btoa(JSON.stringify(wrongUrl))}` })).status).toBe(
      401,
    )
    const wrongMethod = signEvent(sk, {
      kind: 27235,
      content: '',
      tags: [
        ['u', `${t.base}/a/game/turn-credentials`],
        ['method', 'GET'],
      ],
    })
    expect(
      (await mint({ authorization: `Nostr ${btoa(JSON.stringify(wrongMethod))}` })).status,
    ).toBe(401)
  })

  test('rejects missing/bad auth and bad pubkeys', async () => {
    expect((await mint({})).status).toBe(401)
    expect((await mint({ authorization: 'Bearer bhk_wrong' })).status).toBe(401)
    expect((await mint({ authorization: `Bearer ${apiKey}` }, { pubkey: 'xyz' })).status).toBe(400)
    const anon = await mint({ authorization: `Bearer ${apiKey}` })
    const turn = ((await anon.json()) as TurnCredentialsResponse).iceServers[1] as {
      username: string
    }
    expect(parseTurnUsername(turn.username)?.pubkey).toBe('anonymous')
  })

  test('engine hooks: expired, unknown app, rotated secret, quota, usage', async () => {
    const hooks = t.turn().opts
    const future = Math.floor(Date.now() / 1000) + 100
    const user = `${future}:game:${'a'.repeat(64)}`
    expect(hooks.credentials(user)?.password).toBe(turnPassword(secret, user))
    expect(hooks.credentials(`1:game:${'a'.repeat(64)}`)).toBeNull()
    expect(hooks.credentials(`${future}:nope:x`)).toBeNull()
    expect(hooks.credentials('garbage')).toBeNull()
    expect(hooks.quota?.(user)).toEqual({
      allowed: true,
      maxAllocations: undefined,
      maxBps: undefined,
    })

    await api(t.base, '/api/admin/apps/game', {
      method: 'PATCH',
      cookie,
      body: { turnMonthlyBytes: 1000, turnMaxAllocations: 5 },
    })
    hooks.onUsage?.({ username: user, allocationId: 'a1', bytesIn: 600, bytesOut: 500 })
    expect(hooks.quota?.(user)).toMatchObject({ allowed: false, maxAllocations: 5 })
    expect((await mint({ authorization: `Bearer ${apiKey}` })).status).toBe(429)
    const alerts = await api(t.base, '/api/admin/alerts', { cookie })
    expect(alerts.body.alerts.map((a: { id: string }) => a.id)).toContain('turn-quota:game')
    await api(t.base, '/api/admin/apps/game', {
      method: 'PATCH',
      cookie,
      body: { turnMonthlyBytes: 0 },
    })

    const rotated = await api(t.base, '/api/admin/apps/game/rotate-turn-secret', {
      cookie,
      body: {},
    })
    expect(hooks.credentials(user)?.password).toBe(turnPassword(rotated.body.app.turnSecret, user))
    expect(hooks.credentials(user)?.password).not.toBe(turnPassword(secret, user))
  })

  test('disabled apps cannot mint', async () => {
    await api(t.base, '/api/admin/apps/game', { method: 'PATCH', cookie, body: { disabled: true } })
    expect((await mint({ authorization: `Bearer ${apiKey}` })).status).toBe(404)
    await api(t.base, '/api/admin/apps/game', {
      method: 'PATCH',
      cookie,
      body: { disabled: false },
    })
  })
})
