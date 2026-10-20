import { afterEach, describe, expect, test } from 'bun:test'
import type { Signal, SignalingAdapter } from '@beamhop/p2p/types'
import { roomTopic } from '@beamhop/p2p/wire'
import { leadingZeroBits, signEvent, verifyEvent } from './event'
import { FakeRelay, testIdentity, waitFor } from './fake-relay.test-util'
import { type NostrSignalingAdapter, nostrSignaling } from './index'

const relays: FakeRelay[] = []
const adapters: SignalingAdapter[] = []
const topic = roomTopic('app', 'room')

function relay(opts?: ConstructorParameters<typeof FakeRelay>[0]): FakeRelay {
  const r = new FakeRelay(opts)
  relays.push(r)
  return r
}

function adapter(urls: string[], extra: Record<string, unknown> = {}) {
  const identity = testIdentity()
  const a = nostrSignaling({ relays: urls, minBackoffMs: 20, maxBackoffMs: 100, ...extra })({
    identity,
  }) as NostrSignalingAdapter
  adapters.push(a)
  return { a, identity }
}

const allOpen = (a: SignalingAdapter) => a.status?.().every((s) => s.state === 'open') ?? false

afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close()
  for (const r of relays.splice(0)) r.stop()
})

describe('event', () => {
  test('sign + verify, tamper detection, PoW', async () => {
    const id = testIdentity()
    const e = await signEvent({ kind: 1, tags: [], content: 'hi' }, id, 8)
    expect(verifyEvent(e)).toBe(true)
    expect(leadingZeroBits(e.id)).toBeGreaterThanOrEqual(8)
    expect(e.tags.find((t) => t[0] === 'nonce')?.[2]).toBe('8')
    expect(verifyEvent({ ...e, content: 'bye' })).toBe(false)
    expect(verifyEvent({ ...e, sig: '00'.repeat(64) })).toBe(false)
    expect(verifyEvent({ nope: true })).toBe(false)
    expect(leadingZeroBits('0f')).toBe(4)
    expect(leadingZeroBits('1f')).toBe(3)
  })
})

describe('nostrSignaling', () => {
  test('two adapters exchange announce + directed signals via 2 relays, deduped', async () => {
    const r1 = relay()
    const r2 = relay()
    const urls = [r1.url, r2.url]
    const { a: alice, identity: aliceId } = adapter(urls)
    const { a: bob, identity: bobId } = adapter(urls)
    await waitFor(() => allOpen(alice) && allOpen(bob), 3000, 'relays open')

    const got: Signal[] = []
    const bobGot: Signal[] = []
    alice.subscribe(topic, (s) => got.push(s))
    bob.subscribe(topic, (s) => bobGot.push(s))
    await new Promise((r) => setTimeout(r, 50))

    await bob.announce(topic, 'hello-room')
    await waitFor(() => got.length >= 1, 3000, 'announce')
    await alice.send(topic, bobId.pubkey, 'offer-sdp')
    await waitFor(() => bobGot.length >= 1, 3000, 'directed')
    // Let duplicates from the second relay arrive.
    await waitFor(() => r1.received.length === 2 && r2.received.length === 2, 3000, 'both relays')
    await new Promise((r) => setTimeout(r, 100))

    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: 'announce', from: bobId.pubkey, content: 'hello-room' })
    expect(bobGot).toHaveLength(1)
    expect(bobGot[0]).toMatchObject({ kind: 'direct', from: aliceId.pubkey, content: 'offer-sdp' })
    // own announce is not echoed back; directed signals to others are not delivered
    const { a: carol } = adapter(urls)
    const carolGot: Signal[] = []
    carol.subscribe(topic, (s) => carolGot.push(s))
    await waitFor(() => allOpen(carol), 3000, 'carol open')
    await new Promise((r) => setTimeout(r, 50))
    await alice.send(topic, bobId.pubkey, 'second')
    await waitFor(() => bobGot.length === 2, 3000, 'second directed')
    await new Promise((r) => setTimeout(r, 50))
    expect(carolGot).toHaveLength(0)
    expect(bobGot.filter((s) => s.from === bobId.pubkey)).toHaveLength(0)
  })

  test('reconnects and resubscribes after a relay restart', async () => {
    const r = relay()
    const { a: alice } = adapter([r.url])
    const { a: bob, identity: bobId } = adapter([r.url])
    await waitFor(() => allOpen(alice) && allOpen(bob), 3000, 'open')
    const got: Signal[] = []
    bob.subscribe(topic, (s) => got.push(s))

    r.stop()
    await waitFor(() => alice.status().every((s) => s.state !== 'open'), 3000, 'closed')
    r.start()
    await waitFor(() => allOpen(alice) && allOpen(bob), 5000, 'reopened')
    await new Promise((res) => setTimeout(res, 50))

    await alice.send(topic, bobId.pubkey, 'after-restart')
    await waitFor(() => got.length === 1, 3000, 'signal after restart')
    expect(got[0]?.content).toBe('after-restart')
  })

  test('queued publish is delivered once the relay comes back', async () => {
    const r = relay()
    const { a: alice } = adapter([r.url])
    const bobId = testIdentity()
    await waitFor(() => allOpen(alice), 3000, 'open')
    r.stop()
    await waitFor(() => alice.status().every((s) => s.state !== 'open'), 3000, 'closed')
    const sent = alice.send(topic, bobId.pubkey, 'queued')
    r.start()
    await sent
    expect(r.received.map((e) => e.content)).toEqual(['queued'])
  })

  test('answers NIP-42 AUTH and then publishes/subscribes', async () => {
    const r = relay({ requireAuth: true })
    const { a: alice, identity: aliceId } = adapter([r.url])
    const { a: bob, identity: bobId } = adapter([r.url])
    const got: Signal[] = []
    bob.subscribe(topic, (s) => got.push(s))
    await waitFor(() => r.authedPubkeys.length === 2, 3000, 'auth')
    expect(r.authedPubkeys.sort()).toEqual([aliceId.pubkey, bobId.pubkey].sort())
    await new Promise((res) => setTimeout(res, 50))
    await alice.announce(topic, 'authed hello')
    await waitFor(() => got.length === 1, 3000, 'authed announce')
  })

  test('auth: false does not answer challenges and publish fails', async () => {
    const r = relay({ requireAuth: true })
    const { a: alice } = adapter([r.url], { auth: false, publishTimeoutMs: 300 })
    await waitFor(() => allOpen(alice), 3000, 'open')
    await expect(alice.announce(topic, 'x')).rejects.toThrow(/auth-required/)
    expect(r.authedPubkeys).toHaveLength(0)
  })

  test('drops events with a bad signature, stale or expired events', async () => {
    const r = relay()
    const { a: bob } = adapter([r.url])
    await waitFor(() => allOpen(bob), 3000, 'open')
    const got: Signal[] = []
    bob.subscribe(topic, (s) => got.push(s))
    await new Promise((res) => setTimeout(res, 50))

    const mallory = testIdentity()
    const good = await signEvent({ kind: 20100, tags: [['t', topic]], content: 'good' }, mallory)
    r.inject({ ...good, content: 'forged' }) // id mismatch
    r.inject({ ...good, sig: good.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }) // bad sig
    const stale = await signEvent(
      {
        kind: 20100,
        tags: [['t', topic]],
        content: 'old',
        created_at: Math.floor(Date.now() / 1000) - 600,
      },
      mallory,
    )
    r.inject(stale)
    const expired = await signEvent(
      {
        kind: 20100,
        tags: [
          ['t', topic],
          ['expiration', '1'],
        ],
        content: 'expired',
      },
      mallory,
    )
    r.inject(expired)
    r.inject(good)
    r.inject(good) // duplicate
    await waitFor(() => got.length >= 1, 3000, 'good event')
    await new Promise((res) => setTimeout(res, 50))
    expect(got.map((s) => s.content)).toEqual(['good'])
    expect(bob.pool.dropped).toBe(2)
  })

  test('backs off and retries on rate-limited OK', async () => {
    const r = relay({ rateLimitFirst: 1 })
    const { a: alice } = adapter([r.url])
    const { a: bob } = adapter([r.url])
    await waitFor(() => allOpen(alice) && allOpen(bob), 3000, 'open')
    const got: Signal[] = []
    bob.subscribe(topic, (s) => got.push(s))
    await new Promise((res) => setTimeout(res, 50))
    await alice.announce(topic, 'eventually')
    await waitFor(() => got.length === 1, 4000, 'retried announce')
    expect(r.received).toHaveLength(1)
  })

  test('status reports per relay and unsubscribe stops delivery', async () => {
    const r = relay()
    const { a: alice } = adapter([r.url, 'ws://127.0.0.1:1'])
    const { a: bob } = adapter([r.url])
    await waitFor(() => alice.status()[0]?.state === 'open', 3000, 'open')
    const st = alice.status()
    expect(st).toHaveLength(2)
    expect(st[1]?.state).not.toBe('open')
    const got: Signal[] = []
    const unsub = alice.subscribe(topic, (s) => got.push(s))
    await waitFor(() => allOpen(bob), 3000, 'bob open')
    await new Promise((res) => setTimeout(res, 50))
    await bob.announce(topic, 'one')
    await waitFor(() => got.length === 1, 3000, 'first')
    unsub()
    await new Promise((res) => setTimeout(res, 50))
    await bob.announce(topic, 'two')
    await new Promise((res) => setTimeout(res, 100))
    expect(got).toHaveLength(1)
  })
})
