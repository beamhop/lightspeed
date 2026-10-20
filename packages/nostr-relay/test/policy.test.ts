import { afterEach, describe, expect, test } from 'bun:test'
import { createPolicyStore, RateLimiter, staticPolicy } from '../src/index'
import { Client, genKeys, mine, now, sign, sleep, startRelay, type TestRelay } from './helpers'

let t: TestRelay
const clients: Client[] = []
const connect = async (path = '', headers?: Record<string, string>) => {
  const c = await Client.connect(`${t.url}${path}`, headers)
  clients.push(c)
  return c
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  t.close()
})

describe('policy engine rejections', () => {
  test('kind allow/deny', async () => {
    t = startRelay({
      policy: staticPolicy({
        global: { kinds: { deny: [7] } },
        realms: { strict: { kinds: { allow: [1, 5] } } },
      }),
    })
    const c = await connect()
    const k = genKeys()
    expect(await c.publish(sign(k, { kind: 7 }))).toEqual({
      ok: false,
      message: 'blocked: kind 7 is not allowed',
    })
    expect((await c.publish(sign(k, { kind: 1 }))).ok).toBe(true)
    const s = await connect('/a/strict')
    expect((await s.publish(sign(k, { kind: 1 }))).ok).toBe(true)
    expect((await s.publish(sign(k, { kind: 30023 }))).message).toBe(
      'blocked: kind 30023 is not allowed',
    )
  })

  test('pubkey allow/deny', async () => {
    const good = genKeys()
    const bad = genKeys()
    const stranger = genKeys()
    t = startRelay({
      policy: staticPolicy({
        global: { pubkeys: { deny: [bad.pk] } },
        realms: { private: { pubkeys: { allow: [good.pk] } } },
      }),
    })
    const c = await connect()
    expect(await c.publish(sign(bad))).toEqual({ ok: false, message: 'blocked: pubkey is banned' })
    expect((await c.publish(sign(stranger))).ok).toBe(true)
    const p = await connect('/a/private')
    expect((await p.publish(sign(good))).ok).toBe(true)
    expect(await p.publish(sign(stranger))).toEqual({
      ok: false,
      message: 'restricted: this pubkey is not allowed to write here',
    })
  })

  test('writeAllowed hook (payments) and payment-required message', async () => {
    const paid = genKeys()
    t = startRelay({
      info: { name: 'paid', payments_url: 'https://relay.example.com/pay' },
      policy: staticPolicy({
        global: { writeAllowed: async (pk) => pk === paid.pk },
      }),
    })
    const c = await connect()
    expect((await c.publish(sign(paid))).ok).toBe(true)
    expect(await c.publish(sign(genKeys()))).toEqual({
      ok: false,
      message: 'restricted: payment required to write, see https://relay.example.com/pay',
    })
  })

  test('max event size', async () => {
    t = startRelay({ policy: staticPolicy({ global: { maxEventBytes: 600 } }) })
    const c = await connect()
    const k = genKeys()
    expect((await c.publish(sign(k, { content: 'small' }))).ok).toBe(true)
    const r = await c.publish(sign(k, { content: 'x'.repeat(1000) }))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/^invalid: event is \d+ bytes, maximum is 600$/)
  })

  test('NIP-13 minimum proof of work', async () => {
    t = startRelay({ policy: staticPolicy({ global: { minPow: 8 } }) })
    const c = await connect()
    const k = genKeys()
    // find an event that has < 8 bits without mining
    let weak = sign(k, { content: 'weak' })
    while (weak.id.startsWith('00')) weak = sign(k, { content: `weak${Math.random()}` })
    const r = await c.publish(weak)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/^pow: difficulty \d is less than 8$/)
    expect((await c.publish(mine(k, { content: 'strong' }, 8))).ok).toBe(true)
    // a committed target below the minimum is refused even if the id happens to be strong
    const lowTarget = mine(k, { content: 'cheat' }, 4)
    const msg = (await c.publish(lowTarget)).message
    expect(msg).toBe('pow: committed target 4 is less than 8')
  })

  test('rate limits per IP and per pubkey (token bucket)', async () => {
    t = startRelay({
      policy: staticPolicy({
        global: { rateLimits: { ip: { rate: 1, burst: 3 } } },
        realms: { pk: { rateLimits: { pubkey: { rate: 1, burst: 2 } } } },
      }),
    })
    const c = await connect('', { 'x-test-ip': '10.0.0.1' })
    const k = genKeys()
    const results = []
    for (let i = 0; i < 5; i++) results.push(await c.publish(sign(k, { content: `${i}` })))
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false])
    expect(results[3]?.message).toBe('rate-limited: slow down, too many events from your IP')
    // a different IP has its own bucket
    const c2 = await connect('', { 'x-test-ip': '10.0.0.2' })
    expect((await c2.publish(sign(k, { content: 'other ip' }))).ok).toBe(true)

    const p = await connect('/a/pk')
    const a = genKeys()
    const b = genKeys()
    const ra = []
    for (let i = 0; i < 3; i++) ra.push(await p.publish(sign(a, { content: `${i}` })))
    expect(ra.map((r) => r.ok)).toEqual([true, true, false])
    expect(ra[2]?.message).toBe('rate-limited: slow down, too many events from this pubkey')
    expect((await p.publish(sign(b))).ok).toBe(true)
  })

  test('REQ rate limit, max subscriptions and max filters', async () => {
    t = startRelay({
      policy: staticPolicy({
        global: {
          maxSubscriptions: 2,
          maxFilters: 2,
          rateLimits: { reqIp: { rate: 0.001, burst: 4 } },
        },
      }),
    })
    const c = await connect()
    expect((await c.req('a', {})).closed).toBeUndefined()
    expect((await c.req('b', {})).closed).toBeUndefined()
    expect((await c.req('c', {})).closed).toBe('error: too many subscriptions (max 2)')
    expect((await c.req('d', {}, {}, {})).closed).toBe('invalid: too many filters (max 2)')
    expect((await c.req('a', {})).closed).toBeUndefined()
    expect((await c.req('a', {})).closed).toBe('rate-limited: slow down, too many requests')
  })

  test('policies hot-swap through a PolicyProvider', async () => {
    const store = createPolicyStore()
    t = startRelay({ policy: store })
    const c = await connect()
    const k = genKeys()
    expect((await c.publish(sign(k, { kind: 1 }))).ok).toBe(true)
    store.set(null, { kinds: { deny: [1] } })
    expect((await c.publish(sign(k, { kind: 1 }))).message).toBe('blocked: kind 1 is not allowed')
    store.set(null, {})
    expect((await c.publish(sign(k, { kind: 1 }))).ok).toBe(true)
    store.setRealmDefault({ kinds: { allow: [9] } })
    const r = await connect('/a/any')
    expect((await r.publish(sign(k, { kind: 1 }))).ok).toBe(false)
  })

  test('created_at past limit and tag/content limits', async () => {
    t = startRelay({
      policy: staticPolicy({
        global: { maxPastSeconds: 60, maxEventTags: 1, maxContentLength: 5 },
      }),
    })
    const c = await connect()
    const k = genKeys()
    expect((await c.publish(sign(k, { created_at: now() - 120 }))).message).toBe(
      'invalid: created_at is too far in the past',
    )
    expect(
      (
        await c.publish(
          sign(k, {
            tags: [
              ['t', 'a'],
              ['t', 'b'],
            ],
          }),
        )
      ).message,
    ).toBe('invalid: too many tags (max 1)')
    expect((await c.publish(sign(k, { content: '123456' }))).message).toBe(
      'invalid: content too long (max 5)',
    )
  })

  test('retention per kind is enforced by the sweeper', async () => {
    t = startRelay({
      policy: staticPolicy({
        global: {
          retention: [
            { kinds: [1], maxAgeSeconds: 3600 },
            { kinds: [7], maxCount: 2 },
          ],
        },
      }),
    })
    const k = genKeys()
    const old = sign(k, { kind: 1, created_at: now() - 7200 })
    const fresh = sign(k, { kind: 1 })
    await t.relay.publish(old)
    await t.relay.publish(fresh)
    const reactions = [0, 1, 2, 3].map((i) => sign(k, { kind: 7, created_at: now() - 10 + i }))
    for (const r of reactions) await t.relay.publish(r)
    expect(t.relay.sweep()).toBe(3)
    expect(t.relay.query([{ kinds: [1] }]).map((e) => e.id)).toEqual([fresh.id])
    expect(t.relay.query([{ kinds: [7] }]).map((e) => e.id)).toEqual([
      reactions[3]?.id as string,
      reactions[2]?.id as string,
    ])
  })
})

describe('RateLimiter', () => {
  test('refills at the configured rate', () => {
    const rl = new RateLimiter()
    const lim = { rate: 10, burst: 2 }
    expect(rl.take('k', lim, 0)).toBe(true)
    expect(rl.take('k', lim, 0)).toBe(true)
    expect(rl.take('k', lim, 0)).toBe(false)
    expect(rl.take('k', lim, 100)).toBe(true)
    expect(rl.take('k', lim, 100)).toBe(false)
    rl.prune(100_000, 1000)
    expect(rl.size).toBe(0)
  })
})

describe('worker-pool verification', () => {
  test('verifyWorkers verifies signatures off the main thread', async () => {
    t = startRelay({ verifyWorkers: 2 })
    const c = await connect()
    const k = genKeys()
    const evs = Array.from({ length: 20 }, (_, i) => sign(k, { content: `w${i}` }))
    const res = await Promise.all(evs.map((e) => c.publish(e)))
    expect(res.every((r) => r.ok)).toBe(true)
    const good = sign(k, { content: 'x' })
    const forged = { ...good, sig: sign(k, { content: 'y' }).sig }
    expect((await c.publish(forged)).message).toBe('invalid: bad signature')
    await sleep(10)
  })
})
