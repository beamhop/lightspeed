import { describe, expect, test } from 'bun:test'
import { createMockApi } from './mock/server'
import { backoffDelay, createStatsStream, normalizeStats, statsUrl, type WsLike } from './stats'

class FakeSocket implements WsLike {
  readyState = 0
  onopen: WsLike['onopen'] = null
  onmessage: WsLike['onmessage'] = null
  onclose: WsLike['onclose'] = null
  onerror: WsLike['onerror'] = null
  closed = false
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  push(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
  close() {
    this.closed = true
    this.drop()
  }
}

function harness(historySize?: number) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const stream = createStatsStream({
    url: 'ws://x/api/admin/stats',
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    random: () => 0.5,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
    ...(historySize ? { historySize } : {}),
  })
  return { stream, sockets, timers }
}

const frame = (eps: number, ts = Date.now()) => ({
  type: 'stats',
  ts,
  nostr: { events: 1, subscriptions: 2, clients: 3, eventsPerSec: eps },
  turn: { allocations: 4, bytesIn: 0, bytesOut: 0, bps: 8e6 },
})

describe('stats stream', () => {
  test('feeds signals from frames and ignores junk', () => {
    const { stream, sockets } = harness()
    stream.start()
    expect(stream.status.value).toBe('connecting')
    sockets[0]?.open()
    expect(stream.status.value).toBe('open')
    sockets[0]?.push(frame(12.5, 1000))
    sockets[0]?.push('not json')
    sockets[0]?.push({ type: 'other' })
    expect(stream.latest.value?.nostr.eventsPerSec).toBe(12.5)
    expect(stream.history.value).toHaveLength(1)
    expect(stream.series.value[0]).toEqual([1])
    expect(stream.series.value[2]).toEqual([8])
  })

  test('history is a bounded ring', () => {
    const { stream, sockets } = harness(3)
    stream.start()
    sockets[0]?.open()
    for (let i = 0; i < 5; i++) sockets[0]?.push(frame(i, i))
    expect(stream.history.value.map((m) => m.nostr.eventsPerSec)).toEqual([2, 3, 4])
  })

  test('reconnects with growing backoff, resets after open', () => {
    const { stream, sockets, timers } = harness()
    stream.start()
    sockets[0]?.drop()
    expect(stream.status.value).toBe('reconnecting')
    expect(stream.attempts.value).toBe(1)
    expect(timers[0]?.ms).toBe(500)
    timers[0]?.fn()
    expect(sockets).toHaveLength(2)
    sockets[1]?.drop()
    expect(timers[1]?.ms).toBe(1000)
    timers[1]?.fn()
    sockets[2]?.open()
    expect(stream.attempts.value).toBe(0)
    expect(stream.status.value).toBe('open')
  })

  test('stop closes and does not reconnect', () => {
    const { stream, sockets, timers } = harness()
    stream.start()
    sockets[0]?.open()
    stream.stop()
    expect(sockets[0]?.closed).toBe(true)
    expect(stream.status.value).toBe('closed')
    expect(timers).toHaveLength(0)
  })

  test('backoff caps and jitters', () => {
    expect(backoffDelay(1, 500, 15000, () => 0.5)).toBe(500)
    expect(backoffDelay(4, 500, 15000, () => 0.5)).toBe(4000)
    expect(backoffDelay(20, 500, 15000, () => 1)).toBe(15000)
    expect(backoffDelay(3, 500, 15000, () => 0)).toBe(1600)
  })

  test('normalizeStats tolerates partial frames', () => {
    const m = normalizeStats({ type: 'stats', nostr: { clients: 5 } })
    expect(m?.nostr.clients).toBe(5)
    expect(m?.turn.bps).toBe(0)
    expect(normalizeStats({ type: 'x' })).toBeNull()
    expect(normalizeStats(null)).toBeNull()
  })

  test('statsUrl picks ws/wss', () => {
    expect(statsUrl({ protocol: 'https:', host: 'r.example' })).toBe(
      'wss://r.example/api/admin/stats',
    )
    expect(statsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/admin/stats',
    )
  })

  test('works against the mock fake WebSocket', async () => {
    const mock = createMockApi({ signedIn: true, tickMs: 10 })
    const stream = createStatsStream({ url: 'ws://mock', createSocket: mock.createSocket })
    stream.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.status.value).toBe('open')
    expect(stream.history.value.length).toBeGreaterThan(1)
    expect(stream.latest.value?.turn.allocations).toBe(mock.db.allocations.length)
    stream.stop()
  })

  test('mock socket closes when signed out, stream keeps retrying', async () => {
    const mock = createMockApi({ tickMs: 10 })
    const stream = createStatsStream({
      url: 'ws://mock',
      createSocket: mock.createSocket,
      minBackoffMs: 5,
      maxBackoffMs: 10,
    })
    stream.start()
    await new Promise((r) => setTimeout(r, 30))
    expect(stream.status.value).toBe('reconnecting')
    mock.db.loggedIn = true
    await new Promise((r) => setTimeout(r, 60))
    expect(stream.status.value).toBe('open')
    stream.stop()
  })
})
