// Studio adapters against real @beamhop/p2p rooms over memory transports: the BroadcastChannel
// bridge talks to `room.devtools()`, the observer joins with a `debug` capability token.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  action,
  any,
  createMemoryHub,
  createRoom,
  createSignalingHub,
  defineProtocol,
  generateSecretKey,
  getPublicKey,
  type Hex,
  memorySignaling,
  memoryTransport,
  nostr,
  type Room,
  type RoomOptions,
} from '@beamhop/p2p'
import type { DevtoolsChannelLike } from '@beamhop/p2p/devtools'
import { bytesToHex } from '@noble/hashes/utils'
import { anonymousIdentity, nostrIdentity } from '../identity'
import type { StudioEvent } from '../room-adapter'
import { BridgeRoom, type ChannelLike } from './bridge'
import { ObserverRoom } from './observer'

const proto = defineProtocol({ chat: action(any<string>()) })

/** In-process BroadcastChannel: delivers to every other endpoint with the same name, async. */
class Bus {
  private endpoints = new Map<string, Set<Endpoint>>()
  open(name: string): Endpoint {
    const ep = new Endpoint(name, this)
    let set = this.endpoints.get(name)
    if (!set) {
      set = new Set()
      this.endpoints.set(name, set)
    }
    set.add(ep)
    return ep
  }
  deliver(from: Endpoint, data: unknown) {
    const copy = structuredClone(data)
    for (const ep of this.endpoints.get(from.name) ?? []) {
      if (ep !== from) setTimeout(() => ep.emit(copy), 0)
    }
  }
  remove(ep: Endpoint) {
    this.endpoints.get(ep.name)?.delete(ep)
  }
}

class Endpoint implements ChannelLike, DevtoolsChannelLike {
  private cbs = new Set<(e: { data: unknown }) => void>()
  constructor(
    readonly name: string,
    private bus: Bus,
  ) {}
  postMessage(m: unknown) {
    this.bus.deliver(this, m)
  }
  addEventListener(_t: 'message', cb: (e: { data: unknown }) => void) {
    this.cbs.add(cb)
  }
  removeEventListener(_t: 'message', cb: (e: { data: unknown }) => void) {
    this.cbs.delete(cb)
  }
  close() {
    this.bus.remove(this)
  }
  emit(data: unknown) {
    for (const cb of this.cbs) cb({ data })
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function network() {
  const sig = createSignalingHub({ latencyMs: 1 })
  const net = createMemoryHub({ seed: 3, defaults: { latencyMs: 1 }, detectMs: 50 })
  const join = async (extra: Partial<RoomOptions<typeof proto>>) => {
    const r = await createRoom({
      appId: 'studio-test',
      roomId: 'live',
      identity: nostr({ nsec: bytesToHex(generateSecretKey()) }),
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
      protocol: proto,
      timeouts: { resumeWindowMs: 5000, connectMs: 300 },
      ...extra,
    })
    cleanups.push(() => r.leave())
    return r
  }
  return { sig, net, join }
}

const sources = (events: readonly StudioEvent[]) => new Set(events.map((e) => e.source))

describe('BridgeRoom against room.devtools()', () => {
  test('telemetry, peers, connection info, faults and admission', async () => {
    const { net, join } = network()
    const policy = { attest: { nostr: true, anonymous: false } }
    const a: Room<typeof proto> = await join({ policy, meta: { name: 'ada' } })
    const b: Room<typeof proto> = await join({ policy, meta: { name: 'bob' } })
    await until(() => a.peers.length === 1 && b.peers.length === 1)

    const bus = new Bus()
    const da = a.devtools({ createChannel: (n) => bus.open(n) })
    const db = b.devtools({ createChannel: (n) => bus.open(n) })
    cleanups.push(
      () => da.close(),
      () => db.close(),
    )

    const studio = new BridgeRoom({
      roomId: 'live',
      channel: () => bus.open('beamhop-devtools:live'),
    })
    cleanups.push(() => studio.leave())
    await studio.join()

    // studio-hello → each page answers with hello + a replay of its recent telemetry.
    await until(() => sources(studio.history()).size === 2)
    expect(sources(studio.history())).toEqual(new Set([a.self.pubkey, b.self.pubkey]))
    await until(() => studio.peers().length === 2)
    expect(
      studio
        .peers()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['ada', 'bob'])

    // Live events flow as they happen.
    const before = studio.history().length
    await a.action('chat').send('hi')
    await until(() =>
      studio
        .history()
        .slice(before)
        .some((e) => e.event.type === 'message' && e.source === b.self.pubkey),
    )

    // Connection info is requested, then answered asynchronously.
    expect(studio.connectionInfo(a.self.pubkey, b.self.pubkey)).toBeNull()
    await until(() => studio.connectionInfo(a.self.pubkey, b.self.pubkey) !== null)
    expect(studio.connectionInfo(a.self.pubkey, b.self.pubkey)?.path).toBe('memory')

    // Faults are applied to the memory hub behind the rooms and reverted on clear.
    const kill = await studio.injectFault({ type: 'kill', peer: b.self.pubkey })
    await until(() => a.peer(b.self.pubkey)?.state === 'away')
    expect(
      studio
        .history()
        .some(
          (e) =>
            e.source === a.self.pubkey && e.event.type === 'connection' && e.event.state === 'away',
        ),
    ).toBe(true)
    await studio.clearFault(kill.id)
    await until(() => a.peer(b.self.pubkey)?.state === 'connected')
    expect(net.defaults.latencyMs).toBe(1)

    // Identity switcher: the pages evaluate the identity against their room policy.
    const nostrId = nostrIdentity({ secretKey: bytesToHex(generateSecretKey()) }).identity
    expect(await studio.setIdentity(nostrId)).toEqual({ admitted: true })
    const anon = await studio.setIdentity(anonymousIdentity().identity)
    expect(anon.admitted).toBe(false)
    expect(anon.reason).toBe('no acceptable attestation')
  })
})

describe('ObserverRoom against real rooms', () => {
  test('receives every peer telemetry with a debug token from a trusted issuer', async () => {
    const { sig, net, join } = network()
    const appKey = generateSecretKey()
    const policy = { capabilities: { issuers: [getPublicKey(appKey)] } }
    const a = await join({ policy, meta: { name: 'ada' } })
    const b = await join({ policy, meta: { name: 'bob' } })
    await until(() => a.peers.length === 1 && b.peers.length === 1)

    const observer = new ObserverRoom({
      appId: 'studio-test',
      roomId: 'live',
      relay: 'ws://unused',
      appSecretKey: bytesToHex(appKey),
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
    })
    cleanups.push(() => observer.leave())
    await observer.join()
    const self = observer.current?.self.pubkey as Hex
    await until(() => observer.peers().length === 3)
    expect(observer.peers().find((p) => p.isSelf)?.pubkey).toBe(self)

    // Remote telemetry from both peers arrives over __beamhop/telemetry.
    await a.action('chat').send('hello')
    await until(() => {
      const s = sources(observer.history())
      return s.has(a.self.pubkey) && s.has(b.self.pubkey)
    })
    await until(() =>
      observer
        .history()
        .some(
          (e) =>
            e.source === b.self.pubkey && e.event.type === 'message' && e.event.direction === 'in',
        ),
    )
    // Observer-side connection info for its own sessions.
    await until(() => observer.connectionInfo(self, a.self.pubkey) !== null)
    expect(observer.connectionInfo(self, a.self.pubkey)?.path).toBe('memory')
    expect(observer.connectionInfo(a.self.pubkey, b.self.pubkey)).toBeNull()
  })

  test('peers ignore observe() without a trusted debug token', async () => {
    const { sig, net, join } = network()
    const policy = { capabilities: { issuers: [getPublicKey(generateSecretKey())] } }
    const a = await join({ policy })
    const b = await join({ policy })
    await until(() => a.peers.length === 1 && b.peers.length === 1)
    const observer = new ObserverRoom({
      appId: 'studio-test',
      roomId: 'live',
      relay: 'ws://unused',
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
    })
    cleanups.push(() => observer.leave())
    await observer.join()
    await until(() => observer.peers().length === 3)
    await a.action('chat').send('hello')
    await new Promise((r) => setTimeout(r, 100))
    const self = observer.current?.self.pubkey
    expect([...sources(observer.history())]).toEqual([self as Hex])
  })

  test('setIdentity re-joins and reports admission', async () => {
    const { sig, net, join } = network()
    const policy = { attest: { nostr: true }, dev: true }
    const a = await join({ policy })
    const observer = new ObserverRoom({
      appId: 'studio-test',
      roomId: 'live',
      relay: 'ws://unused',
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
      admissionTimeoutMs: 3000,
    })
    cleanups.push(() => observer.leave())
    const anon = await observer.setIdentity(anonymousIdentity().identity)
    expect(anon.admitted).toBe(false)
    expect(anon.reason).toContain('no acceptable attestation')
    const id = nostrIdentity({ secretKey: bytesToHex(generateSecretKey()) }).identity
    expect(await observer.setIdentity(id)).toEqual({ admitted: true })
    expect(observer.current?.self.pubkey).toBe(id.pubkey)
    await until(() => a.peer(id.pubkey) !== undefined)
  })
})
