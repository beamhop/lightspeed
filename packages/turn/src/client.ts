// Minimal TURN client (UDP, TCP, TLS) used by the tests, the benchmark and health checks.
import type { Socket, udp } from 'bun'
import { StreamFramer } from './framing'
import {
  type Address,
  Attr,
  type AttrList,
  Class,
  decodeErrorCode,
  decodeStr,
  decodeStun,
  decodeXorAddress,
  encodeStun,
  encodeXorAddress,
  getAttr,
  getAttrs,
  isChannelData,
  longTermKey,
  Method,
  randomTransactionId,
  readU32,
  type StunMessage,
  str,
  u32,
} from './stun'

export class TurnError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    readonly response: StunMessage,
  ) {
    super(`TURN error ${code} ${reason}`)
  }
}

export interface TurnClientOptions {
  host: string
  port: number
  transport?: 'udp' | 'tcp' | 'tls'
  username?: string
  password?: string
  /** Initial retransmission timeout for UDP (ms). Default 100. */
  rto?: number
  /** Total request timeout (ms). Default 3000. */
  timeout?: number
  /** TLS: verify the server certificate. Default false (test usage). */
  rejectUnauthorized?: boolean
  /** Integrity algorithm for authenticated requests. Default sha1. */
  integrity?: 'sha1' | 'sha256'
}

export interface Received {
  data: Uint8Array
  peer?: Address
  channel?: number
}

export type DataHandler = (r: Received) => void

type AttrBuilder = (tid: Uint8Array) => AttrList

interface Pending {
  resolve(m: StunMessage): void
  reject(e: Error): void
  timer?: ReturnType<typeof setTimeout>
}

export class TurnClient {
  private udp?: udp.Socket<'buffer'>
  private tcp?: Socket<undefined>
  private framer = new StreamFramer()
  private outQueue: Uint8Array[] = []
  private pending = new Map<string, Pending>()
  private handlers: DataHandler[] = []
  private channelPeers = new Map<number, Address>()
  realm?: string
  nonce?: string
  key?: Uint8Array
  relayed: Address[] = []
  mapped?: Address
  lifetime = 0
  closed = false

  private constructor(readonly opts: TurnClientOptions) {}

  static async connect(opts: TurnClientOptions): Promise<TurnClient> {
    const c = new TurnClient(opts)
    const transport = opts.transport ?? 'udp'
    if (transport === 'udp') {
      const v6 = opts.host.includes(':')
      c.udp = await Bun.udpSocket({
        hostname: v6 ? '::' : '0.0.0.0',
        socket: { data: (_s, data) => c.onPacket(data) },
      })
    } else {
      c.tcp = await Bun.connect({
        hostname: opts.host,
        port: opts.port,
        ...(transport === 'tls'
          ? { tls: { rejectUnauthorized: opts.rejectUnauthorized ?? false } }
          : {}),
        socket: {
          data: (_s, data) => {
            for (const f of c.framer.push(data)) c.onPacket(f)
          },
          drain: () => c.flush(),
          handshake: () => c.flush(),
          close: () => c.onClose(),
          error: () => c.onClose(),
        },
      })
    }
    return c
  }

  onData(h: DataHandler): () => void {
    this.handlers.push(h)
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h)
    }
  }

  /** Next data received (from any peer), with timeout. */
  nextData(timeoutMs = 2000): Promise<Received> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off()
        reject(new Error('timeout waiting for data'))
      }, timeoutMs)
      const off = this.onData((r) => {
        clearTimeout(t)
        off()
        resolve(r)
      })
    })
  }

  sendRaw(buf: Uint8Array): void {
    if (this.udp) this.udp.send(buf, this.opts.port, this.opts.host)
    else this.writeStream(buf)
  }

  /** Bun sockets drop what they cannot write (also before the TLS handshake): queue it. */
  private writeStream(buf: Uint8Array): void {
    if (!this.tcp) return
    if (this.outQueue.length === 0) {
      const n = this.tcp.write(buf)
      if (n >= buf.length) return
      this.outQueue.push(buf.subarray(Math.max(n, 0)))
      return
    }
    this.outQueue.push(buf)
  }

  private flush(): void {
    while (this.tcp && this.outQueue.length) {
      const head = this.outQueue[0] as Uint8Array
      const n = this.tcp.write(head)
      if (n < head.length) {
        this.outQueue[0] = head.subarray(Math.max(n, 0))
        return
      }
      this.outQueue.shift()
    }
  }

  /**
   * Send one request and wait for the matching response (success or error, never throws on an
   * error response). `auth` adds USERNAME/REALM/NONCE/MESSAGE-INTEGRITY when a challenge was seen.
   */
  transact(method: number, attrs: AttrList | AttrBuilder, auth = false): Promise<StunMessage> {
    const tid = randomTransactionId()
    const base = typeof attrs === 'function' ? attrs(tid) : attrs
    const useAuth = auth && this.key && this.realm && this.nonce && this.opts.username !== undefined
    const full: AttrList = useAuth
      ? [
          ...base,
          [Attr.Username, str(this.opts.username as string)],
          [Attr.Realm, str(this.realm as string)],
          [Attr.Nonce, str(this.nonce as string)],
        ]
      : base
    const buf = encodeStun(method, Class.Request, tid, full, {
      ...(useAuth ? { integrityKey: this.key, integrity: this.opts.integrity ?? 'sha1' } : {}),
      fingerprint: true,
    })
    const id = hexId(tid)
    return new Promise((resolve, reject) => {
      const total = this.opts.timeout ?? 3000
      const started = Date.now()
      let rto = this.opts.rto ?? 100
      const entry: Pending = {
        resolve: (m) => {
          clearTimeout(entry.timer)
          this.pending.delete(id)
          resolve(m)
        },
        reject: (e) => {
          clearTimeout(entry.timer)
          this.pending.delete(id)
          reject(e)
        },
      }
      const fire = () => {
        if (this.closed) return entry.reject(new Error('client closed'))
        if (Date.now() - started >= total) return entry.reject(new Error('STUN request timed out'))
        this.sendRaw(buf)
        if (this.udp) {
          entry.timer = setTimeout(fire, rto)
          rto = Math.min(rto * 2, 1600)
        } else
          entry.timer = setTimeout(() => entry.reject(new Error('STUN request timed out')), total)
      }
      this.pending.set(id, entry)
      fire()
    })
  }

  /**
   * Authenticated request: answers the 401 challenge and 438 Stale Nonce transparently.
   * Throws TurnError for any other error (and for a 401 after credentials were sent).
   */
  async request(method: number, attrs: AttrList | AttrBuilder): Promise<StunMessage> {
    // A 401 after credentials were sent may just mean the nonce is no longer known (e.g. the
    // server restarted), so it is retried once with the fresh nonce before giving up.
    let retried401 = false
    for (let attempt = 0; attempt < 4; attempt++) {
      const hadKey = this.key !== undefined
      const res = await this.transact(method, attrs, true)
      if (res.cls === Class.Success) return res
      const err = decodeErrorCode(getAttr(res, Attr.ErrorCode)) ?? { code: 0, reason: 'invalid' }
      const realm = decodeStr(getAttr(res, Attr.Realm))
      const nonce = decodeStr(getAttr(res, Attr.Nonce))
      let retry = err.code === 438 || (err.code === 401 && !hadKey)
      if (err.code === 401 && hadKey && !retried401) {
        retried401 = true
        retry = true
      }
      if (retry && realm !== undefined && nonce !== undefined) {
        this.nonce = nonce
        if (this.realm !== realm || !this.key) {
          this.realm = realm
          if (this.opts.username !== undefined && this.opts.password !== undefined)
            this.key = longTermKey(this.opts.username, realm, this.opts.password)
        }
        if (!this.key) throw new TurnError(err.code, err.reason, res)
        continue
      }
      throw new TurnError(err.code, err.reason, res)
    }
    throw new Error('authentication loop')
  }

  async binding(): Promise<Address> {
    const res = await this.transact(Method.Binding, [])
    const a = decodeXorAddress(getAttr(res, Attr.XorMappedAddress), res.transactionId)
    if (!a) throw new Error('no XOR-MAPPED-ADDRESS')
    return a
  }

  async allocate(
    o: {
      lifetime?: number
      family?: 4 | 6
      additionalFamily?: 6
      transport?: number
      evenPort?: boolean
    } = {},
  ): Promise<Address[]> {
    const attrs: AttrList = [
      [Attr.RequestedTransport, new Uint8Array([o.transport ?? 17, 0, 0, 0])],
    ]
    if (o.lifetime !== undefined) attrs.push([Attr.Lifetime, u32(o.lifetime)])
    if (o.family)
      attrs.push([Attr.RequestedAddressFamily, new Uint8Array([o.family === 4 ? 1 : 2, 0, 0, 0])])
    if (o.additionalFamily) attrs.push([Attr.AdditionalAddressFamily, new Uint8Array([2, 0, 0, 0])])
    if (o.evenPort) attrs.push([Attr.EvenPort, new Uint8Array([0])])
    const res = await this.request(Method.Allocate, attrs)
    this.relayed = getAttrs(res, Attr.XorRelayedAddress)
      .map((v) => decodeXorAddress(v, res.transactionId))
      .filter((a): a is Address => a !== null)
    this.mapped =
      decodeXorAddress(getAttr(res, Attr.XorMappedAddress), res.transactionId) ?? undefined
    this.lifetime = readU32(getAttr(res, Attr.Lifetime)) ?? 0
    return this.relayed
  }

  async refresh(lifetime?: number): Promise<number> {
    const res = await this.request(
      Method.Refresh,
      lifetime === undefined ? [] : [[Attr.Lifetime, u32(lifetime)]],
    )
    this.lifetime = readU32(getAttr(res, Attr.Lifetime)) ?? 0
    return this.lifetime
  }

  async createPermission(...peers: Address[]): Promise<void> {
    await this.request(Method.CreatePermission, (tid) =>
      peers.map((p): [number, Uint8Array] => [Attr.XorPeerAddress, encodeXorAddress(p, tid)]),
    )
  }

  async channelBind(channel: number, peer: Address): Promise<void> {
    await this.request(Method.ChannelBind, (tid) => [
      [Attr.ChannelNumber, new Uint8Array([channel >> 8, channel & 0xff, 0, 0])],
      [Attr.XorPeerAddress, encodeXorAddress(peer, tid)],
    ])
    this.channelPeers.set(channel, peer)
  }

  /** Send indication. */
  send(peer: Address, data: Uint8Array): void {
    const tid = randomTransactionId()
    this.sendRaw(
      encodeStun(Method.Send, Class.Indication, tid, [
        [Attr.XorPeerAddress, encodeXorAddress(peer, tid)],
        [Attr.Data, data],
      ]),
    )
  }

  /** ChannelData message (padded to 4 bytes on streams). */
  sendChannel(channel: number, data: Uint8Array): void {
    this.sendRaw(channelData(channel, data, !this.udp))
  }

  close(): void {
    if (this.closed) return
    this.udp?.close()
    this.tcp?.end()
    this.onClose()
  }

  private onPacket(buf: Uint8Array): void {
    if (isChannelData(buf)) {
      const channel = ((buf[0] as number) << 8) | (buf[1] as number)
      const len = ((buf[2] as number) << 8) | (buf[3] as number)
      if (buf.length < 4 + len) return
      const data = buf.slice(4, 4 + len)
      const peer = this.channelPeers.get(channel)
      for (const h of [...this.handlers]) h({ data, channel, ...(peer ? { peer } : {}) })
      return
    }
    const msg = decodeStun(buf)
    if (!msg) return
    if (msg.cls === Class.Indication && msg.method === Method.Data) {
      const peer = decodeXorAddress(getAttr(msg, Attr.XorPeerAddress), msg.transactionId)
      const data = getAttr(msg, Attr.Data)
      if (!peer || !data) return
      const copy = data.slice()
      for (const h of [...this.handlers]) h({ data: copy, peer })
      return
    }
    if (msg.cls === Class.Success || msg.cls === Class.Error) {
      const p = this.pending.get(hexId(msg.transactionId))
      if (p) p.resolve(decodeStun(buf.slice(0, msg.raw.length)) as StunMessage)
    }
  }

  private onClose(): void {
    this.closed = true
    for (const p of [...this.pending.values()]) p.reject(new Error('connection closed'))
  }
}

export function channelData(channel: number, data: Uint8Array, pad = false): Uint8Array {
  const size = 4 + data.length
  const out = new Uint8Array(pad ? (size + 3) & ~3 : size)
  out[0] = channel >> 8
  out[1] = channel & 0xff
  out[2] = data.length >> 8
  out[3] = data.length & 0xff
  out.set(data, 4)
  return out
}

function hexId(tid: Uint8Array): string {
  let s = ''
  for (const b of tid) s += b.toString(16).padStart(2, '0')
  return s
}
