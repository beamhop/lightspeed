import { afterEach, describe, expect, test } from 'bun:test'
import {
  anonymous,
  createMemoryHub,
  createSignalingHub,
  memorySignaling,
  memoryTransport,
} from '@beamhop/p2p'
import { DEFAULT_ICE_SERVERS, DEFAULT_RELAYS, type DemoConfig } from '../config'
import type { ChatMessage, CursorUpdate, DemoRoom, FileProgress } from '../p2p'
import { joinBeamhopRoom } from './beamhop'

const rooms: DemoRoom[] = []

function cfg(name: string, roomId: string): DemoConfig {
  return {
    roomId,
    password: '',
    name,
    local: false,
    identity: 'anonymous',
    relays: DEFAULT_RELAYS,
    iceServers: DEFAULT_ICE_SERVERS,
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function pair() {
  const sig = createSignalingHub({ latencyMs: 2 })
  const net = createMemoryHub({ seed: 7, defaults: { latencyMs: 2 } })
  const join = async (name: string) => {
    const r = await joinBeamhopRoom(cfg(name, 'demo-test'), {
      signaling: memorySignaling(sig),
      transports: [memoryTransport(net)],
      identity: anonymous(),
      tickMs: 50,
    })
    rooms.push(r)
    return r
  }
  const a = await join('ada')
  const b = await join('bob')
  await until(() => a.peers().length === 2 && b.peers().length === 2)
  return { a, b }
}

afterEach(async () => {
  await Promise.all(rooms.splice(0).map((r) => r.leave()))
})

describe('beamhop DemoRoom over the real library (memory transports)', () => {
  test('presence, chat, cursor and telemetry', async () => {
    const { a, b } = await pair()
    expect(a.mode).toBe('beamhop')
    const bobSeenByA = a.peers().find((p) => !p.self)
    expect(bobSeenByA?.id).toBe(b.self.id)
    expect(bobSeenByA?.name).toBe('bob')
    expect(bobSeenByA?.path).toBe('memory')
    expect(bobSeenByA?.state).toBe('connected')

    const got: ChatMessage[] = []
    b.onChat((m) => got.push(m))
    a.sendChat('hello bob')
    await until(() => got.length === 1)
    expect(got[0]).toMatchObject({ from: a.self.id, name: 'ada', text: 'hello bob' })

    const cursors: CursorUpdate[] = []
    b.onCursor((c) => cursors.push(c))
    // Unreliable: send a few, at least one arrives on a lossless hub.
    for (let i = 0; i < 3; i++) a.sendCursor(0.25, 0.75)
    await until(() => cursors.length > 0)
    expect(cursors[0]).toEqual({ from: a.self.id, x: 0.25, y: 0.75 })

    await until(() => a.telemetry().peers[b.self.id]?.path === 'memory')
    expect(a.telemetry().signaling.length).toBeGreaterThan(0)
  })

  test('file transfer with progress on both sides', async () => {
    const { a, b } = await pair()
    const size = 100_000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = i % 251
    const blob = new Blob([data], { type: 'application/x-test' })

    const incoming: FileProgress[] = []
    b.onFile((p) => incoming.push(p))
    const outgoing: FileProgress[] = []
    await a.sendFile(blob, 'test.bin', (p) => outgoing.push(p))

    expect(outgoing.length).toBeGreaterThan(2)
    expect(outgoing.at(-1)).toMatchObject({ peer: b.self.id, sent: size, total: size, done: true })
    expect(outgoing.some((p) => p.sent > 0 && p.sent < size)).toBe(true)

    await until(() => incoming.some((p) => p.done))
    const done = incoming.find((p) => p.done)
    expect(done).toMatchObject({
      peer: a.self.id,
      direction: 'in',
      name: 'test.bin',
      mime: 'application/x-test',
      sent: size,
      total: size,
    })
    expect(done?.error).toBeUndefined()
    expect(incoming.some((p) => !p.done && p.sent > 0 && p.sent < size)).toBe(true)
    const received = done?.blob
    if (!received) throw new Error('no blob on the completed transfer')
    const got = new Uint8Array(await received.arrayBuffer())
    expect(got).toEqual(data)
  })

  test('a late joiner receives the chat history', async () => {
    const sig = createSignalingHub({ latencyMs: 2 })
    const net = createMemoryHub({ seed: 11, defaults: { latencyMs: 2 } })
    const join = async (name: string) => {
      const r = await joinBeamhopRoom(cfg(name, 'demo-history'), {
        signaling: memorySignaling(sig),
        transports: [memoryTransport(net)],
        identity: anonymous(),
        tickMs: 50,
      })
      rooms.push(r)
      return r
    }
    const a = await join('ada')
    const b = await join('bob')
    await until(() => a.peers().length === 2 && b.peers().length === 2)
    a.sendChat('first')
    await until(() => b.messages().length === 1)
    b.sendChat('second')
    await until(() => a.messages().length === 2)
    const c = await join('cy')
    await until(() => c.messages().length === 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(c.messages().map((m) => [m.text, m.name, m.from])).toEqual([
      ['first', 'ada', a.self.id],
      ['second', 'bob', b.self.id],
    ])
  })

  test('starting a call is announced to the other peers', async () => {
    const { a, b } = await pair()
    const seen: string[][] = []
    b.onCallPeers((ids) => seen.push(ids))
    await a.startCall({} as MediaStream)
    await until(() => b.callPeers().includes(a.self.id))
    expect(seen.at(-1)).toEqual([a.self.id])
    a.stopCall()
    await until(() => b.callPeers().length === 0)
  })

  test('leave is reported to the other side', async () => {
    const { a, b } = await pair()
    await b.leave()
    await until(() => a.peers().length === 1)
  })
})
