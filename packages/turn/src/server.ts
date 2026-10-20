// STUN/TURN server (RFC 8489 + RFC 8656) on Bun.udpSocket and Bun.listen.
import { createHmac, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { Socket, TCPSocketListener, udp } from 'bun'
import { StreamFramer } from './framing'
import {
  type Address,
  Attr,
  type AttrList,
  Class,
  decodeStr,
  decodeStun,
  decodeXorAddress,
  encodeErrorCode,
  encodeStun,
  encodeUnknownAttributes,
  encodeXorAddress,
  formatIp,
  getAttr,
  getAttrs,
  isChannelData,
  longTermKey,
  Method,
  normalizeIp,
  parseIp,
  readU32,
  type StunClass,
  type StunMessage,
  str,
  u32,
  verifyIntegrity,
} from './stun'

// ------------------------------------------------------------------ public types

export type TurnTransport = 'udp' | 'tcp' | 'tls'

export interface QuotaResult {
  /** Max concurrent allocations for this username (or `group`). Exceeding it answers 486. */
  maxAllocations?: number
  /** Bandwidth cap in bits per second, shared by every allocation of the username (or `group`). */
  maxBps?: number
  /** false rejects the Allocate with 403 Forbidden. */
  allowed?: boolean
  /** Accounting group for maxAllocations/maxBps (e.g. the appId). Defaults to the username. */
  group?: string
}

export interface UsageReport {
  username: string
  allocationId: string
  /** Payload bytes received from peers (relayed towards the client) since the previous report. */
  bytesIn: number
  /** Payload bytes sent to peers (relayed from the client) since the previous report. */
  bytesOut: number
}

export interface TurnTimings {
  /** Allocation lifetime when the client asks for none or less (s). Default 600. */
  defaultLifetime?: number
  /** Upper bound for a requested allocation lifetime (s). Default 3600. */
  maxLifetime?: number
  /** Permission lifetime (s). Default 300. */
  permissionLifetime?: number
  /** Channel binding lifetime (s). Default 600. */
  channelLifetime?: number
  /** Nonce validity (s). Default 600; an expired nonce answers 438 Stale Nonce. */
  nonceLifetime?: number
  /** Expiry sweep period (ms). Default 1000. */
  sweepMs?: number
}

export interface TurnServerOptions {
  realm: string
  listen: {
    udp?: number
    tcp?: number
    /** turns: listener. cert/key are file paths or PEM strings. */
    tls?: { port: number; cert: string; key: string }
  }
  /** Bind address for the listeners, default 0.0.0.0 ('::' for dual-stack on Linux). */
  host?: string
  /** Advertised relayed address (IPv4 or IPv6). Defaults to the relay bind address or first public interface. */
  externalIp?: string
  /** Advertised IPv6 relayed address when `externalIp` is IPv4. */
  externalIp6?: string
  /** Bind address for IPv4 relay sockets (default: host when it is an IPv4 address, else 0.0.0.0). */
  relayHost?: string
  /** Bind address for IPv6 relay sockets (default '::'). */
  relayHost6?: string
  /** Offer IPv6 relayed addresses (REQUESTED-ADDRESS-FAMILY / ADDITIONAL-ADDRESS-FAMILY). Default true. */
  ipv6?: boolean
  /** Allocation port range, inclusive. [0, 0] lets the OS pick (tests). */
  relayPorts: [number, number]
  /** Long-term credential lookup; return null to reject. */
  credentials(username: string): { password: string } | null | Promise<{ password: string } | null>
  quota?(username: string): QuotaResult | Promise<QuotaResult>
  /** Called every `usageIntervalMs` per active allocation with byte deltas, and once on deletion. */
  onUsage?(u: UsageReport): void
  usageIntervalMs?: number
  /** Server-wide allocation cap (508 Insufficient Capacity beyond it). */
  maxAllocations?: number
  /** Return false to refuse a peer address in CreatePermission/ChannelBind (403). Default allows all. */
  allowPeer?(address: string, port: number): boolean
  /** SOFTWARE attribute; empty string omits it. */
  software?: string
  timings?: TurnTimings
  log?(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void
}

export interface AllocationInfo {
  id: string
  username: string
  transport: TurnTransport
  client: { address: string; port: number }
  server: { address: string; port: number }
  relayed: Address[]
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  permissions: string[]
  channels: number
  createdAt: number
  expiresAt: number
}

export interface TurnStats {
  allocations: number
  bytesIn: number
  bytesOut: number
  /** Relayed throughput (both directions) over the last sweep period, bits/s. */
  bps: number
  packetsDropped: number
}

/** A byte stream carrying STUN/TURN framing (TCP or decrypted TLS). */
export interface StreamConnection {
  remoteAddress: string
  remotePort: number
  localAddress?: string
  localPort?: number
  write(data: Uint8Array): void
  close(): void
}

export interface StreamSession {
  data(chunk: Uint8Array): void
  close(): void
}

export interface BunSocketSession extends StreamSession {
  drain(): void
}

export interface TurnServer {
  start(): Promise<{ udp?: number; tcp?: number; tls?: number }>
  stop(): Promise<void>
  allocations(): AllocationInfo[]
  kill(id: string): boolean
  stats(): TurnStats
  /** Serve STUN/TURN on an arbitrary byte stream (e.g. a TLS socket on 443 owned by the relay). */
  handleStream(conn: StreamConnection, transport?: 'tcp' | 'tls'): StreamSession
  /** Same, for a Bun TCP/TLS socket; handles write backpressure. Forward data/drain/close to it. */
  handleSocket(socket: Socket<unknown>, transport?: 'tcp' | 'tls'): BunSocketSession
}

// ------------------------------------------------------------------ internals

interface Client {
  transport: TurnTransport
  address: string
  port: number
  serverAddress: string
  serverPort: number
  /** key into the allocation map */
  key: string
  send(data: Uint8Array): void
  /** ChannelData over streams must be padded to 4 bytes */
  stream: boolean
  closed?: boolean
}

interface Relay {
  family: 4 | 6
  socket: udp.Socket<'buffer'>
  advertised: Address
  port: number
}

interface Channel {
  number: number
  peer: Address
  peerKey: string
  expiresAt: number
}

interface Bucket {
  rate: number // bytes per second
  tokens: number
  last: number
}

interface Allocation {
  id: string
  username: string
  group: string
  key: Uint8Array
  client: Client
  relays: Relay[]
  createdAt: number
  expiresAt: number
  permissions: Map<string, number> // peer IP -> expiresAt
  channels: Map<number, Channel>
  channelByPeer: Map<string, Channel>
  allocTid: Uint8Array
  allocResponse: Uint8Array
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  reportedIn: number
  reportedOut: number
  bucket: Bucket | null
}

const KNOWN_REQUEST_ATTRS = new Set<number>([
  Attr.MappedAddress,
  Attr.Username,
  Attr.MessageIntegrity,
  Attr.ErrorCode,
  Attr.ChannelNumber,
  Attr.Lifetime,
  Attr.XorPeerAddress,
  Attr.Data,
  Attr.Realm,
  Attr.Nonce,
  Attr.XorRelayedAddress,
  Attr.RequestedAddressFamily,
  Attr.EvenPort,
  Attr.RequestedTransport,
  Attr.DontFragment,
  Attr.MessageIntegritySha256,
  Attr.PasswordAlgorithm,
  Attr.XorMappedAddress,
  Attr.ReservationToken,
  Attr.Priority,
  Attr.UseCandidate,
])

const UDP_PROTOCOL = 17
const CHANNEL_MIN = 0x4000
const CHANNEL_MAX = 0x4fff

export function createTurnServer(opts: TurnServerOptions): TurnServer {
  const realm = opts.realm
  const host = opts.host ?? '0.0.0.0'
  const software = opts.software ?? 'beamhop-turn'
  const t = opts.timings ?? {}
  const defaultLifetime = t.defaultLifetime ?? 600
  const maxLifetime = t.maxLifetime ?? 3600
  const permissionLifetime = t.permissionLifetime ?? 300
  const channelLifetime = t.channelLifetime ?? 600
  const nonceLifetime = t.nonceLifetime ?? 600
  const sweepMs = t.sweepMs ?? 1000
  const usageIntervalMs = opts.usageIntervalMs ?? 10_000
  const ipv6Enabled = opts.ipv6 !== false
  const log = opts.log ?? (() => {})
  const nonceSecret = randomBytes(32)
  const softwareAttr: AttrList = software ? [[Attr.Software, str(software)]] : []

  const relayBind4 = opts.relayHost ?? (isIpv4(host) ? host : '0.0.0.0')
  const relayBind6 = opts.relayHost6 ?? (isIpv6(host) && host !== '::' ? host : '::')
  const external4 =
    (opts.externalIp && isIpv4(opts.externalIp) ? opts.externalIp : undefined) ??
    (relayBind4 !== '0.0.0.0' ? relayBind4 : (firstInterface(4) ?? '127.0.0.1'))
  const external6 =
    opts.externalIp6 ??
    (opts.externalIp && isIpv6(opts.externalIp) ? opts.externalIp : undefined) ??
    (relayBind6 !== '::' ? relayBind6 : (firstInterface(6) ?? '::1'))

  const allocations = new Map<string, Allocation>() // client key -> allocation
  const byId = new Map<string, Allocation>()
  const pending = new Set<string>()
  const groupCounts = new Map<string, number>()
  const buckets = new Map<string, Bucket>()
  const usedPorts = { 4: new Set<number>(), 6: new Set<number>() }
  const udpClients = new Map<string, Client>()

  let udpSocket: udp.Socket<'buffer'> | null = null
  let tcpListener: TCPSocketListener<unknown> | null = null
  let tlsListener: TCPSocketListener<unknown> | null = null
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let lastUsage = Date.now()
  let lastRate = Date.now()
  let rateBytes = 0
  let totalIn = 0
  let totalOut = 0
  let dropped = 0
  let bps = 0
  let tidCounter = 0
  const tidPrefix = randomBytes(8)

  function nextTid(): Uint8Array {
    const tid = new Uint8Array(12)
    tid.set(tidPrefix)
    new DataView(tid.buffer).setUint32(8, tidCounter++ >>> 0)
    return tid
  }

  // ---------------------------------------------------------------- nonces

  function makeNonce(clientAddr: string): string {
    const exp = (Math.floor(Date.now() / 1000) + nonceLifetime).toString(16)
    return `${exp}${nonceMac(exp, clientAddr)}`
  }

  function nonceMac(exp: string, clientAddr: string): string {
    return createHmac('sha256', nonceSecret)
      .update(`${exp}|${clientAddr}`)
      .digest('hex')
      .slice(0, 16)
  }

  /** 'ok' | 'stale' (well-formed but expired) | 'bad' */
  function checkNonce(nonce: string, clientAddr: string): 'ok' | 'stale' | 'bad' {
    if (nonce.length < 17) return 'bad'
    const exp = nonce.slice(0, nonce.length - 16)
    if (!/^[0-9a-f]+$/.test(exp)) return 'bad'
    if (nonceMac(exp, clientAddr) !== nonce.slice(-16)) return 'bad'
    return Number.parseInt(exp, 16) * 1000 < Date.now() ? 'stale' : 'ok'
  }

  // ---------------------------------------------------------------- responses

  function respond(
    client: Client,
    req: StunMessage,
    cls: StunClass,
    attrs: AttrList,
    key?: Uint8Array,
    algorithm?: 'sha1' | 'sha256',
  ): Uint8Array {
    const out = encodeStun(req.method, cls, req.transactionId, [...attrs, ...softwareAttr], {
      ...(key ? { integrityKey: key, integrity: algorithm ?? 'sha1' } : {}),
      fingerprint: true,
    })
    client.send(out)
    return out
  }

  function respondError(
    client: Client,
    req: StunMessage,
    code: number,
    extra: AttrList = [],
    key?: Uint8Array,
    algorithm?: 'sha1' | 'sha256',
    reason?: string,
  ): void {
    respond(
      client,
      req,
      Class.Error,
      [[Attr.ErrorCode, encodeErrorCode(code, reason)], ...extra],
      key,
      algorithm,
    )
  }

  // ---------------------------------------------------------------- dispatch

  function onClientPacket(client: Client, buf: Uint8Array): void {
    if (isChannelData(buf)) {
      onChannelData(client, buf)
      return
    }
    const msg = decodeStun(buf)
    if (!msg) return
    if (msg.cls === Class.Indication) {
      if (msg.method === Method.Send) onSendIndication(client, msg)
      return
    }
    if (msg.cls !== Class.Request) return
    // Copy: the request may be processed asynchronously and transports may reuse buffers.
    const owned = decodeStun(buf.slice(0, msg.raw.length)) as StunMessage
    handleRequest(client, owned).catch((err) => {
      log('error', 'request handler failed', { err: String(err) })
      try {
        respondError(client, owned, 500)
      } catch {}
    })
  }

  async function handleRequest(client: Client, msg: StunMessage): Promise<void> {
    const unknown = msg.attributes
      .map((a) => a.type)
      .filter((tp) => tp < 0x8000 && !KNOWN_REQUEST_ATTRS.has(tp))
    if (unknown.length) {
      respondError(client, msg, 420, [[Attr.UnknownAttributes, encodeUnknownAttributes(unknown)]])
      return
    }
    switch (msg.method) {
      case Method.Binding:
        respond(client, msg, Class.Success, [
          [Attr.XorMappedAddress, encodeXorAddress(clientAddress(client), msg.transactionId)],
        ])
        return
      case Method.Allocate:
        return handleAllocate(client, msg)
      case Method.Refresh:
      case Method.CreatePermission:
      case Method.ChannelBind:
        return handleAllocationRequest(client, msg)
      default:
        respondError(client, msg, 400)
    }
  }

  /** Long-term credential check. Returns the key, or null after having sent the error. */
  async function authenticate(
    client: Client,
    msg: StunMessage,
  ): Promise<{ username: string; key: Uint8Array; algorithm: 'sha1' | 'sha256' } | null> {
    const challenge = (code: number): null => {
      respondError(client, msg, code, [
        [Attr.Realm, str(realm)],
        [Attr.Nonce, str(makeNonce(client.address))],
      ])
      return null
    }
    const hasMi =
      getAttr(msg, Attr.MessageIntegrity) !== undefined ||
      getAttr(msg, Attr.MessageIntegritySha256) !== undefined
    if (!hasMi) return challenge(401)
    const username = decodeStr(getAttr(msg, Attr.Username))
    const reqRealm = decodeStr(getAttr(msg, Attr.Realm))
    const nonce = decodeStr(getAttr(msg, Attr.Nonce))
    if (username === undefined || reqRealm === undefined || nonce === undefined) {
      respondError(client, msg, 400)
      return null
    }
    const n = checkNonce(nonce, client.address)
    if (n === 'bad') return challenge(401)
    if (n === 'stale') return challenge(438)
    let cred: { password: string } | null = null
    try {
      cred = await opts.credentials(username)
    } catch (err) {
      log('warn', 'credentials lookup failed', { username, err: String(err) })
    }
    if (!cred) return challenge(401)
    const key = longTermKey(username, realm, cred.password)
    const v = verifyIntegrity(msg, key)
    if (v.result !== 'ok') return challenge(401)
    return { username, key, algorithm: v.algorithm ?? 'sha1' }
  }

  // ---------------------------------------------------------------- Allocate

  async function handleAllocate(client: Client, msg: StunMessage): Promise<void> {
    const existing = allocations.get(client.key)
    if (existing && bytesEqual(existing.allocTid, msg.transactionId)) {
      client.send(existing.allocResponse)
      return
    }
    if (pending.has(client.key)) return // retransmission while we are still working
    pending.add(client.key)
    try {
      const auth = await authenticate(client, msg)
      if (!auth) return
      const { username, key, algorithm } = auth
      const fail = (code: number, extra: AttrList = []) =>
        respondError(client, msg, code, extra, key, algorithm)
      if (allocations.has(client.key)) return fail(437)

      const rt = getAttr(msg, Attr.RequestedTransport)
      if (!rt || rt.length !== 4) return fail(400)
      if (rt[0] !== UDP_PROTOCOL) return fail(442)
      if (getAttr(msg, Attr.ReservationToken)) return fail(508)

      // Address families
      const raf = getAttr(msg, Attr.RequestedAddressFamily)
      const aaf = getAttr(msg, Attr.AdditionalAddressFamily)
      if (raf && aaf) return fail(400)
      const families: (4 | 6)[] = []
      if (raf) {
        if (raf.length !== 4) return fail(400)
        if (raf[0] === 1) families.push(4)
        else if (raf[0] === 2) families.push(6)
        else return fail(440)
      } else families.push(4)
      if (aaf) {
        if (aaf.length !== 4 || aaf[0] !== 2) return fail(400)
        families.push(6)
      }
      if (!ipv6Enabled && families[0] === 6) return fail(440)

      // Quotas
      const q: QuotaResult = (await opts.quota?.(username)) ?? {}
      if (q.allowed === false) return fail(403)
      const group = q.group ?? username
      if (q.maxAllocations !== undefined && (groupCounts.get(group) ?? 0) >= q.maxAllocations)
        return fail(486)
      if (opts.maxAllocations !== undefined && byId.size >= opts.maxAllocations) return fail(508)
      if (client.closed) return

      const lifetime = clampLifetime(readU32(getAttr(msg, Attr.Lifetime)))
      const even = getAttr(msg, Attr.EvenPort) !== undefined

      const alloc: Allocation = {
        id: randomBytes(16).toString('hex'),
        username,
        group,
        key,
        client,
        relays: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + lifetime * 1000,
        permissions: new Map(),
        channels: new Map(),
        channelByPeer: new Map(),
        allocTid: msg.transactionId.slice(),
        allocResponse: new Uint8Array(0),
        bytesIn: 0,
        bytesOut: 0,
        packetsIn: 0,
        packetsOut: 0,
        reportedIn: 0,
        reportedOut: 0,
        bucket: null,
      }
      const extra: AttrList = []
      for (const [i, fam] of families.entries()) {
        const relay = fam === 6 && !ipv6Enabled ? null : await openRelay(alloc, fam, even)
        if (relay) alloc.relays.push(relay)
        else if (i === 0) {
          for (const r of alloc.relays) closeRelay(r)
          return fail(fam === 6 ? 440 : 508)
        } else {
          // ADDRESS-ERROR-CODE for the additional family (RFC 8656 §18.13)
          const v = encodeErrorCode(440)
          v[0] = 0x02
          extra.push([Attr.AddressErrorCode, v])
        }
      }
      if (client.closed) {
        for (const r of alloc.relays) closeRelay(r)
        return
      }
      if (q.maxBps !== undefined && q.maxBps > 0) {
        let b = buckets.get(group)
        const rate = q.maxBps / 8
        if (!b) {
          b = { rate, tokens: rate, last: Date.now() }
          buckets.set(group, b)
        }
        b.rate = rate
        alloc.bucket = b
      }

      const attrs: AttrList = [
        ...alloc.relays.map((r): [number, Uint8Array] => [
          Attr.XorRelayedAddress,
          encodeXorAddress(r.advertised, msg.transactionId),
        ]),
        ...extra,
        [Attr.Lifetime, u32(lifetime)],
        [Attr.XorMappedAddress, encodeXorAddress(clientAddress(client), msg.transactionId)],
      ]
      allocations.set(client.key, alloc)
      byId.set(alloc.id, alloc)
      groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1)
      alloc.allocResponse = respond(client, msg, Class.Success, attrs, key, algorithm)
      log('info', 'allocation created', {
        id: alloc.id,
        username,
        client: `${client.address}:${client.port}`,
        relayed: alloc.relays.map((r) => `${r.advertised.address}:${r.advertised.port}`),
      })
    } finally {
      pending.delete(client.key)
    }
  }

  function clampLifetime(requested: number | undefined): number {
    if (requested === undefined) return defaultLifetime
    return Math.max(defaultLifetime, Math.min(requested, maxLifetime))
  }

  async function openRelay(alloc: Allocation, family: 4 | 6, even: boolean): Promise<Relay | null> {
    const [lo, hi] = opts.relayPorts
    const bindHost = family === 4 ? relayBind4 : relayBind6
    const used = usedPorts[family]
    const handler: udp.SocketHandler<'buffer'> = {
      data(_s, data, port, address) {
        onPeerPacket(alloc, data, address, port)
      },
    }
    const tryBind = async (port: number) => {
      try {
        return await Bun.udpSocket({ hostname: bindHost, port, socket: handler })
      } catch {
        return null
      }
    }
    let socket: udp.Socket<'buffer'> | null = null
    if (lo === 0 && hi === 0) {
      for (let i = 0; i < 10 && !socket; i++) {
        const s = await tryBind(0)
        if (s && even && s.port % 2 !== 0) s.close()
        else socket = s
      }
    } else {
      const size = hi - lo + 1
      const start = Math.floor(Math.random() * size)
      let failures = 0
      for (let i = 0; i < size && !socket && failures < 64; i++) {
        const port = lo + ((start + i) % size)
        if (used.has(port) || (even && port % 2 !== 0)) continue
        socket = await tryBind(port)
        if (!socket) failures++
      }
    }
    if (!socket) return null
    used.add(socket.port)
    const advertisedIp = family === 4 ? external4 : external6
    return {
      family,
      socket,
      port: socket.port,
      advertised: { family, address: advertisedIp, port: socket.port },
    }
  }

  function closeRelay(r: Relay): void {
    try {
      r.socket.close()
    } catch {}
    usedPorts[r.family].delete(r.port)
  }

  // ---------------------------------------------------------------- Refresh / CreatePermission / ChannelBind

  async function handleAllocationRequest(client: Client, msg: StunMessage): Promise<void> {
    const auth = await authenticate(client, msg)
    if (!auth) return
    const { username, key, algorithm } = auth
    const fail = (code: number) => respondError(client, msg, code, [], key, algorithm)
    const ok = (attrs: AttrList) => respond(client, msg, Class.Success, attrs, key, algorithm)
    const alloc = allocations.get(client.key)
    if (!alloc) return fail(437)
    if (alloc.username !== username) return fail(441)
    const now = Date.now()

    if (msg.method === Method.Refresh) {
      const raf = getAttr(msg, Attr.RequestedAddressFamily)
      if (raf) {
        const fam = raf[0] === 1 ? 4 : raf[0] === 2 ? 6 : 0
        if (!alloc.relays.some((r) => r.family === fam)) return fail(443)
      }
      const requested = readU32(getAttr(msg, Attr.Lifetime))
      if (requested === 0) {
        deleteAllocation(alloc, 'refresh-0')
        return void ok([[Attr.Lifetime, u32(0)]])
      }
      const lifetime = clampLifetime(requested)
      alloc.expiresAt = now + lifetime * 1000
      return void ok([[Attr.Lifetime, u32(lifetime)]])
    }

    if (msg.method === Method.CreatePermission) {
      const peers = getAttrs(msg, Attr.XorPeerAddress).map((v) =>
        decodeXorAddress(v, msg.transactionId),
      )
      if (peers.length === 0 || peers.some((p) => p === null)) return fail(400)
      for (const p of peers as Address[]) {
        if (!alloc.relays.some((r) => r.family === p.family)) return fail(443)
        if (opts.allowPeer && !opts.allowPeer(p.address, p.port)) return fail(403)
      }
      for (const p of peers as Address[])
        alloc.permissions.set(p.address, now + permissionLifetime * 1000)
      return void ok([])
    }

    // ChannelBind
    const cn = getAttr(msg, Attr.ChannelNumber)
    const peer = decodeXorAddress(getAttr(msg, Attr.XorPeerAddress), msg.transactionId)
    if (!cn || cn.length !== 4 || !peer) return fail(400)
    const number = ((cn[0] as number) << 8) | (cn[1] as number)
    if (number < CHANNEL_MIN || number > CHANNEL_MAX) return fail(400)
    if (!alloc.relays.some((r) => r.family === peer.family)) return fail(443)
    if (opts.allowPeer && !opts.allowPeer(peer.address, peer.port)) return fail(403)
    const peerKey = `${peer.address}|${peer.port}`
    const byNumber = alloc.channels.get(number)
    const byPeer = alloc.channelByPeer.get(peerKey)
    if (byNumber && byNumber.peerKey !== peerKey) return fail(400)
    if (byPeer && byPeer.number !== number) return fail(400)
    const ch = byNumber ?? { number, peer, peerKey, expiresAt: 0 }
    ch.expiresAt = now + channelLifetime * 1000
    alloc.channels.set(number, ch)
    alloc.channelByPeer.set(peerKey, ch)
    alloc.permissions.set(peer.address, now + permissionLifetime * 1000)
    ok([])
  }

  // ---------------------------------------------------------------- data plane

  function allow(alloc: Allocation, bytes: number): boolean {
    const b = alloc.bucket
    if (!b) return true
    const now = Date.now()
    b.tokens = Math.min(b.rate, b.tokens + ((now - b.last) / 1000) * b.rate)
    b.last = now
    if (b.tokens < bytes) {
      dropped++
      return false
    }
    b.tokens -= bytes
    return true
  }

  function hasPermission(alloc: Allocation, ip: string): boolean {
    let exp = alloc.permissions.get(ip)
    if (exp === undefined) {
      const n = normalizeIp(ip)
      if (n !== ip) exp = alloc.permissions.get(n)
    }
    return exp !== undefined && exp > Date.now()
  }

  function relayTo(alloc: Allocation, peer: Address, data: Uint8Array): void {
    const relay = alloc.relays.find((r) => r.family === peer.family)
    if (!relay) return
    if (!hasPermission(alloc, peer.address)) return
    if (!allow(alloc, data.length)) return
    if (relay.socket.send(data, peer.port, peer.address)) {
      alloc.bytesOut += data.length
      alloc.packetsOut++
      totalOut += data.length
      rateBytes += data.length
    } else dropped++
  }

  function onChannelData(client: Client, buf: Uint8Array): void {
    const alloc = allocations.get(client.key)
    if (!alloc) return
    const number = ((buf[0] as number) << 8) | (buf[1] as number)
    const len = ((buf[2] as number) << 8) | (buf[3] as number)
    if (buf.length < 4 + len) return
    const ch = alloc.channels.get(number)
    if (!ch || ch.expiresAt <= Date.now()) return
    relayTo(alloc, ch.peer, buf.subarray(4, 4 + len))
  }

  function onSendIndication(client: Client, msg: StunMessage): void {
    const alloc = allocations.get(client.key)
    if (!alloc) return
    const peer = decodeXorAddress(getAttr(msg, Attr.XorPeerAddress), msg.transactionId)
    const data = getAttr(msg, Attr.Data)
    if (!peer || !data) return
    relayTo(alloc, peer, data)
  }

  function onPeerPacket(alloc: Allocation, data: Uint8Array, address: string, port: number): void {
    if (alloc.client.closed) return
    if (!hasPermission(alloc, address)) return
    if (!allow(alloc, data.length)) return
    let ch = alloc.channelByPeer.get(`${address}|${port}`)
    if (!ch && address.startsWith('::ffff:'))
      ch = alloc.channelByPeer.get(`${normalizeIp(address)}|${port}`)
    let out: Uint8Array
    if (ch && ch.expiresAt > Date.now()) {
      const size = 4 + data.length
      out = new Uint8Array(alloc.client.stream ? (size + 3) & ~3 : size)
      out[0] = ch.number >> 8
      out[1] = ch.number & 0xff
      out[2] = data.length >> 8
      out[3] = data.length & 0xff
      out.set(data, 4)
    } else {
      const tid = nextTid()
      const ip = normalizeIp(address)
      out = encodeStun(Method.Data, Class.Indication, tid, [
        [Attr.XorPeerAddress, encodeXorAddress({ family: ipFamilyOf(ip), address: ip, port }, tid)],
        [Attr.Data, data],
      ])
    }
    alloc.bytesIn += data.length
    alloc.packetsIn++
    totalIn += data.length
    rateBytes += data.length
    alloc.client.send(out)
  }

  // ---------------------------------------------------------------- lifecycle

  function deleteAllocation(alloc: Allocation, reason: string): void {
    if (byId.get(alloc.id) !== alloc) return
    byId.delete(alloc.id)
    allocations.delete(alloc.client.key)
    for (const r of alloc.relays) closeRelay(r)
    const n = (groupCounts.get(alloc.group) ?? 1) - 1
    if (n <= 0) {
      groupCounts.delete(alloc.group)
      buckets.delete(alloc.group)
    } else groupCounts.set(alloc.group, n)
    reportUsage(alloc)
    log('info', 'allocation deleted', { id: alloc.id, reason })
  }

  function reportUsage(alloc: Allocation): void {
    const bytesIn = alloc.bytesIn - alloc.reportedIn
    const bytesOut = alloc.bytesOut - alloc.reportedOut
    if (!opts.onUsage || (bytesIn === 0 && bytesOut === 0)) return
    alloc.reportedIn = alloc.bytesIn
    alloc.reportedOut = alloc.bytesOut
    try {
      opts.onUsage({ username: alloc.username, allocationId: alloc.id, bytesIn, bytesOut })
    } catch (err) {
      log('warn', 'onUsage threw', { err: String(err) })
    }
  }

  function sweep(): void {
    const now = Date.now()
    for (const alloc of [...byId.values()]) {
      if (alloc.expiresAt <= now) {
        deleteAllocation(alloc, 'expired')
        continue
      }
      for (const [ip, exp] of alloc.permissions) if (exp <= now) alloc.permissions.delete(ip)
      for (const [num, ch] of alloc.channels)
        if (ch.expiresAt <= now) {
          alloc.channels.delete(num)
          alloc.channelByPeer.delete(ch.peerKey)
        }
    }
    if (now - lastUsage >= usageIntervalMs) {
      lastUsage = now
      for (const alloc of byId.values()) reportUsage(alloc)
    }
    const elapsed = now - lastRate
    if (elapsed > 0) {
      bps = Math.round((rateBytes * 8 * 1000) / elapsed)
      rateBytes = 0
      lastRate = now
    }
  }

  // ---------------------------------------------------------------- transports

  function clientAddress(client: Client): Address {
    const ip = normalizeIp(client.address)
    return { family: ipFamilyOf(ip), address: ip, port: client.port }
  }

  function makeUdpClient(socket: udp.Socket<'buffer'>, address: string, port: number): Client {
    return {
      transport: 'udp',
      address,
      port,
      serverAddress: host,
      serverPort: socket.port,
      key: `u|${address}|${port}`,
      stream: false,
      send(data) {
        socket.send(data, port, address)
      },
    }
  }

  let streamSeq = 0
  function handleStream(conn: StreamConnection, transport: 'tcp' | 'tls' = 'tcp'): StreamSession {
    const framer = new StreamFramer()
    const client: Client = {
      transport,
      address: conn.remoteAddress,
      port: conn.remotePort,
      serverAddress: conn.localAddress ?? host,
      serverPort: conn.localPort ?? 0,
      key: `s|${++streamSeq}`,
      stream: true,
      send(data) {
        if (!client.closed) conn.write(data)
      },
    }
    return {
      data(chunk) {
        if (client.closed) return
        for (const frame of framer.push(chunk)) onClientPacket(client, frame)
        if (framer.broken) {
          this.close()
          conn.close()
        }
      },
      close() {
        if (client.closed) return
        client.closed = true
        const alloc = allocations.get(client.key)
        if (alloc) deleteAllocation(alloc, 'connection closed')
      },
    }
  }

  function handleSocket(
    socket: Socket<unknown>,
    transport: 'tcp' | 'tls' = 'tcp',
  ): BunSocketSession {
    const queue: Uint8Array[] = []
    let queued = 0
    const MAX_QUEUE = 4 * 1024 * 1024
    const flush = () => {
      while (queue.length) {
        const head = queue[0] as Uint8Array
        const n = socket.write(head)
        if (n < 0) return
        if (n < head.length) {
          queue[0] = head.subarray(n)
          queued -= n
          return
        }
        queue.shift()
        queued -= head.length
      }
    }
    const session = handleStream(
      {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        write(data) {
          if (queue.length === 0) {
            const n = socket.write(data)
            if (n >= data.length) return
            data = data.subarray(Math.max(n, 0))
          }
          if (queued + data.length > MAX_QUEUE) {
            dropped++
            return
          }
          queue.push(data)
          queued += data.length
        },
        close() {
          socket.end()
        },
      },
      transport,
    )
    return {
      data: (chunk) => session.data(chunk),
      close: () => session.close(),
      drain: flush,
    }
  }

  function listenStream(port: number, tls?: { cert: string; key: string }) {
    const transport = tls ? 'tls' : 'tcp'
    return Bun.listen<{ session?: BunSocketSession }>({
      hostname: host,
      port,
      ...(tls ? { tls: { cert: pemOrFile(tls.cert), key: pemOrFile(tls.key) } } : {}),
      socket: {
        open(socket) {
          socket.data = { session: handleSocket(socket as Socket<unknown>, transport) }
        },
        data(socket, chunk) {
          socket.data.session?.data(chunk)
        },
        drain(socket) {
          socket.data.session?.drain()
        },
        close(socket) {
          socket.data.session?.close()
        },
        error(socket, err) {
          log('debug', 'stream error', { err: String(err) })
          socket.data.session?.close()
        },
      },
    }) as unknown as TCPSocketListener<unknown>
  }

  return {
    async start() {
      const out: { udp?: number; tcp?: number; tls?: number } = {}
      if (opts.listen.udp !== undefined) {
        udpSocket = await Bun.udpSocket({
          hostname: host,
          port: opts.listen.udp,
          socket: {
            data(socket, data, port, address) {
              onClientPacket(makeUdpClientCached(socket, address, port), data)
            },
          },
        })
        out.udp = udpSocket.port
      }
      if (opts.listen.tcp !== undefined) {
        tcpListener = listenStream(opts.listen.tcp)
        out.tcp = tcpListener.port
      }
      if (opts.listen.tls) {
        tlsListener = listenStream(opts.listen.tls.port, opts.listen.tls)
        out.tls = tlsListener.port
      }
      sweepTimer = setInterval(sweep, sweepMs)
      log('info', 'turn server started', { ...out, realm })
      return out
    },
    async stop() {
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = null
      for (const alloc of [...byId.values()]) deleteAllocation(alloc, 'server stopped')
      udpSocket?.close()
      tcpListener?.stop(true)
      tlsListener?.stop(true)
      udpSocket = null
      tcpListener = null
      tlsListener = null
      udpClients.clear()
    },
    allocations() {
      return [...byId.values()].map((a) => ({
        id: a.id,
        username: a.username,
        transport: a.client.transport,
        client: { address: normalizeIp(a.client.address), port: a.client.port },
        server: { address: a.client.serverAddress, port: a.client.serverPort },
        relayed: a.relays.map((r) => ({ ...r.advertised })),
        bytesIn: a.bytesIn,
        bytesOut: a.bytesOut,
        packetsIn: a.packetsIn,
        packetsOut: a.packetsOut,
        permissions: [...a.permissions.keys()],
        channels: a.channels.size,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
      }))
    },
    kill(id) {
      const a = byId.get(id)
      if (!a) return false
      deleteAllocation(a, 'killed')
      return true
    },
    stats() {
      return {
        allocations: byId.size,
        bytesIn: totalIn,
        bytesOut: totalOut,
        bps,
        packetsDropped: dropped,
      }
    },
    handleStream,
    handleSocket,
  }

  // UDP client objects are cached per source so the hot path does not allocate closures.
  function makeUdpClientCached(
    socket: udp.Socket<'buffer'>,
    address: string,
    port: number,
  ): Client {
    const k = `${address}|${port}`
    let c = udpClients.get(k)
    if (!c) {
      if (udpClients.size > 100_000) udpClients.clear()
      c = makeUdpClient(socket, address, port)
      udpClients.set(k, c)
    }
    return c
  }
}

// ------------------------------------------------------------------ helpers

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isIpv4(s: string): boolean {
  const ip = parseIp(s)
  return ip !== null && ip.length === 4
}

function isIpv6(s: string): boolean {
  const ip = parseIp(s)
  return ip !== null && ip.length === 16
}

function ipFamilyOf(normalized: string): 4 | 6 {
  return normalized.includes(':') ? 6 : 4
}

function firstInterface(family: 4 | 6): string | undefined {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const i of list ?? []) {
        if (i.internal) continue
        if (family === 4 && i.family === 'IPv4') return i.address
        if (family === 6 && i.family === 'IPv6' && !i.address.toLowerCase().startsWith('fe80'))
          return formatIp(parseIp(i.address) as Uint8Array)
      }
    }
  } catch {}
  return undefined
}

function pemOrFile(v: string): string | ReturnType<typeof Bun.file> {
  return v.includes('-----BEGIN') ? v : Bun.file(v)
}
