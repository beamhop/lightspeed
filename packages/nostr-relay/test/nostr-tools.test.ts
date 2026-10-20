// Interop: drive the relay with nostr-tools as an independent client implementation.
import { afterEach, describe, expect, test } from 'bun:test'
import { type Event, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import { staticPolicy } from '../src/index'
import { sleep, startRelay, type TestRelay } from './helpers'

let t: TestRelay
afterEach(() => t.close())

const note = (sk: Uint8Array, content: string, kind = 1, tags: string[][] = []) =>
  finalizeEvent({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) }, sk)

describe('nostr-tools client', () => {
  test('publish, subscribe with EOSE, live events, COUNT', async () => {
    t = startRelay()
    const relay = await Relay.connect(t.url)
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const e1 = note(sk, 'hello from nostr-tools')
    expect(await relay.publish(e1)).toBe('')
    const got: Event[] = []
    let eose = false
    const sub = relay.subscribe([{ authors: [pk] }], {
      onevent: (e) => got.push(e),
      oneose: () => {
        eose = true
      },
    })
    for (let i = 0; i < 50 && !eose; i++) await sleep(10)
    expect(eose).toBe(true)
    expect(got.map((e) => e.id)).toEqual([e1.id])
    const e2 = note(sk, 'live')
    await relay.publish(e2)
    for (let i = 0; i < 50 && got.length < 2; i++) await sleep(10)
    expect(got.map((e) => e.id)).toEqual([e1.id, e2.id])
    sub.close()
    expect(await relay.count([{ authors: [pk] }], {})).toBe(2)
    relay.close()
  })

  test('rejections surface as errors with the OK message', async () => {
    t = startRelay({ policy: staticPolicy({ global: { kinds: { deny: [7] } } }) })
    const relay = await Relay.connect(t.url)
    const sk = generateSecretKey()
    await expect(relay.publish(note(sk, '+', 7))).rejects.toThrow('blocked: kind 7 is not allowed')
    relay.close()
  })

  test('NIP-42 auth through nostr-tools', async () => {
    const relayUrl = 'wss://relay.example.com'
    t = startRelay({
      auth: { relayUrl },
      policy: staticPolicy({ global: { authRequiredKinds: [4] } }),
    })
    const relay = await Relay.connect(t.url)
    const sk = generateSecretKey()
    await sleep(20)
    // nostr-tools puts relay.url (our ws://127.0.0.1) in the tag, so sign our own with the public URL
    const res = await relay.auth(async (tmpl) =>
      finalizeEvent(
        { ...tmpl, tags: tmpl.tags.map((tg) => (tg[0] === 'relay' ? ['relay', relayUrl] : tg)) },
        sk,
      ),
    )
    expect(res).toBe('')
    expect(await relay.publish(note(sk, 'dm', 4))).toBe('')
    relay.close()
  })
})
