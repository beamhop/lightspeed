import { describe, expect, test } from 'bun:test'
import { anonymous } from '../identity/anonymous'
import { issueCapability } from '../identity/capability'
import { generateSecretKey, getPublicKey } from '../identity/key'
import { nostr } from '../identity/nostr'
import { createSignalingHub, memorySignaling } from '../signaling/memory'
import { createMemoryHub, memoryTransport } from '../transport/memory'
import type { Hex, TelemetryEvent } from '../types'
import { VirtualClock } from '../util/clock'
import { action, any, defineProtocol, request, type StandardSchemaV1 } from './protocol'
import { createRoom } from './room'
import type { Room, RoomOptions } from './types'

// A tiny hand-written Standard Schema validator (stands in for Zod/Valibot).
const str: StandardSchemaV1<string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => (typeof v === 'string' ? { value: v } : { issues: [{ message: 'expected string' }] }),
  },
}
const num: StandardSchemaV1<number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => (typeof v === 'number' ? { value: v } : { issues: [{ message: 'expected number' }] }),
  },
}

const proto = defineProtocol({
  chat: action(str),
  cursor: action(any<{ x: number; y: number }>(), { reliability: 'unreliable' }),
  double: request(num, num),
})

function setup(seed = 1) {
  const clock = new VirtualClock()
  const sig = createSignalingHub({ clock, latencyMs: 5 })
  const net = createMemoryHub({ clock, seed, defaults: { latencyMs: 10 } })
  const rooms: Room<typeof proto>[] = []
  const join = async (extra: Partial<RoomOptions<typeof proto>> = {}) => {
    const r = await createRoom({
      appId: 'test',
      roomId: 'r1',
      identity: anonymous(),
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
      protocol: proto,
      clock,
      ...extra,
    })
    rooms.push(r)
    return r
  }
  return { clock, sig, net, join, rooms }
}

describe('room over memory transport', () => {
  test('two peers join, chat, request/response, validation', async () => {
    const { clock, join } = setup()
    const a = await join()
    const b = await join()
    await clock.until(() => a.peers.length === 1 && b.peers.length === 1)
    expect(a.peers[0]?.pubkey).toBe(b.self.pubkey)
    expect(a.peers[0]?.path).toBe('memory')

    const got: [string, Hex][] = []
    b.action('chat').onMessage((text, from) => got.push([text, from]))
    await clock.run(a.action('chat').send('hello'))
    await clock.until(() => got.length === 1)
    expect(got[0]).toEqual(['hello', a.self.pubkey])

    // Invalid payloads are rejected locally.
    await expect(a.action('chat').send(42 as unknown as string)).rejects.toThrow('expected string')

    b.request('double').handle((n) => n * 2)
    const p = a.request('double').call(b.self.pubkey, 21)
    await clock.advance(200)
    expect(await p).toBe(42)

    await clock.run(a.leave())
    await clock.until(() => b.peers.length === 0)
  })

  test('wrong password peers never meet', async () => {
    const { clock, join } = setup()
    const a = await join({ password: 'x' })
    const b = await join({ password: 'y' })
    await clock.advance(3000)
    expect(a.peers.length + b.peers.length).toBe(0)
  })

  test('policy: nostr-only room rejects anonymous peers; capability tokens', async () => {
    const { clock, join } = setup()
    const userSk = generateSecretKey()
    const policy = { attest: { nostr: { pubkeys: [getPublicKey(userSk)] } } }
    const a = await join({ identity: nostr({ nsec: userSk }), policy })
    const anon = await join({ policy })
    await clock.advance(3000)
    expect(a.peers.length).toBe(0)
    expect(anon.peers.length).toBe(0)
    const b = await join({ identity: nostr({ nsec: userSk }), policy })
    await clock.until(() => a.peers.length === 1 && b.peers.length === 1)
    expect(a.peers[0]?.verified[0]).toMatchObject({ type: 'nostr', ok: true })
  })

  test('capability required + debug observer receives telemetry', async () => {
    const { clock, join } = setup()
    const appKey = generateSecretKey()
    const policy = { capabilities: { issuers: [getPublicKey(appKey)], require: ['join'] } }
    const idA = await anonymous().load()
    const idS = await anonymous().load()
    const capA = await issueCapability(appKey, { room: '*', pubkey: idA.pubkey, caps: ['join'], exp: 2_000_000_000 })
    const capS = await issueCapability(appKey, { room: '*', pubkey: idS.pubkey, caps: ['join', 'debug'], exp: 2_000_000_000 })
    const a = await join({ identity: idA, capability: capA, policy })
    const nocap = await join({ policy })
    const studio = await join({ identity: idS, capability: capS, policy })
    await clock.until(() => a.peers.length === 1 && studio.peers.length === 1, 10_000)
    await clock.advance(2000)
    expect(nocap.peers.length).toBe(0)
    const remote: TelemetryEvent[] = []
    studio.telemetry.subscribeRemote((from, e) => {
      if (from === a.self.pubkey) remote.push(e)
    })
    await clock.run(studio.telemetry.observe(a.self.pubkey))
    await clock.advance(100)
    await clock.run(a.action('chat').send('observed'))
    await clock.advance(200)
    expect(remote.some((e) => e.type === 'message' && e.action === 'chat')).toBe(true)
  })
})
