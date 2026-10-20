import { describe, expect, test } from 'bun:test'
import type { TelemetryEvent } from '@beamhop/p2p'
import type { StudioEvent } from '../room-adapter'
import { connectionHistory, connectionPairs } from './connection'
import { eventsUntil, linkKey, sortEvents, timeRange, upperBound } from './events'
import { actionCounts, decodePayload, filterMessages, safeStringify } from './inspector'
import { forceLayout } from './layout'
import { buildTracks, histogram, replayAt } from './timeline'
import { activeLinks, buildTopology, linkBytes, pathCounts, presentNodes } from './topology'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

let seq = 0
const ev = (source: string, event: TelemetryEvent): StudioEvent => ({ seq: ++seq, source, event })

/** A small hand-written log: A and B connect directly, C joins via TURN, B leaves. */
function scenario(): StudioEvent[] {
  seq = 0
  return [
    ev(A, { type: 'signal', at: 0, direction: 'out', kind: 'announce' }),
    ev(B, { type: 'signal', at: 10, direction: 'in', kind: 'announce', peer: A }),
    ev(A, { type: 'connection', at: 20, peer: B, state: 'connecting' }),
    ev(A, { type: 'signal', at: 20, direction: 'out', kind: 'offer', peer: B }),
    ev(B, { type: 'connection', at: 40, peer: A, state: 'connecting' }),
    ev(A, { type: 'connection', at: 100, peer: B, state: 'connected', path: 'direct' }),
    ev(A, { type: 'path', at: 100, peer: B, path: 'direct', candidatePair: 'host ↔ host' }),
    ev(A, { type: 'peer', at: 100, peer: B, event: 'join' }),
    ev(B, { type: 'connection', at: 105, peer: A, state: 'connected', path: 'direct' }),
    ev(A, { type: 'rtt', at: 1000, peer: B, ms: 42 }),
    ev(A, { type: 'bytes', at: 1000, peer: B, channel: 'reliable', sent: 100, received: 50 }),
    ev(B, { type: 'bytes', at: 1000, peer: A, channel: 'reliable', sent: 60, received: 100 }),
    ev(A, {
      type: 'message',
      at: 1100,
      peer: B,
      direction: 'out',
      action: 'chat',
      size: 40,
      payload: { text: 'hello' },
    }),
    ev(B, {
      type: 'message',
      at: 1120,
      peer: A,
      direction: 'in',
      action: 'chat',
      size: 40,
      payload: { text: 'hello' },
    }),
    ev(B, {
      type: 'message',
      at: 1200,
      peer: A,
      direction: 'out',
      action: 'cursor',
      size: 24,
      payload: { x: 1, y: 2 },
    }),
    ev(C, { type: 'connection', at: 1500, peer: A, state: 'connected', path: 'turn' }),
    ev(A, { type: 'connection', at: 2000, peer: B, state: 'away' }),
    ev(A, { type: 'connection', at: 2600, peer: B, state: 'back', path: 'direct' }),
    ev(A, { type: 'path', at: 2700, peer: B, path: 'turn' }),
    ev(A, { type: 'peer', at: 3000, peer: B, event: 'leave' }),
  ]
}

describe('events helpers', () => {
  test('sortEvents orders by at then seq without mutating', () => {
    const log = scenario()
    const shuffled = [log[5], log[0], log[3], log[2]] as StudioEvent[]
    const sorted = sortEvents(shuffled)
    expect(sorted.map((e) => e.seq)).toEqual([1, 3, 4, 6])
    expect(shuffled[0]?.seq).toBe(6)
  })
  test('upperBound / eventsUntil / timeRange', () => {
    const log = scenario()
    expect(upperBound(log, 100)).toBe(8)
    expect(eventsUntil(log, -1)).toEqual([])
    expect(timeRange(log)).toEqual({ start: 0, end: 3000 })
    expect(timeRange([])).toBeNull()
    expect(linkKey(B, A)).toBe(linkKey(A, B))
  })
})

describe('topology reducer', () => {
  test('builds nodes and links with path, rtt and bytes', () => {
    const t = buildTopology(scenario().slice(0, 15))
    expect(Object.keys(t.nodes).sort()).toEqual([A, B])
    const link = t.links[linkKey(A, B)]
    expect(link?.state).toBe('connected')
    expect(link?.path).toBe('direct')
    expect(link?.rttMs).toBe(42)
    expect(link?.candidatePair).toBe('host ↔ host')
    // the larger side wins: A reports 150 bytes total, B 160
    expect(linkBytes(link as NonNullable<typeof link>)).toEqual({
      sent: 60,
      received: 100,
      total: 160,
    })
  })

  test('peer leave closes links and removes the node from the graph', () => {
    const t = buildTopology(scenario())
    expect(t.nodes[B]?.present).toBe(false)
    expect(t.links[linkKey(A, B)]?.state).toBe('closed')
    expect(
      presentNodes(t)
        .map((n) => n.id)
        .sort(),
    ).toEqual([A, C])
    expect(activeLinks(t).map((l) => l.path)).toEqual(['turn'])
    expect(pathCounts(t).turn).toBe(1)
  })

  test('away / back map onto link state', () => {
    const log = scenario()
    const away = buildTopology(log.filter((e) => e.event.at <= 2000))
    expect(away.links[linkKey(A, B)]?.state).toBe('away')
    const back = buildTopology(log.filter((e) => e.event.at <= 2600))
    expect(back.links[linkKey(A, B)]?.state).toBe('connected')
  })

  test('reducer returns the same object for no-op events', () => {
    const log = scenario()
    const t = buildTopology(log)
    const again = buildTopology([...log])
    expect(again).toEqual(t)
  })
})

describe('timeline replay', () => {
  test('replayAt(t) only folds events up to t', () => {
    const log = scenario()
    const at50 = replayAt(log, 50)
    expect(at50.eventCount).toBe(5)
    expect(at50.topology.links[linkKey(A, B)]?.state).toBe('connecting')
    expect(at50.signals).toEqual({ in: 1, out: 2 })
    const at1150 = replayAt(log, 1150)
    expect(at1150.messages).toEqual({ in: 1, out: 1, bytes: 80 })
    expect(at1150.topology.links[linkKey(A, B)]?.path).toBe('direct')
    const end = replayAt(log, Number.POSITIVE_INFINITY)
    expect(end.eventCount).toBe(log.length)
    expect(end.resumes).toBe(1)
    expect(end.topology.links[linkKey(A, B)]?.state).toBe('closed')
  })

  test('replay is order-independent and pure', () => {
    const log = scenario()
    const reversed = [...log].reverse()
    expect(replayAt(reversed, 1500)).toEqual(replayAt(log, 1500))
    // the input is not mutated
    expect(reversed[0]?.seq).toBe(log.length)
  })

  test('replaying t then t2 equals replaying t2 directly (scrubbing back and forth)', () => {
    const log = scenario()
    replayAt(log, 2600)
    const direct = replayAt(log, 1000)
    expect(replayAt(log, 1000)).toEqual(direct)
    expect(direct.topology.links[linkKey(A, B)]?.rttMs).toBe(42)
  })

  test('buildTracks assigns lanes and filters by peer and window', () => {
    const tracks = buildTracks(scenario())
    expect(tracks.signal.length).toBe(3)
    expect(tracks.message.map((i) => i.label)).toEqual(['→ chat', '← chat', '→ cursor'])
    expect(tracks.connection.some((i) => i.label === 'away' && i.tone === 'warning')).toBe(true)
    const onlyC = buildTracks(scenario(), { peer: C })
    expect(onlyC.connection.length).toBe(1)
    const window = buildTracks(scenario(), { from: 1000, to: 1200 })
    expect(window.message.length).toBe(3)
    expect(window.signal.length).toBe(0)
  })

  test('histogram buckets events', () => {
    const h = histogram(scenario(), 0, 3000, 3)
    expect(h.reduce((a, b) => a + b, 0)).toBe(20)
    // [0, 1000) holds the handshake; 1000 and later fall in the next buckets
    expect(h).toEqual([9, 7, 4])
  })
})

describe('inspector filters', () => {
  test('filter by peer, action, direction, text and time', () => {
    const log = scenario()
    expect(filterMessages(log).length).toBe(3)
    expect(filterMessages(log, { action: 'chat' }).length).toBe(2)
    expect(filterMessages(log, { direction: 'out' }).map((m) => m.event.action)).toEqual([
      'chat',
      'cursor',
    ])
    // peer matches either the reporting side or the remote side
    expect(filterMessages(log, { peer: A }).length).toBe(3)
    expect(filterMessages(log, { peer: C }).length).toBe(0)
    expect(filterMessages(log, { text: 'HELLO' }).length).toBe(2)
    expect(filterMessages(log, { until: 1110 }).length).toBe(1)
    expect(filterMessages(log, { action: 'chat', direction: 'in', peer: B }).length).toBe(1)
  })

  test('actionCounts', () => {
    expect(actionCounts(scenario())).toEqual([
      { action: 'chat', count: 2 },
      { action: 'cursor', count: 1 },
    ])
  })

  test('payload decoding handles bytes, bigint, cycles and undefined', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(safeStringify(cyc)).toContain('[Circular]')
    expect(safeStringify({ n: 10n })).toBe('{"n":"10n"}')
    expect(safeStringify(new Uint8Array([1, 255]))).toBe('{"$bytes":2,"hex":"01ff"}')
    expect(decodePayload(undefined)).toBe('(no payload captured)')
    expect(decodePayload({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
  })
})

describe('connection detail', () => {
  test('state machine history, paths, resumes and channels', () => {
    const h = connectionHistory(scenario(), A, B)
    expect(h.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'new->connecting',
      'connecting->connected',
      'connected->away',
      'away->connected',
      'connected->closed',
    ])
    expect(h.paths.map((p) => p.path)).toEqual(['direct', 'direct', 'direct', 'turn'])
    expect(h.resumes).toEqual([{ awayAt: 2000, backAt: 2600, gapMs: 600 }])
    expect(h.channels.reliable).toEqual({ sent: 100, received: 50, at: 1000 })
    expect(h.rtt).toEqual([{ at: 1000, ms: 42 }])
    expect(h.messages).toEqual({ in: 0, out: 1 })
    expect(h.current).toBe('closed')
  })
  test('until bounds the history', () => {
    const h = connectionHistory(scenario(), A, B, 2100)
    expect(h.current).toBe('away')
    expect(h.resumes).toEqual([{ awayAt: 2000 }])
  })
  test('connectionPairs lists reporting directions', () => {
    expect(connectionPairs(scenario())).toEqual([
      { source: A, peer: B },
      { source: B, peer: A },
      { source: C, peer: A },
    ])
  })
})

describe('force layout', () => {
  test('deterministic and inside the box', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5']
    const edges: [string, string][] = [
      ['n1', 'n2'],
      ['n2', 'n3'],
      ['n3', 'n4'],
      ['n4', 'n5'],
    ]
    const a = forceLayout(ids, edges, { width: 400, height: 300 })
    const b = forceLayout([...ids].reverse(), edges, { width: 400, height: 300 })
    expect(a).toEqual(b)
    for (const p of Object.values(a)) {
      expect(p.x).toBeGreaterThanOrEqual(40)
      expect(p.x).toBeLessThanOrEqual(360)
      expect(p.y).toBeGreaterThanOrEqual(40)
      expect(p.y).toBeLessThanOrEqual(260)
    }
    // connected nodes end up closer than the ends of the chain
    const d = (x: string, y: string) =>
      Math.hypot((a[x]?.x ?? 0) - (a[y]?.x ?? 0), (a[x]?.y ?? 0) - (a[y]?.y ?? 0))
    expect(d('n1', 'n2')).toBeLessThan(d('n1', 'n5'))
  })
  test('edge cases', () => {
    expect(forceLayout([], [], { width: 100, height: 100 })).toEqual({})
    expect(forceLayout(['x'], [], { width: 100, height: 80 })).toEqual({ x: { x: 50, y: 40 } })
  })
})
