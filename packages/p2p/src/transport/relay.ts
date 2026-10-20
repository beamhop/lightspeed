// Relay transport: E2E-encrypted frames through wss://relay/a/<appId>/data. Works anywhere a WebSocket
// exists (browsers, Bun, Node 22+, workers), so a Bun server peer can join a room without WebRTC.
//
// Envelope body (inside encodeRelayEnvelope):  type u8 · connId 8 bytes · rest
//   0x01 CONNECT  rest = initiator nonce (32)
//   0x02 ACCEPT   rest = responder nonce (32)
//   0x03 DATA     rest = ChaCha20-Poly1305(ciphertext), nonce = 0x00000000 ‖ u64 per-direction counter
//   0x04 CLOSE
// Keys: HKDF-SHA256(ikm = NIP-44 conversation key, salt = nonceI ‖ nonceR, info = 'beamhop/v1 relay i2r'|'r2i').
// DATA plaintext: op u8 · channel id u16 · ...   op 0 OPEN (mode u8, maxRetransmits u8, label utf8)
//                                                op 1 MSG (payload) · op 2 CLOSE
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import type {
  Channel,
  Connection,
  ConnectionStats,
  Hex,
  Identity,
  Reliability,
  Transport,
  TransportConnectOptions,
  Unsubscribe,
} from '../types'
import { bytesToHex, bytesToUtf8, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '../util/bytes'
import { Listeners } from '../util/emitter'
import { type RelayControl, decodeRelayEnvelope, encodeRelayEnvelope, relayHelloHash } from '../wire'

const T_CONNECT = 1
const T_ACCEPT = 2
const T_DATA = 3
const T_CLOSE = 4
const OP_OPEN = 0
const OP_MSG = 1
const OP_CLOSE = 2

type WebSocketCtor = new (url: string) => WebSocket

export interface RelayTransportOptions {
  /** Data path URL, e.g. wss://relay.example/a/<appId>/data. */
  url: string
  /** App id for the hello signature; parsed from `/a/<appId>/data` when omitted. */
  appId?: string
  /** WebSocket implementation (defaults to the global). */
  WebSocket?: WebSocketCtor
  /** Socket open + hello timeout (default 10 s). */
  timeoutMs?: number
}

export interface RelayTransport extends Transport {
  readonly url: string
  /** Close every relay socket opened by this transport. */
  close(): void
}

function parseAppId(url: string): string {
  const m = /\/a\/([^/]+)\/data\/?$/.exec(new URL(url).pathname)
  if (!m) throw new Error(`relayTransport: cannot infer appId from ${url}; pass { appId }`)
  return decodeURIComponent(m[1] as string)
}

/** One authenticated relay socket per local identity, multiplexing every peer connection. */
class RelaySocket {
  ws: WebSocket
  ready: Promise<void>
  closed = false
  conns = new Map<string, RelayConnection>()
  /** Inbound CONNECTs waiting for a local responder: remote pubkey → handlers. */
  acceptors = new Map<Hex, (connId: string, nonce: Uint8Array) => void>()
  offlineL = new Listeners<[Hex]>()
  closeL = new Listeners<[]>()

  constructor(
    readonly url: string,
    readonly appId: string,
    readonly identity: Identity,
    Ctor: WebSocketCtor,
    timeoutMs: number,
  ) {
    const ws = new Ctor(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('relay: hello timed out'))
        this.shutdown()
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let msg: RelayControl
          try {
            msg = JSON.parse(ev.data)
          } catch {
            return
          }
          if (msg.type === 'challenge') {
            void identity.sign(relayHelloHash(appId, msg.challenge)).then((sig) => {
              ws.send(JSON.stringify({ type: 'hello', pubkey: identity.pubkey, sig: bytesToHex(sig) } satisfies RelayControl))
            })
          } else if (msg.type === 'ready') {
            clearTimeout(timer)
            resolve()
          } else if (msg.type === 'error') {
            clearTimeout(timer)
            reject(new Error(`relay: ${msg.code}: ${msg.message}`))
          } else if (msg.type === 'peer-offline') {
            this.offlineL.emit(msg.pubkey)
          }
          return
        }
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBufferLike)
        this.onBinary(buf)
      })
      ws.addEventListener('close', () => {
        clearTimeout(timer)
        reject(new Error('relay: socket closed'))
        this.shutdown()
      })
      ws.addEventListener('error', () => {
        /* close follows */
      })
    })
    this.ready.catch(() => {})
  }

  private onBinary(buf: Uint8Array): void {
    let env: { pubkey: Hex; body: Uint8Array }
    try {
      env = decodeRelayEnvelope(buf)
    } catch {
      return
    }
    const body = env.body
    if (body.length < 9) return
    const type = body[0]
    const connId = bytesToHex(body.subarray(1, 9))
    const rest = body.subarray(9)
    if (type === T_CONNECT) {
      if (rest.length !== 32) return
      const acceptor = this.acceptors.get(env.pubkey)
      // CONNECTs without a waiting responder are stale attempts; drop them.
      if (acceptor) acceptor(connId, rest.slice())
      return
    }
    const conn = this.conns.get(`${env.pubkey}|${connId}`)
    if (!conn) return
    conn.onBody(type as number, rest)
  }

  send(to: Hex, type: number, connId: string, rest: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1) throw new Error('relay socket not open')
    this.ws.send(encodeRelayEnvelope(to, concatBytes(new Uint8Array([type]), hexToBytes(connId), rest)))
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {}
    for (const c of [...this.conns.values()]) c.fail()
    this.conns.clear()
    this.closeL.emit()
  }
}

function deriveKeys(ck: Uint8Array, nonceI: Uint8Array, nonceR: Uint8Array) {
  const salt = concatBytes(nonceI, nonceR)
  return {
    i2r: hkdf(sha256, ck, salt, 'beamhop/v1 relay i2r', 32),
    r2i: hkdf(sha256, ck, salt, 'beamhop/v1 relay r2i', 32),
  }
}

function counterNonce(n: bigint): Uint8Array {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, n)
  return out
}

class RelayChannel implements Channel {
  readyState: Channel['readyState'] = 'connecting'
  bufferedAmountLowThreshold = 0
  private openL = new Listeners<[]>()
  private msgL = new Listeners<[Uint8Array]>()
  private lowL = new Listeners<[]>()
  private closeL = new Listeners<[]>()
  private inbox: Uint8Array[] = []
  private lowTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly id: number,
    readonly label: string,
    readonly reliability: Reliability,
    private conn: RelayConnection,
  ) {}

  get bufferedAmount(): number {
    return this.conn.socket.ws.bufferedAmount ?? 0
  }

  /** @internal */
  setOpen(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    this.openL.emit()
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error(`relay channel ${this.label} is ${this.readyState}`)
    const head = new Uint8Array(3)
    head[0] = OP_MSG
    new DataView(head.buffer).setUint16(1, this.id)
    this.conn.sendPlain(concatBytes(head, data))
    this.watchLow()
  }

  private watchLow(): void {
    if (this.lowTimer || this.lowL.size === 0) return
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold) return
    const poll = () => {
      this.lowTimer = null
      if (this.readyState !== 'open') return
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.lowL.emit()
      else {
        this.lowTimer = setTimeout(poll, 10)
      }
    }
    this.lowTimer = setTimeout(poll, 10)
  }

  /** @internal */
  deliver(data: Uint8Array): void {
    if (this.msgL.size === 0) this.inbox.push(data)
    else this.msgL.emit(data)
  }

  onOpen(cb: () => void): Unsubscribe {
    return this.openL.add(cb)
  }
  onMessage(cb: (data: Uint8Array) => void): Unsubscribe {
    const u = this.msgL.add(cb)
    const box = this.inbox
    this.inbox = []
    for (const m of box) cb(m)
    return u
  }
  onBufferedAmountLow(cb: () => void): Unsubscribe {
    return this.lowL.add(cb)
  }
  onClose(cb: () => void): Unsubscribe {
    return this.closeL.add(cb)
  }

  close(): void {
    if (this.readyState === 'closed') return
    const head = new Uint8Array(3)
    head[0] = OP_CLOSE
    new DataView(head.buffer).setUint16(1, this.id)
    try {
      this.conn.sendPlain(head)
    } catch {}
    this.closeLocal()
  }

  /** @internal */
  closeLocal(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    if (this.lowTimer) clearTimeout(this.lowTimer)
    this.closeL.emit()
  }
}

class RelayConnection implements Connection {
  readonly path = 'relay' as const
  state: Connection['state'] = 'connecting'
  private sendKey!: Uint8Array
  private recvKey!: Uint8Array
  private sendCtr = 0n
  private recvCtr = 0n
  private channels = new Map<number, RelayChannel>()
  private nextChannel: number
  private chanL = new Listeners<[Channel]>()
  private stateL = new Listeners<[Connection['state']]>()
  private pendingChannels: Channel[] = []
  bytesSent = 0
  bytesReceived = 0

  constructor(
    readonly socket: RelaySocket,
    readonly remote: Hex,
    readonly connId: string,
    readonly initiator: boolean,
  ) {
    // Initiator uses even channel ids, responder odd, so both may open channels without collisions.
    this.nextChannel = initiator ? 0 : 1
  }

  /** @internal */
  established(ck: Uint8Array, nonceI: Uint8Array, nonceR: Uint8Array): void {
    const k = deriveKeys(ck, nonceI, nonceR)
    this.sendKey = this.initiator ? k.i2r : k.r2i
    this.recvKey = this.initiator ? k.r2i : k.i2r
    this.setState('connected')
  }

  private setState(s: Connection['state']): void {
    if (this.state === s || this.state === 'closed') return
    this.state = s
    if (s === 'closed' || s === 'disconnected') {
      this.socket.conns.delete(`${this.remote}|${this.connId}`)
      for (const ch of this.channels.values()) ch.closeLocal()
    }
    this.stateL.emit(s)
    if (s === 'disconnected') this.setState('closed')
  }

  /** @internal */
  sendPlain(plain: Uint8Array): void {
    if (this.state !== 'connected') throw new Error('relay connection not connected')
    const ct = chacha20poly1305(this.sendKey, counterNonce(this.sendCtr++)).encrypt(plain)
    this.bytesSent += ct.length
    this.socket.send(this.remote, T_DATA, this.connId, ct)
  }

  /** @internal */
  onBody(type: number, rest: Uint8Array): void {
    if (type === T_CLOSE) {
      this.setState('closed')
      return
    }
    if (type !== T_DATA || this.state !== 'connected') return
    let plain: Uint8Array
    try {
      plain = chacha20poly1305(this.recvKey, counterNonce(this.recvCtr)).decrypt(rest)
    } catch {
      // Tampering, replay or reordering: the session layer above will resume on a fresh connection.
      this.fail()
      return
    }
    this.recvCtr++
    this.bytesReceived += rest.length
    if (plain.length < 3) return
    const op = plain[0]
    const id = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(1)
    if (op === OP_OPEN) {
      if (this.channels.has(id) || plain.length < 5) return
      const mode = plain[3]
      const reliability: Reliability =
        mode === 0 ? { mode: 'reliable' } : mode === 1 ? { mode: 'unordered' } : { mode: 'unreliable', maxRetransmits: plain[4] as number }
      const ch = new RelayChannel(id, bytesToUtf8(plain.subarray(5)), reliability, this)
      this.channels.set(id, ch)
      ch.setOpen()
      if (this.chanL.size === 0) this.pendingChannels.push(ch)
      else this.chanL.emit(ch)
    } else if (op === OP_MSG) {
      this.channels.get(id)?.deliver(plain.slice(3))
    } else if (op === OP_CLOSE) {
      this.channels.get(id)?.closeLocal()
      this.channels.delete(id)
    }
  }

  openChannel(label: string, reliability: Reliability): Channel {
    if (this.state !== 'connected') throw new Error('relay connection not connected')
    const id = this.nextChannel
    this.nextChannel += 2
    const ch = new RelayChannel(id, label, reliability, this)
    this.channels.set(id, ch)
    const head = new Uint8Array(5)
    head[0] = OP_OPEN
    new DataView(head.buffer).setUint16(1, id)
    head[3] = reliability.mode === 'reliable' ? 0 : reliability.mode === 'unordered' ? 1 : 2
    head[4] = reliability.mode === 'unreliable' ? Math.min(255, reliability.maxRetransmits) : 0
    this.sendPlain(concatBytes(head, utf8ToBytes(label)))
    // The socket is ordered, so the channel is usable immediately.
    queueMicrotask(() => ch.setOpen())
    return ch
  }

  onChannel(cb: (channel: Channel) => void): Unsubscribe {
    const u = this.chanL.add(cb)
    const pending = this.pendingChannels
    this.pendingChannels = []
    for (const ch of pending) cb(ch)
    return u
  }

  onStateChange(cb: (state: Connection['state']) => void): Unsubscribe {
    return this.stateL.add(cb)
  }

  async stats(): Promise<ConnectionStats> {
    return { path: 'relay', bytesSent: this.bytesSent, bytesReceived: this.bytesReceived }
  }

  close(): void {
    if (this.state === 'closed') return
    try {
      this.socket.send(this.remote, T_CLOSE, this.connId, new Uint8Array(0))
    } catch {}
    this.setState('closed')
  }

  /** @internal */
  fail(): void {
    this.setState('disconnected')
  }
}

export function relayTransport(opts: RelayTransportOptions): RelayTransport {
  const appId = opts.appId ?? parseAppId(opts.url)
  const Ctor = opts.WebSocket ?? (globalThis.WebSocket as WebSocketCtor | undefined)
  const sockets = new Map<Hex, RelaySocket>()

  const socketFor = async (identity: Identity): Promise<RelaySocket> => {
    let s = sockets.get(identity.pubkey)
    if (!s || s.closed) {
      if (!Ctor) throw new Error('relayTransport: no WebSocket implementation available')
      const created = new RelaySocket(opts.url, appId, identity, Ctor, opts.timeoutMs ?? 10_000)
      created.closeL.add(() => {
        if (sockets.get(identity.pubkey) === created) sockets.delete(identity.pubkey)
      })
      sockets.set(identity.pubkey, created)
      s = created
    }
    await s.ready
    return s
  }

  return {
    name: 'relay',
    url: opts.url,
    async connect(remote: Hex, o: TransportConnectOptions): Promise<Connection> {
      const socket = await socketFor(o.local)
      const ck = await o.local.conversationKey(remote)
      return new Promise<Connection>((resolve, reject) => {
        const cleanups: (() => void)[] = []
        let settled = false
        const finish = (err: Error | null, conn?: RelayConnection) => {
          if (settled) return
          settled = true
          for (const c of cleanups) c()
          if (err) {
            conn?.close()
            reject(err)
          } else resolve(conn as RelayConnection)
        }
        const onAbort = () => finish(new Error('relay: aborted'))
        if (o.signal?.aborted) return onAbort()
        o.signal?.addEventListener('abort', onAbort)
        cleanups.push(() => o.signal?.removeEventListener('abort', onAbort))
        cleanups.push(socket.closeL.add(() => finish(new Error('relay: socket closed'))))

        if (o.initiator) {
          const connId = bytesToHex(randomBytes(8))
          const nonceI = randomBytes(32)
          const conn = new RelayConnection(socket, remote, connId, true)
          cleanups.push(
            socket.offlineL.add((pk) => {
              if (pk === remote) finish(new Error('relay: peer offline'), conn)
            }),
          )
          cleanups.push(
            o.pipe.onMessage((m) => {
              if (m.type !== 'relay-ready' || settled) return
              socket.conns.set(`${remote}|${connId}`, conn)
              const accept = conn.onBody.bind(conn)
              // Intercept ACCEPT for this connection id.
              conn.onBody = (type, rest) => {
                if (type === T_ACCEPT) {
                  if (rest.length !== 32 || conn.state !== 'connecting') return
                  conn.onBody = accept
                  conn.established(ck, nonceI, rest)
                  finish(null, conn)
                  return
                }
                accept(type, rest)
              }
              try {
                socket.send(remote, T_CONNECT, connId, nonceI)
              } catch (e) {
                finish(e as Error, conn)
              }
            }),
          )
          o.pipe.send({ type: 'relay-connect', url: opts.url })
        } else {
          const accept = (connId: string, nonceI: Uint8Array) => {
            if (settled) return
            const nonceR = randomBytes(32)
            const conn = new RelayConnection(socket, remote, connId, false)
            socket.conns.set(`${remote}|${connId}`, conn)
            try {
              socket.send(remote, T_ACCEPT, connId, nonceR)
            } catch (e) {
              return finish(e as Error, conn)
            }
            conn.established(ck, nonceI, nonceR)
            finish(null, conn)
          }
          const onPipe = o.pipe.onMessage((m) => {
            if (m.type !== 'relay-connect' || settled) return
            socket.acceptors.set(remote, accept)
            cleanups.push(() => {
              if (socket.acceptors.get(remote) === accept) socket.acceptors.delete(remote)
            })
            o.pipe.send({ type: 'relay-ready' })
          })
          cleanups.push(onPipe)
        }
      })
    },
    close() {
      for (const s of sockets.values()) s.shutdown()
      sockets.clear()
    },
  }
}
