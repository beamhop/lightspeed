import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { decodeRelayEnvelope, encodeRelayEnvelope, relayHelloHash } from '@beamhop/p2p/wire'
import { schnorr } from '@noble/curves/secp256k1'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay, WsClient } from './testing'
import { bytesToHex, getPublicKey, randomHex } from './util/crypto'

let t: TestRelay
let cookie: string

beforeAll(async () => {
  t = await startTestRelay({ data: { maxFrameBytes: 4096 } })
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
  await api(t.base, '/api/admin/apps', { cookie, body: { name: 'A', id: 'app-a' } })
  await api(t.base, '/api/admin/apps', { cookie, body: { name: 'B', id: 'app-b' } })
})
afterAll(() => t.close())

async function connect(appId: string, sk = randomHex(32)) {
  const c = await WsClient.open(`${t.wsBase}/a/${appId}/data`)
  const ch = await c.next<{ type: string; challenge: string }>((m) => m.type === 'challenge')
  expect(ch.challenge).toHaveLength(64)
  const pubkey = getPublicKey(sk)
  const sig = bytesToHex(schnorr.sign(relayHelloHash(appId, ch.challenge), sk))
  c.send(JSON.stringify({ type: 'hello', pubkey, sig }))
  await c.next((m) => m.type === 'ready')
  return { c, pubkey }
}

describe('data relay', () => {
  test('forwards envelopes between two authenticated peers of the same app', async () => {
    const a = await connect('app-a')
    const b = await connect('app-a')
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    a.c.send(encodeRelayEnvelope(b.pubkey, payload))
    const got = await b.c.next<Uint8Array>((m) => m instanceof Uint8Array)
    const env = decodeRelayEnvelope(got)
    expect(env.pubkey).toBe(a.pubkey)
    expect([...env.body]).toEqual([1, 2, 3, 4, 5])
    b.c.send(encodeRelayEnvelope(a.pubkey, new Uint8Array([9])))
    const back = decodeRelayEnvelope(await a.c.next<Uint8Array>((m) => m instanceof Uint8Array))
    expect(back.pubkey).toBe(b.pubkey)
    expect([...back.body]).toEqual([9])

    t.relay.ctx.meter.flush()
    const usage = await api(t.base, '/api/admin/apps/app-a/usage', { cookie })
    expect(usage.body.month.dataBytes).toBe(32 + 5 + 32 + 5 + (32 + 1) * 2)
    expect(t.relay.ctx.dataRelay.stats().peers).toBe(2)
    a.c.close()
    b.c.close()
  })

  test('peer-offline for unknown destinations and other apps', async () => {
    const a = await connect('app-a')
    const other = await connect('app-b')
    const ghost = getPublicKey(randomHex(32))
    a.c.send(encodeRelayEnvelope(ghost, new Uint8Array([1])))
    expect(await a.c.next((m) => m.type === 'peer-offline')).toEqual({
      type: 'peer-offline',
      pubkey: ghost,
    })
    a.c.send(encodeRelayEnvelope(other.pubkey, new Uint8Array([1])))
    expect(await a.c.next((m) => m.type === 'peer-offline')).toEqual({
      type: 'peer-offline',
      pubkey: other.pubkey,
    })
    a.c.close()
    other.c.close()
  })

  test('rejects bad signatures, frames before hello, oversized frames', async () => {
    const c = await WsClient.open(`${t.wsBase}/a/app-a/data`)
    const ch = await c.next<{ challenge: string }>((m) => m.type === 'challenge')
    const sk = randomHex(32)
    const wrong = bytesToHex(schnorr.sign(relayHelloHash('app-b', ch.challenge), sk))
    c.send(JSON.stringify({ type: 'hello', pubkey: getPublicKey(sk), sig: wrong }))
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ code: 'bad-signature' })
    expect((await c.waitClosed())?.code).toBe(4000)

    const d = await WsClient.open(`${t.wsBase}/a/app-a/data`)
    await d.next((m) => m.type === 'challenge')
    d.send(encodeRelayEnvelope(getPublicKey(sk), new Uint8Array([1])))
    expect(await d.next((m) => m.type === 'error')).toMatchObject({ code: 'not-authenticated' })

    const e = await connect('app-a')
    e.c.send(encodeRelayEnvelope(e.pubkey, new Uint8Array(5000)))
    expect(await e.c.next((m) => m.type === 'error')).toMatchObject({ code: 'too-large' })
    e.c.close()
  })

  test('a second connection with the same pubkey replaces the first', async () => {
    const sk = randomHex(32)
    const first = await connect('app-a', sk)
    const second = await connect('app-a', sk)
    expect((await first.c.waitClosed())?.code).toBe(4001)
    const peer = await connect('app-a')
    peer.c.send(encodeRelayEnvelope(second.pubkey, new Uint8Array([7])))
    expect(
      decodeRelayEnvelope(await second.c.next<Uint8Array>((m) => m instanceof Uint8Array)).body[0],
    ).toBe(7)
    second.c.close()
    peer.c.close()
  })

  test('monthly data quota', async () => {
    await api(t.base, '/api/admin/apps/app-b', {
      method: 'PATCH',
      cookie,
      body: { dataMonthlyBytes: 300 },
    })
    const a = await connect('app-b')
    const b = await connect('app-b')
    a.c.send(encodeRelayEnvelope(b.pubkey, new Uint8Array(80)))
    await b.c.next((m) => m instanceof Uint8Array)
    a.c.send(encodeRelayEnvelope(b.pubkey, new Uint8Array(80)))
    expect(await a.c.next((m) => m.type === 'error')).toMatchObject({ code: 'quota-exceeded' })
    a.c.close()
    b.c.close()
  })

  test('unknown app and plain HTTP are refused', async () => {
    await expect(WsClient.open(`${t.wsBase}/a/nope/data`)).rejects.toThrow()
    expect((await fetch(`${t.base}/a/app-a/data`)).status).toBe(426)
  })
})
