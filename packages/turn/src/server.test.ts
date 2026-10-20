import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { turnPassword, turnUsername } from '@beamhop/p2p/wire'
import type { udp } from 'bun'
import { TurnClient, TurnError } from './client'
import { looksLikeStunStream } from './framing'
import { restCredentials } from './rest'
import {
  createTurnServer,
  type TurnServer,
  type TurnServerOptions,
  type UsageReport,
} from './server'
import {
  type Address,
  Attr,
  Class,
  decodeErrorCode,
  decodeStun,
  decodeUnknownAttributes,
  encodeStun,
  getAttr,
  Method,
  randomTransactionId,
  type StunMessage,
  str,
} from './stun'

const CERT = join(import.meta.dir, 'fixtures/test-cert.pem')
const KEY = join(import.meta.dir, 'fixtures/test-key.pem')
const USERS: Record<string, string> = { alice: 'secret', bob: 'hunter2' }

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function startServer(over: Partial<TurnServerOptions> = {}) {
  const server = createTurnServer({
    realm: 'test.realm',
    host: '127.0.0.1',
    listen: { udp: 0, tcp: 0, tls: { port: 0, cert: CERT, key: KEY } },
    relayPorts: [0, 0],
    relayHost6: '::1',
    credentials: (u) => (USERS[u] ? { password: USERS[u] as string } : null),
    timings: { sweepMs: 50 },
    ...over,
  })
  const ports = await server.start()
  cleanups.push(() => server.stop())
  return { server, ports }
}

async function client(
  port: number,
  transport: 'udp' | 'tcp' | 'tls' = 'udp',
  username = 'alice',
  password = USERS[username] ?? 'x',
  host = '127.0.0.1',
) {
  const c = await TurnClient.connect({ host, port, transport, username, password })
  cleanups.push(() => c.close())
  return c
}

/** UDP echo peer: sends every datagram back to where it came from. */
async function echoPeer(hostname = '127.0.0.1') {
  const received: { data: Uint8Array; from: Address }[] = []
  const sock: udp.Socket<'buffer'> = await Bun.udpSocket({
    hostname,
    socket: {
      data(s, data, port, address) {
        received.push({
          data: data.slice(),
          from: { family: address.includes(':') ? 6 : 4, address, port },
        })
        s.send(data, port, address)
      },
    },
  })
  cleanups.push(() => sock.close())
  const addr: Address = {
    family: hostname.includes(':') ? 6 : 4,
    address: hostname,
    port: sock.port,
  }
  return { sock, addr, received }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

async function expectTurnError(p: Promise<unknown>, code: number) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TurnError)
    expect((e as TurnError).code).toBe(code)
    return
  }
  throw new Error(`expected TURN error ${code}`)
}

async function ipv6Available(): Promise<boolean> {
  try {
    const s = await Bun.udpSocket({ hostname: '::1' })
    s.close()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- STUN binding

describe('binding', () => {
  for (const transport of ['udp', 'tcp', 'tls'] as const) {
    test(`binding over ${transport}`, async () => {
      const { ports } = await startServer()
      const c = await client(ports[transport] as number, transport)
      const mapped = await c.binding()
      expect(mapped.address).toBe('127.0.0.1')
      expect(mapped.port).toBeGreaterThan(0)
    })
  }

  test('unknown comprehension-required attribute answers 420', async () => {
    const { ports } = await startServer()
    const c = await client(ports.udp as number)
    const res = await c.transact(Method.Binding, [[0x7777, new Uint8Array(4)]])
    expect(res.cls).toBe(Class.Error)
    expect(decodeErrorCode(getAttr(res, Attr.ErrorCode))?.code).toBe(420)
    expect(decodeUnknownAttributes(getAttr(res, Attr.UnknownAttributes))).toEqual([0x7777])
  })
})

// ---------------------------------------------------------------- relaying

describe('relay over UDP, TCP and TLS', () => {
  for (const transport of ['udp', 'tcp', 'tls'] as const) {
    test(`${transport}: allocate, permission, Send indication and ChannelData round trip`, async () => {
      const { server, ports } = await startServer()
      const peer = await echoPeer()
      const c = await client(ports[transport] as number, transport)

      // First Allocate is challenged with 401 (realm + nonce), then succeeds.
      const challenge = await c.transact(Method.Allocate, [
        [Attr.RequestedTransport, new Uint8Array([17, 0, 0, 0])],
      ])
      expect(decodeErrorCode(getAttr(challenge, Attr.ErrorCode))?.code).toBe(401)
      expect(getAttr(challenge, Attr.Realm)).toBeDefined()
      expect(getAttr(challenge, Attr.Nonce)).toBeDefined()

      const [relayed] = await c.allocate()
      expect(relayed?.address).toBe('127.0.0.1')
      expect(c.lifetime).toBe(600)
      const list = server.allocations()
      expect(list).toHaveLength(1)
      expect(list[0]?.transport).toBe(transport)
      expect(list[0]?.username).toBe('alice')
      expect(list[0]?.relayed[0]?.port).toBe(relayed?.port as number)

      // Without a permission nothing is relayed.
      c.send(peer.addr, bytes('dropped'))
      await sleep(50)
      expect(peer.received).toHaveLength(0)

      await c.createPermission(peer.addr)
      const got1 = c.nextData()
      c.send(peer.addr, bytes('hello via send'))
      const r1 = await got1
      expect(text(r1.data)).toBe('hello via send')
      expect(r1.peer).toEqual(peer.addr)
      expect(r1.channel).toBeUndefined()
      // the peer saw the relayed transport address as the source
      expect(peer.received[0]?.from.port).toBe(relayed?.port as number)

      await c.channelBind(0x4001, peer.addr)
      for (const msg of ['a', 'odd-len', 'x'.repeat(1001)]) {
        const got = c.nextData()
        c.sendChannel(0x4001, bytes(msg))
        const r = await got
        expect(r.channel).toBe(0x4001)
        expect(text(r.data)).toBe(msg)
      }
      const info = server.allocations()[0]
      expect(info?.bytesOut).toBe(14 + 1 + 7 + 1001)
      expect(info?.bytesIn).toBe(14 + 1 + 7 + 1001)
      expect(info?.channels).toBe(1)
      expect(server.stats().bytesOut).toBe(14 + 1 + 7 + 1001)
    })
  }

  test('peer without permission cannot reach the client', async () => {
    const { ports } = await startServer()
    const peer = await echoPeer()
    const c = await client(ports.udp as number)
    const [relayed] = await c.allocate()
    let got = 0
    c.onData(() => got++)
    peer.sock.send(bytes('unsolicited'), relayed?.port as number, '127.0.0.1')
    await sleep(80)
    expect(got).toBe(0)
  })

  test('TCP connection close deletes the allocation', async () => {
    const { server, ports } = await startServer()
    const c = await client(ports.tcp as number, 'tcp')
    await c.allocate()
    expect(server.allocations()).toHaveLength(1)
    c.close()
    await sleep(100)
    expect(server.allocations()).toHaveLength(0)
  })

  test('allocations come from relayPorts', async () => {
    const lo = 40000 + Math.floor(Math.random() * 20000)
    const { server, ports } = await startServer({ relayPorts: [lo, lo + 9] })
    const peers = await Promise.all([1, 2, 3].map(() => client(ports.udp as number)))
    for (const p of peers) {
      const [r] = await p.allocate()
      expect(r?.port).toBeGreaterThanOrEqual(lo)
      expect(r?.port).toBeLessThanOrEqual(lo + 9)
    }
    expect(new Set(server.allocations().map((a) => a.relayed[0]?.port)).size).toBe(3)
  })

  test('IPv6 relayed address and dual allocation (ADDITIONAL-ADDRESS-FAMILY)', async () => {
    if (!(await ipv6Available())) return
    const { ports } = await startServer()
    const peer6 = await echoPeer('::1')
    const peer4 = await echoPeer()

    const c6 = await client(ports.udp as number)
    const r6 = await c6.allocate({ family: 6 })
    expect(r6).toHaveLength(1)
    expect(r6[0]?.family).toBe(6)
    expect(r6[0]?.address).toBe('::1')
    await c6.createPermission(peer6.addr)
    const got = c6.nextData()
    c6.send(peer6.addr, bytes('v6'))
    expect(text((await got).data)).toBe('v6')
    // IPv4 peer on an IPv6-only allocation: 443 Peer Address Family Mismatch
    await expectTurnError(c6.createPermission(peer4.addr), 443)

    const dual = await client(ports.udp as number)
    const both = await dual.allocate({ additionalFamily: 6 })
    expect(both.map((a) => a.family).sort()).toEqual([4, 6])
    await dual.channelBind(0x4002, peer4.addr)
    await dual.channelBind(0x4003, peer6.addr)
    const a = dual.nextData()
    dual.sendChannel(0x4002, bytes('four'))
    expect((await a).channel).toBe(0x4002)
    const b = dual.nextData()
    dual.sendChannel(0x4003, bytes('six'))
    const rb = await b
    expect(rb.channel).toBe(0x4003)
    expect(text(rb.data)).toBe('six')
  })

  test('REQUESTED-ADDRESS-FAMILY IPv6 is refused with 440 when ipv6 is disabled', async () => {
    const { ports } = await startServer({ ipv6: false })
    const c = await client(ports.udp as number)
    await expectTurnError(c.allocate({ family: 6 }), 440)
  })
})

// ---------------------------------------------------------------- lifecycle

describe('lifecycle', () => {
  test('refresh, refresh to 0 deletes, then 437', async () => {
    const { server, ports } = await startServer()
    const c = await client(ports.udp as number)
    await c.allocate({ lifetime: 1200 })
    expect(c.lifetime).toBe(1200)
    expect(await c.refresh(99999)).toBe(3600)
    expect(await c.refresh(0)).toBe(0)
    expect(server.allocations()).toHaveLength(0)
    await expectTurnError(c.refresh(600), 437)
    await expectTurnError(c.createPermission({ family: 4, address: '127.0.0.1', port: 1 }), 437)
  })

  test('allocations expire', async () => {
    const { server, ports } = await startServer({ timings: { defaultLifetime: 1, sweepMs: 50 } })
    const c = await client(ports.udp as number)
    await c.allocate({ lifetime: 1 })
    expect(server.allocations()).toHaveLength(1)
    await sleep(1200)
    expect(server.allocations()).toHaveLength(0)
    await expectTurnError(c.refresh(), 437)
  })

  test('permissions and channels expire', async () => {
    const { ports } = await startServer({
      timings: { permissionLifetime: 1, channelLifetime: 1, sweepMs: 50 },
    })
    const peer = await echoPeer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await c.channelBind(0x4000, peer.addr)
    const got = c.nextData()
    c.sendChannel(0x4000, bytes('ok'))
    await got
    await sleep(1150)
    c.sendChannel(0x4000, bytes('late'))
    c.send(peer.addr, bytes('late'))
    await sleep(80)
    expect(peer.received).toHaveLength(1)
  })

  test('allocate retransmission returns the cached response; a new Allocate gets 437', async () => {
    const { server, ports } = await startServer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await expectTurnError(c.allocate(), 437)
    expect(server.allocations()).toHaveLength(1)
  })

  test('kill() deletes an allocation and reports usage', async () => {
    const usage: UsageReport[] = []
    const { server, ports } = await startServer({ onUsage: (u) => usage.push(u) })
    const peer = await echoPeer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await c.createPermission(peer.addr)
    const got = c.nextData()
    c.send(peer.addr, bytes('12345'))
    await got
    const id = server.allocations()[0]?.id as string
    expect(server.kill('nope')).toBe(false)
    expect(server.kill(id)).toBe(true)
    expect(server.allocations()).toHaveLength(0)
    expect(usage).toEqual([{ username: 'alice', allocationId: id, bytesIn: 5, bytesOut: 5 }])
    await expectTurnError(c.refresh(), 437)
  })

  test('onUsage reports periodic deltas', async () => {
    const usage: UsageReport[] = []
    const { ports } = await startServer({ onUsage: (u) => usage.push(u), usageIntervalMs: 100 })
    const peer = await echoPeer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await c.channelBind(0x4abc, peer.addr)
    for (let i = 0; i < 3; i++) {
      const got = c.nextData()
      c.sendChannel(0x4abc, new Uint8Array(100))
      await got
      await sleep(150)
    }
    const total = usage.reduce((s, u) => s + u.bytesOut, 0)
    expect(total).toBe(300)
    expect(usage.length).toBeGreaterThanOrEqual(2)
  })

  test('stats() counts allocations and bytes', async () => {
    const { server, ports } = await startServer({ timings: { sweepMs: 100 } })
    const peer = await echoPeer()
    const c = await client(ports.tcp as number, 'tcp')
    await c.allocate()
    await c.channelBind(0x4010, peer.addr)
    const got = c.nextData()
    c.sendChannel(0x4010, new Uint8Array(1000))
    await got
    const s = server.stats()
    expect(s.allocations).toBe(1)
    expect(s.bytesIn).toBe(1000)
    expect(s.bytesOut).toBe(1000)
    await sleep(120)
    expect(server.stats().bps).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------- authentication

describe('authentication', () => {
  test('wrong password is rejected with 401', async () => {
    const { server, ports } = await startServer()
    const c = await client(ports.udp as number, 'udp', 'alice', 'wrong')
    await expectTurnError(c.allocate(), 401)
    expect(server.allocations()).toHaveLength(0)
  })

  test('unknown user is rejected with 401', async () => {
    const { ports } = await startServer()
    const c = await client(ports.tcp as number, 'tcp', 'mallory', 'x')
    await expectTurnError(c.allocate(), 401)
  })

  test('unauthenticated Refresh is challenged; MESSAGE-INTEGRITY without USERNAME is a 400', async () => {
    const { ports } = await startServer()
    const c = await client(ports.udp as number)
    await c.allocate()
    const res = await c.transact(Method.Refresh, [], false)
    expect(decodeErrorCode(getAttr(res, Attr.ErrorCode))?.code).toBe(401)
    // hand-built request carrying MESSAGE-INTEGRITY but no USERNAME/REALM/NONCE
    let onReply: (d: Uint8Array) => void = () => {}
    const reply = new Promise<Uint8Array>((resolve) => {
      onReply = resolve
    })
    const raw = await Bun.udpSocket({ socket: { data: (_s, d) => onReply(d.slice()) } })
    cleanups.push(() => raw.close())
    const tid = randomTransactionId()
    raw.send(
      encodeStun(Method.Refresh, Class.Request, tid, [], {
        integrityKey: str('k'),
        fingerprint: true,
      }),
      ports.udp as number,
      '127.0.0.1',
    )
    const msg = decodeStun(await reply)
    expect(decodeErrorCode(getAttr(msg as StunMessage, Attr.ErrorCode))?.code).toBe(400)
  })

  test('forged nonce is challenged with 401 and the client recovers', async () => {
    const { ports } = await startServer()
    const c = await client(ports.udp as number)
    await c.allocate()
    c.nonce = 'ffffffffffffffff0123456789abcdef'
    const forged = await c.transact(Method.Refresh, [], true)
    expect(decodeErrorCode(getAttr(forged, Attr.ErrorCode))?.code).toBe(401)
    c.nonce = 'ffffffffffffffff0123456789abcdef'
    expect(await c.refresh()).toBe(600)
  })

  test('stale nonce answers 438', async () => {
    const { ports } = await startServer({ timings: { nonceLifetime: 1, sweepMs: 50 } })
    const c = await client(ports.udp as number)
    await c.allocate()
    await sleep(2100)
    const res = await c.transact(Method.Refresh, [], true)
    expect(decodeErrorCode(getAttr(res, Attr.ErrorCode))?.code).toBe(438)
    expect(getAttr(res, Attr.Nonce)).toBeDefined()
    // the client library follows the 438 with the fresh nonce
    expect(await c.refresh()).toBe(600)
  })

  test('another user cannot drive an allocation (441)', async () => {
    const { ports } = await startServer()
    const c = await client(ports.udp as number)
    await c.allocate()
    // swap credentials on the same 5-tuple
    ;(c.opts as { username?: string }).username = 'bob'
    c.key = undefined
    ;(c.opts as { password?: string }).password = 'hunter2'
    await expectTurnError(c.refresh(), 441)
  })

  test('MESSAGE-INTEGRITY-SHA256 requests are accepted', async () => {
    const { ports } = await startServer()
    const c = await TurnClient.connect({
      host: '127.0.0.1',
      port: ports.udp as number,
      username: 'bob',
      password: 'hunter2',
      integrity: 'sha256',
    })
    cleanups.push(() => c.close())
    const [r] = await c.allocate()
    expect(r?.port).toBeGreaterThan(0)
  })

  test('TURN REST credentials from @beamhop/p2p/wire', async () => {
    const secret = 'app-secret'
    const { ports } = await startServer({
      credentials: restCredentials({ secret: (appId) => (appId === 'app1' ? secret : null) }),
    })
    const pubkey = 'ab'.repeat(32)
    const username = turnUsername(Date.now() / 1000 + 3600, 'app1', pubkey)
    const ok = await client(ports.udp as number, 'udp', username, turnPassword(secret, username))
    expect(await ok.allocate()).toHaveLength(1)

    const expired = turnUsername(Date.now() / 1000 - 10, 'app1', pubkey)
    const late = await client(ports.udp as number, 'udp', expired, turnPassword(secret, expired))
    await expectTurnError(late.allocate(), 401)

    const other = turnUsername(Date.now() / 1000 + 3600, 'app2', pubkey)
    const wrongApp = await client(ports.udp as number, 'udp', other, turnPassword(secret, other))
    await expectTurnError(wrongApp.allocate(), 401)

    const forged = await client(
      ports.udp as number,
      'udp',
      username,
      turnPassword('nope', username),
    )
    await expectTurnError(forged.allocate(), 401)
  })

  test('async credential lookup', async () => {
    const { ports } = await startServer({
      credentials: async (u) => {
        await sleep(5)
        return u === 'alice' ? { password: 'secret' } : null
      },
    })
    const c = await client(ports.tcp as number, 'tcp')
    expect(await c.allocate()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- quotas and validation

describe('quotas and validation', () => {
  test('maxAllocations per user answers 486', async () => {
    const { ports } = await startServer({ quota: () => ({ maxAllocations: 1 }) })
    const a = await client(ports.udp as number)
    await a.allocate()
    const b = await client(ports.tcp as number, 'tcp')
    await expectTurnError(b.allocate(), 486)
  })

  test('maxAllocations frees up after deletion and is shared per group', async () => {
    const { ports } = await startServer({ quota: () => ({ maxAllocations: 1, group: 'app' }) })
    const a = await client(ports.udp as number, 'udp', 'alice')
    await a.allocate()
    const b = await client(ports.udp as number, 'udp', 'bob')
    await expectTurnError(b.allocate(), 486)
    await a.refresh(0)
    expect(await b.allocate()).toHaveLength(1)
  })

  test('quota allowed:false answers 403', async () => {
    const { ports } = await startServer({ quota: (u) => ({ allowed: u !== 'bob' }) })
    const b = await client(ports.udp as number, 'udp', 'bob')
    await expectTurnError(b.allocate(), 403)
  })

  test('server-wide maxAllocations answers 508', async () => {
    const { ports } = await startServer({ maxAllocations: 1 })
    await (await client(ports.udp as number)).allocate()
    await expectTurnError((await client(ports.udp as number, 'udp', 'bob')).allocate(), 508)
  })

  test('maxBps caps relayed bandwidth', async () => {
    const { server, ports } = await startServer({ quota: () => ({ maxBps: 8 * 2000 }) })
    const peer = await echoPeer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await c.channelBind(0x4100, peer.addr)
    let got = 0
    c.onData((r) => {
      got += r.data.length
    })
    for (let i = 0; i < 50; i++) c.sendChannel(0x4100, new Uint8Array(500))
    await sleep(200)
    // bucket holds one second (2000 bytes) shared by both directions
    expect(peer.received.length * 500).toBeLessThanOrEqual(2000)
    expect(got).toBeLessThanOrEqual(2000)
    expect(server.stats().packetsDropped).toBeGreaterThan(40)
  })

  test('allowPeer can refuse peers with 403', async () => {
    const { ports } = await startServer({ allowPeer: (a) => a !== '10.0.0.1' })
    const c = await client(ports.udp as number)
    await c.allocate()
    await expectTurnError(c.createPermission({ family: 4, address: '10.0.0.1', port: 9 }), 403)
    await c.createPermission({ family: 4, address: '10.0.0.2', port: 9 })
  })

  test('unsupported REQUESTED-TRANSPORT answers 442; missing answers 400', async () => {
    const { ports } = await startServer()
    const c = await client(ports.udp as number)
    await expectTurnError(c.allocate({ transport: 6 }), 442)
    await expectTurnError(c.request(Method.Allocate, []), 400)
  })

  test('invalid channel numbers and rebinding conflicts answer 400', async () => {
    const { ports } = await startServer()
    const peer = await echoPeer()
    const other = await echoPeer()
    const c = await client(ports.udp as number)
    await c.allocate()
    await expectTurnError(c.channelBind(0x3fff, peer.addr), 400)
    await expectTurnError(c.channelBind(0x5000, peer.addr), 400)
    await c.channelBind(0x4000, peer.addr)
    await c.channelBind(0x4000, peer.addr) // refresh is fine
    await expectTurnError(c.channelBind(0x4000, other.addr), 400)
    await expectTurnError(c.channelBind(0x4001, peer.addr), 400)
  })

  test('garbage on a TCP stream closes the connection', async () => {
    const { ports } = await startServer()
    let closed = false
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: ports.tcp as number,
      socket: {
        data() {},
        close() {
          closed = true
        },
      },
    })
    sock.write(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2, 3]))
    await sleep(100)
    expect(closed).toBe(true)
  })

  test('random UDP datagrams do not disturb the server', async () => {
    const { ports } = await startServer()
    const s = await Bun.udpSocket({})
    cleanups.push(() => s.close())
    for (let i = 0; i < 300; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(1 + (i % 120)))
      if (i % 3 === 0) {
        buf[0] = 0
        if (buf.length > 8) buf.set([0x21, 0x12, 0xa4, 0x42], 4)
      }
      s.send(buf, ports.udp as number, '127.0.0.1')
    }
    await sleep(50)
    const c = await client(ports.udp as number)
    expect((await c.binding()).address).toBe('127.0.0.1')
  })
})

// ---------------------------------------------------------------- turns: on a shared TLS port

describe('handleSocket hook (turns: on a shared 443-style port)', () => {
  test('a TLS listener can sniff STUN vs HTTP and hand TURN streams to the server', async () => {
    const { server } = await startServer({ listen: {} })
    type Data = { turn?: ReturnType<TurnServer['handleSocket']>; decided: boolean }
    const mux = Bun.listen<Data>({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: Bun.file(CERT), key: Bun.file(KEY) },
      socket: {
        open(s) {
          s.data = { decided: false }
        },
        data(s, chunk) {
          if (!s.data.decided) {
            s.data.decided = true
            if (looksLikeStunStream(chunk)) s.data.turn = server.handleSocket(s as never, 'tls')
            else {
              s.end(str('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'))
              return
            }
          }
          s.data.turn?.data(chunk)
        },
        drain(s) {
          s.data.turn?.drain()
        },
        close(s) {
          s.data.turn?.close()
        },
      },
    })
    cleanups.push(() => mux.stop(true))

    const res = await fetch(`https://127.0.0.1:${mux.port}/`, {
      tls: { rejectUnauthorized: false },
    })
    expect(await res.text()).toBe('ok')

    const peer = await echoPeer()
    const c = await client(mux.port, 'tls')
    await c.allocate()
    await c.channelBind(0x4444, peer.addr)
    const got = c.nextData()
    c.sendChannel(0x4444, bytes('through the mux'))
    expect(text((await got).data)).toBe('through the mux')
    expect(server.allocations()[0]?.transport).toBe('tls')
  })
})
