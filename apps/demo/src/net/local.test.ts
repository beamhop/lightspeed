import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ICE_SERVERS, DEFAULT_RELAYS, type DemoConfig } from '../config'
import type { ChatMessage, CursorUpdate, DemoRoom, FileProgress } from '../p2p'
import { type BusLike, joinLocalRoom, type LocalMessage, localChannelName } from './local'

let seq = 0
const rooms: DemoRoom[] = []

function cfg(name: string, roomId: string, password = ''): DemoConfig {
  return {
    roomId,
    password,
    name,
    local: true,
    transport: 'p2p',
    identity: 'anonymous',
    relays: DEFAULT_RELAYS,
    iceServers: DEFAULT_ICE_SERVERS,
  }
}

function join(name: string, roomId: string, extra: Parameters<typeof joinLocalRoom>[1] = {}) {
  const r = joinLocalRoom(cfg(name, roomId), { heartbeatMs: 25, ...extra })
  rooms.push(r)
  return r
}

function freshRoom() {
  return `test-${process.pid}-${++seq}`
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

afterEach(async () => {
  await Promise.all(rooms.splice(0).map((r) => r.leave()))
})

describe('local (BroadcastChannel) fallback', () => {
  test('peers discover each other with names', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2 && b.peers().length === 2)
    expect(a.mode).toBe('local')
    expect(a.peers().map((p) => p.name)).toEqual(['alice', 'bob'])
    expect(b.peers().map((p) => p.name)).toEqual(['bob', 'alice'])
    expect(a.peers()[0]?.self).toBe(true)
    expect(a.peers()[1]?.path).toBe('local')
  })

  test('a late joiner learns about everyone already present', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2)
    const c = join('carol', id)
    await until(() => c.peers().length === 3 && a.peers().length === 3 && b.peers().length === 3)
    expect(
      c
        .peers()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['alice', 'bob', 'carol'])
  })

  test('rooms with different ids or passwords are isolated', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const other = joinLocalRoom(cfg('eve', id, 'secret'), { heartbeatMs: 25 })
    rooms.push(other)
    await new Promise((r) => setTimeout(r, 120))
    expect(a.peers()).toHaveLength(1)
    expect(other.peers()).toHaveLength(1)
    expect(localChannelName(id, 'secret')).not.toBe(localChannelName(id))
  })

  test('chat is delivered to peers and echoed to the sender', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2 && b.peers().length === 2)
    const atA: ChatMessage[] = []
    const atB: ChatMessage[] = []
    a.onChat((m) => atA.push(m))
    b.onChat((m) => atB.push(m))
    a.sendChat('hello bob')
    b.sendChat('hi alice')
    await until(() => atA.length === 2 && atB.length === 2)
    expect(atB.find((m) => m.text === 'hello bob')?.name).toBe('alice')
    expect(atA.find((m) => m.text === 'hi alice')?.from).toBe(b.self.id)
    expect(atA.find((m) => m.text === 'hello bob')?.from).toBe(a.self.id)
  })

  test('a late joiner receives the chat history, ordered and deduped', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2 && b.peers().length === 2)
    a.sendChat('one')
    b.sendChat('two')
    await until(() => a.messages().length === 2 && b.messages().length === 2)
    const c = join('carol', id)
    // Both alice and bob send their history; carol keeps one copy of each message.
    await until(() => c.messages().length === 2)
    await new Promise((r) => setTimeout(r, 60))
    expect(c.messages().map((m) => [m.text, m.name])).toEqual([
      ['one', 'alice'],
      ['two', 'bob'],
    ])
  })

  test('peers learn who is in a call', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2 && b.peers().length === 2)
    const seen: string[][] = []
    b.onCallPeers((ids) => seen.push(ids))
    await a.startCall({} as MediaStream)
    await until(() => b.callPeers().includes(a.self.id))
    expect(seen.at(-1)).toEqual([a.self.id])
    // A late joiner hears about the running call too.
    const c = join('carol', id)
    await until(() => c.callPeers().includes(a.self.id))
    a.stopCall()
    await until(() => b.callPeers().length === 0 && c.callPeers().length === 0)
  })

  test('cursor positions arrive', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => b.peers().length === 2)
    const got: CursorUpdate[] = []
    b.onCursor((c) => got.push(c))
    a.sendCursor(0.25, 0.75)
    await until(() => got.length > 0)
    expect(got[0]).toEqual({ from: a.self.id, x: 0.25, y: 0.75 })
  })

  test('files are chunked, reassembled and reported per peer', async () => {
    const id = freshRoom()
    const a = join('alice', id, { chunkSize: 1024 })
    const b = join('bob', id)
    const c = join('carol', id)
    await until(() => a.peers().length === 3 && b.peers().length === 3 && c.peers().length === 3)

    const bytes = new Uint8Array(10_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const received: FileProgress[] = []
    b.onFile((p) => p.done && received.push(p))
    c.onFile((p) => p.done && received.push(p))
    const outgoing: FileProgress[] = []

    await a.sendFile(new Blob([bytes], { type: 'application/x-test' }), 'data.bin', (p) =>
      outgoing.push(p),
    )
    await until(() => received.length === 2)

    for (const r of received) {
      expect(r.name).toBe('data.bin')
      expect(r.mime).toBe('application/x-test')
      expect(r.total).toBe(10_000)
      expect(r.error).toBeUndefined()
      const got = new Uint8Array(await (r.blob as Blob).arrayBuffer())
      expect(got).toEqual(bytes)
    }
    const peersDone = new Set(outgoing.filter((p) => p.done).map((p) => p.peer))
    expect(peersDone).toEqual(new Set([b.self.id, c.self.id]))
    // Progress is monotonic per peer and includes intermediate steps.
    const forB = outgoing.filter((p) => p.peer === b.self.id).map((p) => p.sent)
    expect(forB.length).toBeGreaterThan(2)
    expect([...forB].sort((x, y) => x - y)).toEqual(forB)
  })

  test('empty files complete', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2)
    const done: FileProgress[] = []
    b.onFile((p) => p.done && done.push(p))
    await a.sendFile(new Blob([]), 'empty.txt')
    await until(() => done.length === 1)
    expect(done[0]?.blob?.size).toBe(0)
  })

  test('leave removes the peer from the others', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2)
    await b.leave()
    await until(() => a.peers().length === 1)
    expect(a.peers()[0]?.name).toBe('alice')
  })

  test('a silent peer times out', async () => {
    const id = freshRoom()
    const a = join('alice', id, { timeoutMs: 120 })
    // A raw channel that says hello once and then goes quiet, like a crashed tab.
    const ghost = new BroadcastChannel(localChannelName(id))
    const hello: LocalMessage = { t: 'hello', from: 'f'.repeat(64), name: 'ghost', reply: true }
    ghost.postMessage(hello)
    await until(() => a.peers().length === 2)
    await until(() => a.peers().length === 1, 2000)
    ghost.close()
  })

  test('telemetry reports RTT and bytes per channel', async () => {
    const id = freshRoom()
    const a = join('alice', id)
    const b = join('bob', id)
    await until(() => a.peers().length === 2)
    a.sendChat('x'.repeat(100))
    await until(() => {
      const t = a.telemetry().peers[b.self.id]
      return !!t && t.rttMs !== undefined && (t.bytes.chat?.sent ?? 0) > 100
    })
    const t = a.telemetry()
    expect(t.relays[0]?.state).toBe('open')
    expect(t.peers[b.self.id]?.path).toBe('local')
    expect(t.signaling.some((e) => e.kind === 'hello')).toBe(true)
    expect(b.telemetry().peers[a.self.id]?.bytes.chat?.received).toBeGreaterThan(100)
  })

  test('works with an injected bus', async () => {
    const buses = new Set<BusLike>()
    const factory = (): BusLike => {
      const bus: BusLike = {
        onmessage: null,
        postMessage(message) {
          for (const other of buses) {
            if (other !== bus)
              queueMicrotask(() => other.onmessage?.({ data: message } as MessageEvent))
          }
        },
        close() {
          buses.delete(bus)
        },
      }
      buses.add(bus)
      return bus
    }
    const id = freshRoom()
    const a = join('alice', id, { channelFactory: factory })
    const b = join('bob', id, { channelFactory: factory })
    await until(() => a.peers().length === 2 && b.peers().length === 2)
  })
})
