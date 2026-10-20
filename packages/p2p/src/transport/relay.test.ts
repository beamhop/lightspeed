import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { schnorrVerify } from '../crypto/nostr'
import { anonymous } from '../identity/anonymous'
import { action, any, defineProtocol } from '../room/protocol'
import { createRoom } from '../room/room'
import { createSignalingHub, memorySignaling } from '../signaling/memory'
import type { Hex, SignalPipe, TransportSignal } from '../types'
import { bytesToHex, randomBytes } from '../util/bytes'
import { Listeners } from '../util/emitter'
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  type RelayControl,
  relayHelloHash,
} from '../wire'
import { relayTransport } from './relay'

/** Minimal data-path relay implementing the wire.ts protocol, like @beamhop/relay's /a/<appId>/data. */
function startRelay() {
  type Data = { appId: string; challenge: Hex; pubkey: Hex | null }
  const peers = new Map<Hex, ServerWebSocket<Data>>()
  const stats = { bytes: 0, frames: 0, seen: [] as Uint8Array[] }
  const server = Bun.serve<Data>({
    port: 0,
    fetch(req, srv) {
      const m = /^\/a\/([^/]+)\/data$/.exec(new URL(req.url).pathname)
      if (!m) return new Response('not found', { status: 404 })
      if (
        srv.upgrade(req, {
          data: { appId: m[1] as string, challenge: bytesToHex(randomBytes(32)), pubkey: null },
        })
      )
        return
      return new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.send(
          JSON.stringify({
            type: 'challenge',
            challenge: ws.data.challenge,
          } satisfies RelayControl),
        )
      },
      message(ws, msg) {
        if (typeof msg === 'string') {
          const c = JSON.parse(msg) as RelayControl
          if (c.type === 'hello') {
            if (!schnorrVerify(c.sig, relayHelloHash(ws.data.appId, ws.data.challenge), c.pubkey)) {
              ws.send(JSON.stringify({ type: 'error', code: 'auth', message: 'bad signature' }))
              ws.close()
              return
            }
            ws.data.pubkey = c.pubkey
            peers.set(c.pubkey, ws)
            ws.send(JSON.stringify({ type: 'ready' } satisfies RelayControl))
          }
          return
        }
        if (!ws.data.pubkey) return
        const buf = new Uint8Array(msg)
        const { pubkey: dest, body } = decodeRelayEnvelope(buf)
        stats.bytes += body.length
        stats.frames++
        stats.seen.push(body.slice())
        const to = peers.get(dest)
        if (!to) {
          ws.send(JSON.stringify({ type: 'peer-offline', pubkey: dest } satisfies RelayControl))
          return
        }
        to.send(encodeRelayEnvelope(ws.data.pubkey, body))
      },
      close(ws) {
        if (ws.data.pubkey && peers.get(ws.data.pubkey) === ws) peers.delete(ws.data.pubkey)
      },
    },
  })
  return { server, peers, stats, url: `ws://localhost:${server.port}/a/demo/data` }
}

/** A loopback signal pipe pair. */
function pipePair(): [SignalPipe, SignalPipe] {
  const la = new Listeners<[TransportSignal]>()
  const lb = new Listeners<[TransportSignal]>()
  return [
    { send: (m) => queueMicrotask(() => lb.emit(m)), onMessage: (cb) => la.add(cb) },
    { send: (m) => queueMicrotask(() => la.emit(m)), onMessage: (cb) => lb.add(cb) },
  ]
}

const until = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(5)
  }
}

let relay: ReturnType<typeof startRelay>
beforeAll(() => {
  relay = startRelay()
})
afterAll(() => {
  relay.server.stop(true)
})

describe('relayTransport', () => {
  test('hello handshake, encrypted channels both ways, relay sees only ciphertext', async () => {
    const a = await anonymous().load()
    const b = await anonymous().load()
    const ta = relayTransport({ url: relay.url })
    const tb = relayTransport({ url: relay.url })
    const [pa, pb] = pipePair()
    const [ca, cb] = await Promise.all([
      ta.connect(b.pubkey, { initiator: true, pipe: pa, local: a }),
      tb.connect(a.pubkey, { initiator: false, pipe: pb, local: b }),
    ])
    expect(ca.path).toBe('relay')
    expect(cb.state).toBe('connected')
    const chans: string[] = []
    const gotB: string[] = []
    cb.onChannel((ch) => {
      chans.push(ch.label)
      ch.onMessage((d) => {
        gotB.push(new TextDecoder().decode(d))
        ch.send(new TextEncoder().encode(`echo ${new TextDecoder().decode(d)}`))
      })
    })
    const ch = ca.openChannel('bh/r', { mode: 'reliable' })
    const gotA: string[] = []
    ch.onMessage((d) => gotA.push(new TextDecoder().decode(d)))
    await until(() => ch.readyState === 'open')
    const secret = 'top secret payload'
    for (let i = 0; i < 20; i++) ch.send(new TextEncoder().encode(`${secret} ${i}`))
    await until(() => gotA.length === 20)
    expect(chans).toEqual(['bh/r'])
    expect(gotB[19]).toBe(`${secret} 19`)
    expect(gotA[0]).toBe(`echo ${secret} 0`)
    // The relay never saw plaintext.
    const needle = new TextEncoder().encode(secret)
    const contains = (hay: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
        return true
      }
      return false
    }
    expect(relay.stats.seen.some(contains)).toBe(false)
    const st = await ca.stats()
    expect(st.bytesSent).toBeGreaterThan(0)
    ca.close()
    await until(() => cb.state === 'closed')
    ta.close()
    tb.close()
  })

  test('rejects a forged hello', async () => {
    const a = await anonymous().load()
    const evil = { ...a, sign: async () => new Uint8Array(64) }
    const t = relayTransport({ url: relay.url })
    const [p] = pipePair()
    await expect(
      t.connect('ab'.repeat(32), { initiator: true, pipe: p, local: evil }),
    ).rejects.toThrow()
    t.close()
  })

  test('peer-offline fails the connect', async () => {
    const a = await anonymous().load()
    const t = relayTransport({ url: relay.url })
    const [pa, pb] = pipePair()
    // Pretend the responder answered relay-ready without being on the relay.
    pb.onMessage((m) => {
      if (m.type === 'relay-connect') pb.send({ type: 'relay-ready' })
    })
    const ghost = await anonymous().load()
    await expect(t.connect(ghost.pubkey, { initiator: true, pipe: pa, local: a })).rejects.toThrow(
      'offline',
    )
    t.close()
  })

  test('Bun server peer joins a room over the relay only (no WebRTC)', async () => {
    const hub = createSignalingHub({ latencyMs: 2 })
    const proto = defineProtocol({ chat: action(any<string>()) })
    const mk = () =>
      createRoom({
        appId: 'demo',
        roomId: 'relay-room',
        identity: anonymous(),
        signaling: memorySignaling(hub),
        transports: [relayTransport({ url: relay.url })],
        protocol: proto,
      })
    const server = await mk()
    const client = await mk()
    await until(() => server.peers.length === 1 && client.peers.length === 1)
    expect(client.peers[0]?.path).toBe('relay')
    const got: string[] = []
    server.action('chat').onMessage((m) => got.push(m))
    const big = 'x'.repeat(100_000) // chunked over the relay path
    await client.action('chat').send('hello server')
    await client.action('chat').send(big)
    await until(() => got.length === 2)
    expect(got[0]).toBe('hello server')
    expect(got[1]?.length).toBe(100_000)
    server.state.map<number>('counter').set('n', 1)
    await until(() => client.state.map('counter').get('n') === 1)

    // The relay drops the client's socket: the session goes away and resumes without leave/join.
    const leaves: string[] = []
    const states: string[] = []
    server.onPeerLeave((p) => leaves.push(p.pubkey))
    client.onPeerLeave((p) => leaves.push(p.pubkey))
    client.onPeerUpdate((p) => states.push(p.state))
    relay.peers.get(client.self.pubkey)?.close()
    await until(() => states.includes('away'))
    client
      .action('chat')
      .send('after drop')
      .catch(() => {})
    await until(() => got.includes('after drop'), 10_000)
    await until(
      () => server.peers[0]?.state === 'connected' && client.peers[0]?.state === 'connected',
    )
    expect(leaves).toEqual([])
    await client.leave()
    await server.leave()
  })
})
