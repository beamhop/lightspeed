import { expect, test } from 'bun:test'
import { anonymous } from '../identity/anonymous'
import { createSignalingHub, memorySignaling } from '../signaling/memory'
import { createMemoryHub, memoryTransport } from '../transport/memory'
import { VirtualClock } from '../util/clock'
import type { DevtoolsChannelLike } from './devtools'
import { createRoom } from './room'

function fakeChannel() {
  const posted: { type: string; [k: string]: unknown }[] = []
  const listeners = new Set<(e: { data: unknown }) => void>()
  let name = ''
  const ch: DevtoolsChannelLike = {
    postMessage: (m) => posted.push(structuredClone(m) as { type: string }),
    addEventListener: (_t, cb) => listeners.add(cb),
    removeEventListener: (_t, cb) => listeners.delete(cb),
    close: () => listeners.clear(),
  }
  return {
    posted,
    get name() {
      return name
    },
    create: (n: string) => {
      name = n
      return ch
    },
    studio: (data: unknown) => {
      for (const l of listeners) l({ data })
    },
  }
}

test('devtools bridge speaks the Studio protocol and drives memory-transport faults', async () => {
  const clock = new VirtualClock()
  const sig = createSignalingHub({ clock, latencyMs: 5 })
  const net = createMemoryHub({ clock, defaults: { latencyMs: 10 } })
  const mk = (name: string, policy?: { attest: { nostr: true } }) =>
    createRoom({
      appId: 'dev',
      roomId: 'lobby',
      identity: anonymous(),
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
      clock,
      meta: { name },
      ...(policy ? { policy } : {}),
    })
  const a = await mk('alice')
  const b = await mk('bob')
  await clock.until(() => a.peers.length === 1 && b.peers.length === 1)

  const fc = fakeChannel()
  const identities: boolean[] = []
  const bridge = a.devtools({
    createChannel: fc.create,
    onIdentity: (_i, r) => identities.push(r.admitted),
  })
  expect(fc.name).toBe('beamhop-devtools:lobby')
  const hello = fc.posted.find((m) => m.type === 'hello') as unknown as {
    self: string
    peers: { pubkey: string; isSelf?: boolean; name?: string }[]
  }
  expect(hello.self).toBe(a.self.pubkey)
  expect(hello.peers.map((p) => p.name)).toEqual(['alice', 'bob'])
  expect(hello.peers[0]?.isSelf).toBe(true)

  // Studio says hello: page re-sends hello and replays recent telemetry.
  fc.posted.length = 0
  fc.studio({ type: 'studio-hello' })
  expect(fc.posted[0]?.type).toBe('hello')
  expect(fc.posted.some((m) => m.type === 'telemetry' && m.source === a.self.pubkey)).toBe(true)

  // Latency fault on every peer changes the hub defaults; clearing restores them.
  fc.studio({ type: 'fault', id: 'f1', fault: { type: 'latency', ms: 250 } })
  expect(net.defaults.latencyMs).toBe(250)
  fc.studio({ type: 'clear-fault', id: 'f1' })
  expect(net.defaults.latencyMs).toBe(10)
  fc.studio({ type: 'fault', id: 'f2', fault: { type: 'loss', rate: 0.5, peer: b.self.pubkey } })
  expect(net.conditions(a.self.pubkey, b.self.pubkey).loss).toBe(0.5)
  fc.studio({ type: 'clear-fault', id: 'f2' })
  expect(net.conditions(a.self.pubkey, b.self.pubkey).loss).toBe(0)

  // Kill b: a sees it away; clearing revives and the session resumes.
  fc.studio({ type: 'fault', id: 'k', fault: { type: 'kill', peer: b.self.pubkey } })
  await clock.until(() => a.peer(b.self.pubkey)?.state === 'away')
  expect(fc.posted.some((m) => m.type === 'peers')).toBe(true)
  fc.studio({ type: 'clear-fault', id: 'k' })
  await clock.until(() => a.peer(b.self.pubkey)?.state === 'connected', 30_000)

  // Partition and heal.
  fc.studio({
    type: 'fault',
    id: 'p',
    fault: { type: 'partition', groups: [[a.self.pubkey], [b.self.pubkey]] },
  })
  await clock.until(() => a.peer(b.self.pubkey)?.state === 'away')
  fc.studio({ type: 'clear-fault', id: 'p' })
  await clock.until(() => a.peer(b.self.pubkey)?.state === 'connected', 30_000)

  // Connection info for a live link.
  fc.studio({ type: 'connection-info?', source: a.self.pubkey, peer: b.self.pubkey })
  await clock.advance(10)
  const info = fc.posted.find((m) => m.type === 'connection-info') as unknown as {
    info: { path: string; channels: { label: string }[] }
  }
  expect(info.info.path).toBe('memory')
  expect(info.info.channels.map((c) => c.label)).toEqual(['bh/r', 'bh/u', 'bh/x'])

  // Identity switcher: evaluated against the room policy.
  const other = await anonymous().load()
  fc.studio({
    type: 'identity',
    identity: {
      kind: 'anonymous',
      pubkey: other.pubkey,
      label: 'anon',
      attestation: { type: 'anonymous' },
    },
  })
  await clock.advance(10)
  expect(identities).toEqual([true])
  expect(fc.posted.find((m) => m.type === 'admission')).toMatchObject({
    pubkey: other.pubkey,
    admitted: true,
  })

  bridge.close()
  await clock.run(a.leave())
  await clock.run(b.leave())
})
