// Seeded deterministic simulator: N peers over the memory transport with latency, jitter, loss and
// partitions, driven by a virtual clock. Every run with the same seed produces the same event trace.
import { describe, expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha256'
import { anonymous } from './identity/anonymous'
import { getPublicKey } from './identity/key'
import { action, any, defineProtocol } from './room/protocol'
import { createRoom } from './room/room'
import type { IncomingFile, Room, Topology } from './room/types'
import { createSignalingHub, memorySignaling } from './signaling/memory'
import { createMemoryHub, memoryTransport } from './transport/memory'
import type { Hex } from './types'
import { bytesToHex } from './util/bytes'
import { VirtualClock, seededRandom } from './util/clock'

const proto = defineProtocol({
  chat: action(any<{ n: number; text: string }>()),
})

type R = Room<typeof proto>

function seededKeys(seed: number, n: number): { sk: Uint8Array; pk: Hex }[] {
  const rnd = seededRandom(seed)
  const out = []
  for (let i = 0; i < n; i++) {
    const sk = new Uint8Array(32)
    for (let j = 0; j < 32; j++) sk[j] = Math.floor(rnd() * 256)
    sk[0] = (sk[0] as number) & 0x7f // stay below the curve order
    out.push({ sk, pk: getPublicKey(sk) })
  }
  return out
}

function world(seed: number, topology: Topology = 'mesh') {
  const clock = new VirtualClock()
  const signaling = createSignalingHub({ clock, latencyMs: 15 })
  const net = createMemoryHub({ clock, seed, defaults: { latencyMs: 20, jitterMs: 10, loss: 0.05 }, detectMs: 1500 })
  const trace: string[] = []
  const rooms: R[] = []
  const chats = new Map<Hex, string[]>()
  const leaves: string[] = []
  const join = async (sk: Uint8Array): Promise<R> => {
    const r = await createRoom({
      appId: 'sim',
      roomId: 'lobby',
      identity: anonymous({ secretKey: sk }),
      signaling: memorySignaling(signaling),
      transports: [memoryTransport(net)],
      topology,
      protocol: proto,
      clock,
      timeouts: { connectMs: 3000, resumeWindowMs: 30_000, pingIntervalMs: 2000 },
    })
    const me = r.self.pubkey.slice(0, 6)
    chats.set(r.self.pubkey, [])
    r.action('chat').onMessage((m, from) => chats.get(r.self.pubkey)?.push(`${from.slice(0, 6)}:${m.n}`))
    r.onPeerLeave((p) => leaves.push(`${me}<-${p.pubkey.slice(0, 6)}`))
    r.telemetry.subscribe((e) => {
      if (e.type === 'peer') trace.push(`${e.at} ${me} peer ${e.event} ${e.peer.slice(0, 6)}`)
      else if (e.type === 'connection') trace.push(`${e.at} ${me} conn ${e.state} ${e.peer.slice(0, 6)}`)
      else if (e.type === 'message' && !e.action.startsWith('__')) trace.push(`${e.at} ${me} msg ${e.direction} ${e.action} ${e.peer.slice(0, 6)}`)
      else if (e.type === 'host') trace.push(`${e.at} ${me} host ${e.host?.slice(0, 6)}`)
    })
    rooms.push(r)
    return r
  }
  const meshComplete = (rs: R[]) =>
    rs.every((r) => r.peers.length === rs.length - 1 && r.peers.every((p) => p.state === 'connected'))
  const converged = (rs: R[]) => rs.every((r) => r.state.digest() === rs[0]?.state.digest())
  return { clock, signaling, net, trace, rooms, chats, leaves, join, meshComplete, converged }
}

async function meshScenario(seed: number) {
  const w = world(seed)
  const { clock, net } = w
  const keys = seededKeys(seed, 6)
  const peers: R[] = []
  for (const k of keys.slice(0, 5)) peers.push(await w.join(k.sk))
  const [p0, p1, p2, p3, p4] = peers as [R, R, R, R, R]

  // 1. join
  await clock.until(() => w.meshComplete(peers), 20_000)

  // 2. chat: everyone sends, everyone else receives exactly once
  await clock.run(Promise.all(peers.map((r, i) => r.action('chat').send({ n: i, text: `hi from ${i}` }))))
  await clock.until(() => peers.every((r) => w.chats.get(r.self.pubkey)?.length === 4))

  // 3. state: LWW map with concurrent writes to the same key + an append-only log
  for (const [i, r] of peers.entries()) {
    r.state.map<number>('scores').set(`p${i}`, i * 10)
    r.state.map<string>('scores').set('winner', `p${i}`)
    r.state.log<string>('events').append(`joined ${i}`)
  }
  await clock.until(() => w.converged(peers))
  const winner = p0.state.map<string>('scores').get('winner')
  expect(peers.every((r) => r.state.map('scores').get('winner') === winner)).toBe(true)
  expect(p0.state.log('events').length).toBe(5)

  // 4. partition {p0,p1} | {p2,p3,p4}; keep writing on both sides, then heal: sessions resume
  const leavesBefore = w.leaves.length
  net.partition([p0.self.pubkey, p1.self.pubkey], [p2.self.pubkey, p3.self.pubkey, p4.self.pubkey])
  await clock.advance(200)
  // Sent into the partition: queued/unacked, delivered after resume (at-least-once, deduplicated).
  void p2.action('chat').send({ n: 100, text: 'during partition' })
  p0.state.map<number>('scores').set('p0', 999)
  p3.state.log<string>('events').append('partitioned write')
  await clock.until(() => p0.peers.some((p) => p.pubkey === p2.self.pubkey && p.state === 'away'), 10_000)
  await clock.advance(3000)
  net.heal()
  await clock.until(() => w.meshComplete(peers), 30_000)
  await clock.until(() => w.converged(peers), 10_000)
  expect(w.leaves.length).toBe(leavesBefore) // away/back, never leave/join
  await clock.until(() => peers.filter((r) => r !== p2).every((r) => w.chats.get(r.self.pubkey)?.includes(`${p2.self.pubkey.slice(0, 6)}:100`)))
  for (const r of peers) {
    const got = w.chats.get(r.self.pubkey) ?? []
    expect(new Set(got).size).toBe(got.length) // exactly once
  }
  expect(p4.state.map('scores').get('p0')).toBe(999)
  expect(p0.state.log('events').values()).toContain('partitioned write')

  // 5. late joiner catches up from a snapshot
  const p5 = await w.join((keys[5] as { sk: Uint8Array }).sk)
  const all = [...peers, p5]
  await clock.until(() => w.meshComplete(all), 20_000)
  await clock.until(() => w.converged(all), 10_000)
  expect(p5.state.log('events').length).toBe(6)
  expect(p5.state.map('scores').get('p0')).toBe(999)

  // 6. 1 MB file transfer with progress and backpressure (1 MB/s links)
  net.setDefaults({ bandwidthBps: 1_000_000 })
  const data = new Uint8Array(1024 * 1024)
  const rnd = seededRandom(seed + 1)
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256)
  let incoming: IncomingFile | null = null
  p5.onFile((f) => {
    incoming = f
  })
  const progress: number[] = []
  const recvProgress: number[] = []
  const sending = p1.sendFile(data, { to: p5.self.pubkey, name: 'blob.bin', onProgress: (sent) => progress.push(sent) })
  await clock.until(() => incoming !== null)
  const file = incoming as unknown as IncomingFile
  file.onProgress((n) => recvProgress.push(n))
  const bytesP = file.bytes()
  await clock.run(sending, 60_000)
  const received = await clock.run(bytesP, 60_000)
  expect(file.name).toBe('blob.bin')
  expect(file.size).toBe(data.length)
  expect(received.length).toBe(data.length)
  expect(bytesToHex(sha256(received))).toBe(bytesToHex(sha256(data)))
  expect(progress.at(-1)).toBe(data.length)
  expect(progress.length).toBeGreaterThan(60)
  expect(progress.every((v, i) => i === 0 || v > (progress[i - 1] as number))).toBe(true)
  expect(recvProgress.at(-1)).toBe(data.length)

  for (const r of all) await clock.run(r.leave())
  return { trace: w.trace, now: clock.now() }
}

async function starScenario(seed: number) {
  const w = world(seed, { star: {} })
  const { clock } = w
  const keys = seededKeys(seed, 5).sort((a, b) => (a.pk < b.pk ? -1 : 1))
  const peers: R[] = []
  for (const k of keys) peers.push(await w.join(k.sk))
  const host = peers[0] as R
  const clients = peers.slice(1)
  // Everyone agrees on the lowest pubkey as host; clients hold one direct session (to the host).
  await clock.until(
    () =>
      peers.every((r) => r.host === host.self.pubkey && r.peers.length === 4) &&
      clients.every((c) => c.debug.sessions().length === 1),
    20_000,
  )
  for (const c of clients) {
    expect(c.debug.sessions().map((s) => s.remote)).toEqual([host.self.pubkey])
    expect(c.peers.find((p) => p.pubkey === host.self.pubkey)?.isHost).toBe(true)
  }
  expect(host.debug.sessions().length).toBe(4)

  // Client → host → other clients, origin preserved.
  const c1 = clients[0] as R
  await clock.run(c1.action('chat').send({ n: 1, text: 'via host' }))
  await clock.until(() => peers.filter((r) => r !== c1).every((r) => w.chats.get(r.self.pubkey)?.includes(`${c1.self.pubkey.slice(0, 6)}:1`)))

  // Directed message between two clients goes through the host.
  const c2 = clients[1] as R
  await clock.run(c1.action('chat').send({ n: 2, text: 'dm' }, { to: c2.self.pubkey }))
  await clock.until(() => w.chats.get(c2.self.pubkey)?.includes(`${c1.self.pubkey.slice(0, 6)}:2`) ?? false)
  await clock.advance(500)
  expect(w.chats.get((clients[2] as R).self.pubkey)).not.toContain(`${c1.self.pubkey.slice(0, 6)}:2`)

  for (const [i, r] of peers.entries()) r.state.map<number>('m').set(`k${i}`, i)
  await clock.until(() => w.converged(peers))

  // Host leaves: next-lowest pubkey takes over, the remaining peers reconnect to it.
  const leavesBefore = w.leaves.length
  await clock.run(host.leave())
  const rest = clients
  const next = rest[0] as R
  await clock.until(() => rest.every((r) => r.host === next.self.pubkey && r.peers.length === 3 && r.peers.every((p) => p.state === 'connected')) && rest.slice(1).every((c) => c.debug.sessions().some((s) => s.remote === next.self.pubkey && s.state === 'connected')) && next.debug.sessions().filter((s) => s.state === 'connected').length === 3, 30_000)
  // Only the old host was reported as leaving, once per remaining peer.
  expect(w.leaves.slice(leavesBefore).filter((l) => !l.startsWith(host.self.pubkey.slice(0, 6))).sort()).toEqual(rest.map((r) => `${r.self.pubkey.slice(0, 6)}<-${host.self.pubkey.slice(0, 6)}`).sort())
  for (const c of rest.slice(1)) expect(c.debug.sessions().filter((s) => s.state === 'connected').map((s) => s.remote)).toEqual([next.self.pubkey])
  const c3 = rest[2] as R
  await clock.run(c3.action('chat').send({ n: 3, text: 'after handoff' }))
  await clock.until(() => rest.filter((r) => r !== c3).every((r) => w.chats.get(r.self.pubkey)?.includes(`${c3.self.pubkey.slice(0, 6)}:3`)))
  c3.state.map<number>('m').set('after', 1)
  await clock.until(() => w.converged(rest) && next.state.map('m').get('after') === 1)
  for (const r of rest) await clock.run(r.leave())
}

describe('simulator (seeded, deterministic)', () => {
  test('mesh: join, chat, state, partition resume, late joiner, 1 MB file', async () => {
    const run1 = await meshScenario(42)
    expect(run1.trace.length).toBeGreaterThan(50)
    // Same seed → identical trace.
    const run2 = await meshScenario(42)
    expect(run2.trace).toEqual(run1.trace)
    expect(run2.now).toBe(run1.now)
  }, 60_000)

  test('mesh scenario holds across seeds', async () => {
    const n = Number(process.env.SIM_SEEDS ?? 3)
    for (let seed = 1; seed <= n; seed++) await meshScenario(seed * 7919)
  }, 300_000)

  test('star: host routing, state, host handoff on leave', async () => {
    const n = Number(process.env.SIM_SEEDS ?? 3)
    for (let seed = 7; seed < 7 + n; seed++) await starScenario(seed)
  }, 300_000)


  test('kill + revive: a crashed peer comes back without leave/join', async () => {
    const w = world(3)
    const keys = seededKeys(3, 3)
    const peers: R[] = []
    for (const k of keys) peers.push(await w.join(k.sk))
    await w.clock.until(() => w.meshComplete(peers), 20_000)
    const victim = peers[1] as R
    w.net.kill(victim.self.pubkey)
    await w.clock.until(() => (peers[0] as R).peer(victim.self.pubkey)?.state === 'away', 10_000)
    w.net.revive(victim.self.pubkey)
    await w.clock.until(() => w.meshComplete(peers), 30_000)
    expect(w.leaves).toEqual([])
    for (const r of peers) await w.clock.run(r.leave())
  }, 30_000)
})
