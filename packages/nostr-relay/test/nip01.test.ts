import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client, genKeys, now, sign, sleep, startRelay, type TestRelay } from './helpers'

let t: TestRelay
let c: Client
beforeEach(async () => {
  t = startRelay()
  c = await Client.connect(t.url)
})
afterEach(() => {
  c.close()
  t.close()
})

describe('NIP-01 basics', () => {
  test('sends an AUTH challenge on connect', () => {
    expect(c.challenge).toMatch(/^[0-9a-f]{32}$/)
  })

  test('publish then query by id, author, kind, tag, since/until, limit', async () => {
    const a = genKeys()
    const b = genKeys()
    const base = now() - 100
    const e1 = sign(a, { content: 'one', created_at: base, tags: [['t', 'x']] })
    const e2 = sign(a, { content: 'two', created_at: base + 1, kind: 7, tags: [['p', b.pk]] })
    const e3 = sign(b, { content: 'three', created_at: base + 2, tags: [['t', 'y']] })
    for (const e of [e1, e2, e3]) expect(await c.publish(e)).toEqual({ ok: true, message: '' })

    expect((await c.query({ ids: [e2.id] })).map((e) => e.id)).toEqual([e2.id])
    expect((await c.query({ authors: [a.pk] })).map((e) => e.id)).toEqual([e2.id, e1.id])
    expect((await c.query({ kinds: [7] })).map((e) => e.id)).toEqual([e2.id])
    expect((await c.query({ '#t': ['x', 'y'] })).map((e) => e.id)).toEqual([e3.id, e1.id])
    expect((await c.query({ '#p': [b.pk] })).map((e) => e.id)).toEqual([e2.id])
    expect((await c.query({ since: base + 1, until: base + 1 })).map((e) => e.id)).toEqual([e2.id])
    expect((await c.query({ limit: 1 })).map((e) => e.id)).toEqual([e3.id])
    expect((await c.query({ authors: [a.pk], kinds: [1] })).map((e) => e.id)).toEqual([e1.id])
    // multiple filters are ORed
    const or = await c.query({ ids: [e1.id] }, { ids: [e3.id] })
    expect(or.map((e) => e.id).sort()).toEqual([e1.id, e3.id].sort())
    // events round-trip byte-exact
    expect((await c.query({ ids: [e1.id] }))[0]).toEqual(e1)
    // empty list matches nothing
    expect(await c.query({ ids: [] })).toEqual([])
    // programmatic query
    expect(t.relay.query([{ authors: [b.pk] }]).map((e) => e.id)).toEqual([e3.id])
  })

  test('duplicate events are acknowledged with duplicate:', async () => {
    const e = sign(genKeys())
    expect((await c.publish(e)).ok).toBe(true)
    expect(await c.publish(e)).toEqual({ ok: true, message: 'duplicate: already have this event' })
  })

  test('rejects bad id and bad signature with invalid:', async () => {
    const k = genKeys()
    const e = sign(k, { content: 'hi' })
    const badId = { ...e, content: 'tampered' }
    expect(await c.publish(badId)).toEqual({ ok: false, message: 'invalid: event id does not match' })
    const other = sign(k, { content: 'other' })
    const badSig = { ...e, sig: other.sig }
    expect(await c.publish(badSig)).toEqual({ ok: false, message: 'invalid: bad signature' })
    c.send(['EVENT', { ...e, kind: 'x' }])
    const m = await c.next((x) => x[0] === 'OK')
    expect(m[2]).toBe(false)
    expect(m[3]).toStartWith('invalid:')
  })

  test('rejects events too far in the future', async () => {
    const e = sign(genKeys(), { created_at: now() + 3600 })
    expect(await c.publish(e)).toEqual({
      ok: false,
      message: 'invalid: created_at is too far in the future',
    })
  })

  test('NOTICE on malformed messages, CLOSED on bad filters', async () => {
    c.ws.send('not json')
    expect((await c.next((m) => m[0] === 'NOTICE'))[1]).toStartWith('error:')
    c.send(['WAT'])
    expect((await c.next((m) => m[0] === 'NOTICE'))[1]).toStartWith('error: unknown message type')
    const r = await c.req('bad', { kinds: ['x'] })
    expect(r.closed).toStartWith('invalid:')
  })

  test('live subscription receives matching events after EOSE; CLOSE stops it', async () => {
    const k = genKeys()
    const r = await c.req('live', { kinds: [1], authors: [k.pk] })
    expect(r.events).toEqual([])
    const pub = await Client.connect(t.url)
    const match = sign(k, { content: 'match' })
    const nomatch = sign(k, { kind: 2, content: 'no' })
    await pub.publish(nomatch)
    await pub.publish(match)
    const m = await c.next((x) => x[0] === 'EVENT' && x[1] === 'live')
    expect((m[2] as { id: string }).id).toBe(match.id)
    c.send(['CLOSE', 'live'])
    await sleep(20)
    await pub.publish(sign(k, { content: 'after close' }))
    await sleep(50)
    expect(c.pending('EVENT')).toEqual([])
    expect(t.relay.stats().subscriptions).toBe(0)
    pub.close()
  })

  test('replaceable kinds keep only the newest per pubkey+kind', async () => {
    const k = genKeys()
    const t0 = now() - 50
    const old = sign(k, { kind: 0, content: '{"name":"old"}', created_at: t0 })
    const neu = sign(k, { kind: 0, content: '{"name":"new"}', created_at: t0 + 10 })
    expect((await c.publish(old)).ok).toBe(true)
    expect((await c.publish(neu)).ok).toBe(true)
    expect((await c.query({ kinds: [0], authors: [k.pk] })).map((e) => e.id)).toEqual([neu.id])
    // an older one arriving late is refused
    const older = sign(k, { kind: 0, content: 'older', created_at: t0 - 10 })
    expect(await c.publish(older)).toEqual({
      ok: false,
      message: 'duplicate: have a newer version of this event',
    })
    // kind 3 and 10000-19999 too
    const l1 = sign(k, { kind: 10002, created_at: t0 })
    const l2 = sign(k, { kind: 10002, created_at: t0 + 1 })
    await c.publish(l1)
    await c.publish(l2)
    expect((await c.query({ kinds: [10002] })).map((e) => e.id)).toEqual([l2.id])
    // same timestamp: lowest id wins
    const s1 = sign(k, { kind: 3, created_at: t0, content: 'a' })
    const s2 = sign(k, { kind: 3, created_at: t0, content: 'b' })
    const [lo, hi] = s1.id < s2.id ? [s1, s2] : [s2, s1]
    await c.publish(hi)
    await c.publish(lo)
    expect((await c.query({ kinds: [3] })).map((e) => e.id)).toEqual([lo.id])
    expect((await c.publish(hi)).ok).toBe(false)
  })

  test('addressable kinds are replaced per d tag', async () => {
    const k = genKeys()
    const t0 = now() - 50
    const a1 = sign(k, { kind: 30023, tags: [['d', 'a']], created_at: t0, content: 'a1' })
    const a2 = sign(k, { kind: 30023, tags: [['d', 'a']], created_at: t0 + 1, content: 'a2' })
    const b1 = sign(k, { kind: 30023, tags: [['d', 'b']], created_at: t0, content: 'b1' })
    const none = sign(k, { kind: 30023, created_at: t0, content: 'no d' })
    for (const e of [a1, a2, b1, none]) expect((await c.publish(e)).ok).toBe(true)
    const got = (await c.query({ kinds: [30023] })).map((e) => e.content).sort()
    expect(got).toEqual(['a2', 'b1', 'no d'])
    expect((await c.query({ kinds: [30023], '#d': ['a'] })).map((e) => e.id)).toEqual([a2.id])
    // another author's same d tag is independent
    const other = sign(genKeys(), { kind: 30023, tags: [['d', 'a']], created_at: t0 })
    await c.publish(other)
    expect((await c.query({ kinds: [30023], '#d': ['a'] })).length).toBe(2)
  })

  test('ephemeral events are delivered live but never stored', async () => {
    const k = genKeys()
    await c.req('eph', { kinds: [20001] })
    const pub = await Client.connect(t.url)
    const e = sign(k, { kind: 20001, content: 'blink' })
    expect(await pub.publish(e)).toEqual({ ok: true, message: '' })
    const m = await c.next((x) => x[0] === 'EVENT' && x[1] === 'eph')
    expect((m[2] as { id: string }).id).toBe(e.id)
    expect(await pub.query({ kinds: [20001] })).toEqual([])
    expect(t.relay.query([{ ids: [e.id] }])).toEqual([])
    pub.close()
  })

  test('REQ with the same id replaces the subscription', async () => {
    const k = genKeys()
    await c.req('s', { kinds: [1] })
    await c.req('s', { kinds: [2] })
    expect(t.relay.stats().subscriptions).toBe(1)
    await c.publish(sign(k, { kind: 1 }))
    const e2 = sign(k, { kind: 2 })
    await c.publish(e2)
    const m = await c.next((x) => x[0] === 'EVENT' && x[1] === 's')
    expect((m[2] as { id: string }).id).toBe(e2.id)
  })

  test('publish() API and onEvent()', async () => {
    const seen: string[] = []
    const off = t.relay.onEvent((e, realm) => seen.push(`${realm}:${e.id}`))
    const e = sign(genKeys())
    expect(await t.relay.publish(e)).toEqual({ ok: true, message: '' })
    const r = sign(genKeys())
    expect((await t.relay.publish(r, 'app1')).ok).toBe(true)
    off()
    await t.relay.publish(sign(genKeys()))
    expect(seen).toEqual([`null:${e.id}`, `app1:${r.id}`])
    const bad = { ...sign(genKeys()), sig: '0'.repeat(128) }
    expect((await t.relay.publish(bad)).message).toBe('invalid: bad signature')
  })

  test('stats() counts events, clients, subscriptions and rate', async () => {
    await c.req('s1', { kinds: [1] })
    await c.req('s2', { kinds: [1] })
    for (let i = 0; i < 5; i++) await c.publish(sign(genKeys(), { content: String(i) }))
    await sleep(1100)
    const s = t.relay.stats()
    expect(s.clients).toBe(1)
    expect(s.subscriptions).toBe(2)
    expect(s.events).toBe(5)
    expect(s.eventsPerSec).toBeGreaterThan(0)
    expect(t.relay.subscriptions().map((x) => x.subId).sort()).toEqual(['s1', 's2'])
  })
})
