import { afterEach, describe, expect, test } from 'bun:test'
import { staticPolicy } from '../src/index'
import { Client, genKeys, now, sign, sleep, startRelay, type TestRelay } from './helpers'

let t: TestRelay
const clients: Client[] = []
const connect = async (path = '') => {
  const c = await Client.connect(`${t.url}${path}`)
  clients.push(c)
  return c
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  t.close()
})

describe('realm isolation', () => {
  test('stored queries, live subscriptions and counts never cross realms', async () => {
    t = startRelay()
    const pub = await connect()
    const app1 = await connect('/a/app1')
    const app2 = await connect('/a/app2')
    const k = genKeys()
    await app2.req('live', { kinds: [1] })
    await pub.req('live', { kinds: [1] })
    const e = sign(k, { content: 'in app1' })
    expect((await app1.publish(e)).ok).toBe(true)
    // the same event can also be published into another realm independently
    expect((await app1.query({ ids: [e.id] })).length).toBe(1)
    expect(await app2.query({ ids: [e.id] })).toEqual([])
    expect(await pub.query({ ids: [e.id] })).toEqual([])
    expect(await app2.count({ kinds: [1] })).toBe(0)
    await sleep(50)
    expect(app2.pending('EVENT')).toEqual([])
    expect(pub.pending('EVENT')).toEqual([])
    expect(t.relay.query([{ ids: [e.id] }], 'app1').length).toBe(1)
    expect(t.relay.query([{ ids: [e.id] }], null).length).toBe(0)
    expect((await app2.publish(e)).message).toBe('')
    expect((await app2.query({ ids: [e.id] })).length).toBe(1)
  })

  test('replaceable and deletion semantics are per realm', async () => {
    t = startRelay()
    const a = await connect('/a/a')
    const b = await connect('/a/b')
    const k = genKeys()
    const p1 = sign(k, { kind: 0, created_at: now() - 10, content: 'old' })
    const p2 = sign(k, { kind: 0, created_at: now(), content: 'new' })
    await a.publish(p2)
    expect((await b.publish(p1)).ok).toBe(true)
    expect((await b.query({ kinds: [0] }))[0]?.content).toBe('old')
    await a.publish(sign(k, { kind: 5, tags: [['e', p2.id]] }))
    expect(await a.query({ kinds: [0] })).toEqual([])
    expect((await b.query({ kinds: [0] })).length).toBe(1)
  })
})

describe('NIP-09 deletion', () => {
  test('e-tag deletion by the author removes the event and blocks re-publish', async () => {
    t = startRelay()
    const c = await connect()
    const k = genKeys()
    const e = sign(k, { content: 'delete me' })
    await c.publish(e)
    const del = sign(k, { kind: 5, tags: [['e', e.id]], content: 'oops' })
    expect((await c.publish(del)).ok).toBe(true)
    expect(await c.query({ ids: [e.id] })).toEqual([])
    expect((await c.query({ kinds: [5] }))[0]?.id).toBe(del.id)
    expect(await c.publish(e)).toEqual({
      ok: false,
      message: 'blocked: this event was deleted by its author',
    })
  })

  test("deletion by someone else does not remove another author's event", async () => {
    t = startRelay()
    const c = await connect()
    const e = sign(genKeys(), { content: 'mine' })
    await c.publish(e)
    await c.publish(sign(genKeys(), { kind: 5, tags: [['e', e.id]] }))
    expect((await c.query({ ids: [e.id] })).length).toBe(1)
  })

  test('a-tag deletion removes addressable versions up to the deletion time', async () => {
    t = startRelay()
    const c = await connect()
    const k = genKeys()
    const t0 = now() - 100
    const art = sign(k, { kind: 30023, tags: [['d', 'post']], created_at: t0 })
    const keep = sign(k, { kind: 30023, tags: [['d', 'other']], created_at: t0 })
    await c.publish(art)
    await c.publish(keep)
    const del = sign(k, { kind: 5, tags: [['a', `30023:${k.pk}:post`]], created_at: t0 + 10 })
    await c.publish(del)
    expect((await c.query({ kinds: [30023] })).map((e) => e.id)).toEqual([keep.id])
    // older version re-published is blocked; newer version is accepted
    const older = sign(k, { kind: 30023, tags: [['d', 'post']], created_at: t0 + 5 })
    expect((await c.publish(older)).message).toBe('blocked: this event was deleted by its author')
    const newer = sign(k, { kind: 30023, tags: [['d', 'post']], created_at: t0 + 20 })
    expect((await c.publish(newer)).ok).toBe(true)
  })

  test('deleting a deletion has no effect', async () => {
    t = startRelay()
    const c = await connect()
    const k = genKeys()
    const e = sign(k)
    await c.publish(e)
    const del = sign(k, { kind: 5, tags: [['e', e.id]] })
    await c.publish(del)
    await c.publish(sign(k, { kind: 5, tags: [['e', del.id]] }))
    expect((await c.query({ ids: [del.id] })).length).toBe(1)
  })
})

describe('NIP-40 expiration', () => {
  test('rejects already-expired events', async () => {
    t = startRelay()
    const c = await connect()
    const e = sign(genKeys(), { tags: [['expiration', String(now() - 1)]] })
    expect(await c.publish(e)).toEqual({ ok: false, message: 'invalid: event has expired' })
  })

  test('expired events disappear from queries and the sweeper deletes them', async () => {
    t = startRelay()
    const c = await connect()
    const k = genKeys()
    const e = sign(k, { tags: [['expiration', String(now() + 1)]] })
    const keep = sign(k, { tags: [['expiration', String(now() + 3600)]] })
    await c.publish(e)
    await c.publish(keep)
    expect((await c.query({ authors: [k.pk] })).length).toBe(2)
    await sleep(2100)
    expect((await c.query({ authors: [k.pk] })).map((x) => x.id)).toEqual([keep.id])
    expect(t.relay.sweep()).toBe(1)
    expect(t.relay.stats().events).toBeGreaterThanOrEqual(1)
  })

  test('periodic sweeper runs on its own', async () => {
    t = startRelay({ sweepIntervalMs: 100 })
    const e = sign(genKeys(), { tags: [['expiration', String(now() + 1)]] })
    await t.relay.publish(e)
    // stats().events counts raw rows (expired-but-unswept rows included)
    expect(t.relay.stats().events).toBe(1)
    await sleep(2300)
    expect(t.relay.stats().events).toBe(0)
  })
})

describe('NIP-42 AUTH and NIP-70 protected events', () => {
  const relayUrl = 'wss://relay.example.com'

  test('valid AUTH is accepted; wrong challenge, relay or kind is rejected', async () => {
    t = startRelay({ auth: { relayUrl } })
    const c = await connect()
    const k = genKeys()
    expect((await c.auth(k, relayUrl, 'wrong')).message).toBe('invalid: challenge does not match')
    expect((await c.auth(k, 'wss://evil.example.com')).message).toBe(
      'invalid: relay tag does not match this relay',
    )
    expect(await c.auth(k, `${relayUrl}/a/x`)).toEqual({ ok: true, message: '' })
    expect(t.relay.subscriptions()).toEqual([])
  })

  test('authRequiredKinds gate publishing and reading with auth-required:', async () => {
    t = startRelay({
      auth: { relayUrl },
      policy: staticPolicy({ global: { authRequiredKinds: [4] } }),
    })
    const c = await connect()
    const k = genKeys()
    const dm = sign(k, { kind: 4, content: 'secret' })
    expect(await c.publish(dm)).toEqual({
      ok: false,
      message: 'auth-required: kind 4 requires authentication',
    })
    expect((await c.req('dms', { kinds: [4] })).closed).toBe(
      'auth-required: these kinds require authentication',
    )
    await t.relay.publish(dm)
    // unauthenticated broad queries do not leak the kind
    expect(await c.query({ authors: [k.pk] })).toEqual([])
    expect(await c.count({ authors: [k.pk] })).toBe(0)
    expect((await c.auth(k, relayUrl)).ok).toBe(true)
    expect((await c.req('dms2', { kinds: [4] })).events.map((e) => e.id)).toEqual([dm.id])
    expect((await c.publish(sign(k, { kind: 4, content: 'x' }))).ok).toBe(true)
  })

  test('authRequired gates everything', async () => {
    t = startRelay({ auth: { relayUrl }, policy: staticPolicy({ global: { authRequired: true } }) })
    const c = await connect()
    const k = genKeys()
    expect((await c.publish(sign(k))).message).toBe(
      'auth-required: this relay requires authentication',
    )
    expect((await c.req('s', {})).closed).toBe('auth-required: this relay requires authentication')
    expect(await c.count({})).toBe('auth-required: this relay requires authentication')
    await c.auth(k, relayUrl)
    expect((await c.publish(sign(k))).ok).toBe(true)
    expect((await c.req('s2', {})).closed).toBeUndefined()
  })

  test('protected events need AUTH as their author', async () => {
    t = startRelay({ auth: { relayUrl } })
    const c = await connect()
    const author = genKeys()
    const other = genKeys()
    const e = sign(author, { tags: [['-']], content: 'protected' })
    expect(await c.publish(e)).toEqual({
      ok: false,
      message: 'auth-required: this event may only be published by its author',
    })
    await c.auth(other, relayUrl)
    expect(await c.publish(e)).toEqual({
      ok: false,
      message: 'restricted: this event may only be published by its author',
    })
    await c.auth(author, relayUrl)
    expect(await c.publish(e)).toEqual({ ok: true, message: '' })
  })
})

describe('NIP-45 COUNT', () => {
  test('counts across filters without double counting', async () => {
    t = startRelay()
    const c = await connect()
    const a = genKeys()
    const b = genKeys()
    for (let i = 0; i < 3; i++) await c.publish(sign(a, { content: `a${i}`, tags: [['t', 'x']] }))
    for (let i = 0; i < 2; i++) await c.publish(sign(b, { kind: 7, content: `b${i}` }))
    expect(await c.count({ authors: [a.pk] })).toBe(3)
    expect(await c.count({ kinds: [7] })).toBe(2)
    expect(await c.count({ authors: [a.pk] }, { '#t': ['x'] })).toBe(3)
    expect(await c.count({ authors: [a.pk] }, { kinds: [7] })).toBe(5)
    expect(await c.count({ ids: [] })).toBe(0)
    expect(t.relay.count([{}])).toBe(5)
  })
})

describe('NIP-50 search', () => {
  test('full-text search on FTS5, combined with other filters', async () => {
    t = startRelay()
    const c = await connect()
    const a = genKeys()
    const e1 = sign(a, { content: 'Beamhop lightspeed relays nostr events' })
    const e2 = sign(a, {
      kind: 30023,
      tags: [['d', 'x']],
      content: 'peer to peer rooms over nostr',
    })
    const e3 = sign(genKeys(), { content: 'nothing to see here' })
    for (const e of [e1, e2, e3]) await c.publish(e)
    expect((await c.query({ search: 'lightspeed' })).map((e) => e.id)).toEqual([e1.id])
    expect((await c.query({ search: 'NOSTR' })).map((e) => e.id).sort()).toEqual(
      [e1.id, e2.id].sort(),
    )
    expect((await c.query({ search: 'nostr rooms' })).map((e) => e.id)).toEqual([e2.id])
    expect((await c.query({ search: 'nostr', kinds: [1] })).map((e) => e.id)).toEqual([e1.id])
    expect((await c.query({ search: 'nostr language:en' })).length).toBe(2)
    expect(await c.query({ search: 'absent' })).toEqual([])
    // quotes and FTS syntax are treated literally
    expect(await c.query({ search: '"AND OR * NEAR(' })).toEqual([])
    expect(await c.count({ search: 'nostr' })).toBe(2)
    // live subscriptions honour search
    await c.req('live', { search: 'hello' })
    const hit = sign(a, { content: 'well hello there' })
    await c.publish(sign(a, { content: 'goodbye' }))
    await c.publish(hit)
    const m = await c.next((x) => x[0] === 'EVENT' && x[1] === 'live')
    expect((m[2] as { id: string }).id).toBe(hit.id)
    // deleted events leave the index
    await c.publish(sign(a, { kind: 5, tags: [['e', e1.id]] }))
    expect(await c.query({ search: 'lightspeed' })).toEqual([])
  })
})
