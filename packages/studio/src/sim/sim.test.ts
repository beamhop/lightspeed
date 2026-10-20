import { describe, expect, test } from 'bun:test'
import { SimulatedRoom } from '../adapters/simulated'
import { linkKey } from '../model/events'
import { replayAt } from '../model/timeline'
import { activeLinks, buildTopology, presentNodes } from '../model/topology'
import { generateEvents, SimEngine } from './engine'
import { createRng } from './rng'

describe('rng', () => {
  test('same seed → same sequence; different seed → different', () => {
    const a = createRng(42)
    const b = createRng(42)
    const c = createRng(43)
    const sa = Array.from({ length: 20 }, () => a.next())
    const sb = Array.from({ length: 20 }, () => b.next())
    const sc = Array.from({ length: 20 }, () => c.next())
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(sc)
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true)
  })
  test('helpers stay in range', () => {
    const r = createRng(7)
    for (let i = 0; i < 200; i++) {
      const n = r.int(3, 5)
      expect(n >= 3 && n <= 5).toBe(true)
    }
    expect(r.hex(32)).toMatch(/^[0-9a-f]{64}$/)
    expect(['x', 'y']).toContain(
      r.weighted([
        ['x', 1],
        ['y', 1],
      ] as const),
    )
  })
})

describe('simulated source', () => {
  test('is deterministic for a seed', () => {
    const a = generateEvents({ seed: 1234, peers: 4 }, 15_000)
    const b = generateEvents({ seed: 1234, peers: 4 }, 15_000)
    expect(a.length).toBeGreaterThan(200)
    expect(a).toEqual(b)
    const c = generateEvents({ seed: 999, peers: 4 }, 15_000)
    expect(c).not.toEqual(a)
  })

  test('step granularity does not change the outcome', () => {
    const coarse = generateEvents({ seed: 5, peers: 3 }, 6000, 1000)
    const fine = generateEvents({ seed: 5, peers: 3 }, 6000, 50)
    expect(fine).toEqual(coarse)
  })

  test('produces a realistic mesh: every event kind, all peers connected', () => {
    const events = generateEvents({ seed: 3, peers: 5 }, 20_000)
    const types = new Set(events.map((e) => e.event.type))
    for (const t of ['signal', 'connection', 'path', 'bytes', 'rtt', 'message', 'peer']) {
      expect(types.has(t as never)).toBe(true)
    }
    const topo = buildTopology(events)
    expect(presentNodes(topo).length).toBe(5)
    // full mesh: 5 choose 2
    expect(activeLinks(topo).length).toBe(10)
    // seq is strictly increasing and times never go backwards
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.seq).toBeGreaterThan(events[i - 1]?.seq ?? 0)
      expect(events[i]?.event.at).toBeGreaterThanOrEqual(events[i - 1]?.event.at ?? 0)
    }
  })

  test('star topology connects everyone to the host only', () => {
    const engine = new SimEngine({ seed: 8, peers: 4, topology: 'star' })
    engine.step(10_000)
    const host = engine.host()
    expect(host).not.toBeNull()
    const links = activeLinks(buildTopology(engine.events()))
    expect(links.length).toBe(3)
    expect(links.every((l) => l.a === host || l.b === host)).toBe(true)
    expect(engine.peers().filter((p) => p.isHost).length).toBe(1)
  })

  test('star host handoff when the host is killed', () => {
    const engine = new SimEngine({ seed: 8, peers: 4, topology: 'star', chaos: 0 })
    engine.step(6000)
    const oldHost = engine.host() as string
    engine.injectFault({ type: 'kill', peer: oldHost })
    engine.step(6000)
    const newHost = engine.host()
    expect(newHost).not.toBe(oldHost)
    const links = activeLinks(buildTopology(engine.events()))
    expect(links.length).toBe(2)
    expect(links.every((l) => l.a === newHost || l.b === newHost)).toBe(true)
  })

  test('relayFirst migrates from relay to another path', () => {
    const events = generateEvents({ seed: 11, peers: 3, relayFirst: true }, 10_000)
    const paths = events
      .filter((e) => e.event.type === 'path')
      .map((e) => (e.event as { path: string }).path)
    expect(paths[0]).toBe('relay')
    expect(paths.some((p) => p !== 'relay')).toBe(true)
  })

  test('kill fault removes the peer; clearing revives it', () => {
    const engine = new SimEngine({ seed: 21, peers: 3 })
    engine.step(5000)
    const victim = engine.peers()[1]?.pubkey as string
    const f = engine.injectFault({ type: 'kill', peer: victim })
    engine.step(3000)
    let topo = buildTopology(engine.events())
    expect(topo.nodes[victim]?.present).toBe(false)
    expect(engine.peers().map((p) => p.pubkey)).not.toContain(victim)
    engine.clearFault(f.id)
    engine.step(4000)
    topo = buildTopology(engine.events())
    expect(topo.nodes[victim]?.present).toBe(true)
    expect(activeLinks(topo).length).toBe(3)
  })

  test('partition puts cross-group links away, then disconnected; heal reconnects', () => {
    const engine = new SimEngine({ seed: 4, peers: 4, chaos: 0 })
    engine.step(5000)
    const ids = engine.peers().map((p) => p.pubkey)
    const [p0, p1, p2, p3] = ids as [string, string, string, string]
    const f = engine.injectFault({
      type: 'partition',
      groups: [
        [p0, p1],
        [p2, p3],
      ],
    })
    engine.step(100)
    let topo = buildTopology(engine.events())
    expect(topo.links[linkKey(p0, p2)]?.state).toBe('away')
    expect(topo.links[linkKey(p0, p1)]?.state).toBe('connected')
    engine.step(4000)
    topo = buildTopology(engine.events())
    expect(topo.links[linkKey(p0, p2)]?.state).toBe('disconnected')
    engine.clearFault(f.id)
    engine.step(3000)
    topo = buildTopology(engine.events())
    expect(topo.links[linkKey(p0, p2)]?.state).toBe('connected')
    expect(engine.faults()).toEqual([])
  })

  test('latency fault raises reported RTT', () => {
    const engine = new SimEngine({ seed: 9, peers: 2, chaos: 0 })
    engine.step(5000)
    const rtts = (from: number) =>
      engine
        .events()
        .filter((e) => e.event.type === 'rtt' && e.event.at > from)
        .map((e) => (e.event as { ms: number }).ms)
    const before = Math.max(...rtts(0))
    const t = engine.now
    engine.injectFault({ type: 'latency', ms: 500 })
    engine.step(3000)
    expect(Math.min(...rtts(t))).toBeGreaterThan(before)
  })

  test('connectionInfo exposes channels and candidate pairs', () => {
    const engine = new SimEngine({ seed: 2, peers: 2 })
    engine.step(5000)
    const [a, b] = engine.peers().map((p) => p.pubkey) as [string, string]
    const info = engine.connectionInfo(a, b)
    expect(info?.state).toBe('connected')
    expect(info?.channels.map((c) => c.label)).toContain('__beamhop/telemetry')
    expect(info?.candidatePairs.filter((c) => c.nominated).length).toBe(1)
    expect(engine.connectionInfo(a, 'f'.repeat(64))).toBeNull()
  })

  test('addPeer spawns a joining peer', () => {
    const engine = new SimEngine({ seed: 6, peers: 2 })
    engine.step(3000)
    const id = engine.addPeer()
    engine.step(3000)
    const topo = replayAt(engine.events(), engine.now).topology
    expect(topo.nodes[id]?.present).toBe(true)
    expect(activeLinks(topo).length).toBe(3)
  })
})

describe('SimulatedRoom adapter', () => {
  test('subscribe, warmup, admission policy and manual advance', async () => {
    const room = new SimulatedRoom({
      seed: 1,
      peers: 3,
      warmupMs: 4000,
      realtime: false,
      admission: 'nostr',
    })
    expect(room.history().length).toBeGreaterThan(0)
    const seen: number[] = []
    const off = room.subscribe((e) => seen.push(e.seq))
    await room.join()
    room.advance(1000)
    off()
    room.advance(1000)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBeLessThan(room.history().at(-1)?.seq ?? 0)
    const anon = await room.setIdentity({
      kind: 'anonymous',
      pubkey: 'e'.repeat(64),
      label: 'anon',
      attestation: { type: 'anonymous' },
    })
    expect(anon.admitted).toBe(false)
    const nostr = await room.setIdentity({
      kind: 'nostr',
      pubkey: 'e'.repeat(64),
      label: 'n',
      attestation: { type: 'nostr', pubkey: 'd'.repeat(64), sig: '' },
    })
    expect(nostr.admitted).toBe(true)
    expect(room.peers().some((p) => p.isSelf)).toBe(true)
    expect(room.spawn(2).length).toBe(2)
    await room.leave()
  })
})
