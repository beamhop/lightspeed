import { gcm } from '@noble/ciphers/aes'
import { sha256 } from '@noble/hashes/sha256'
import { decodeCbor, encodeCbor } from '../codec/cbor'
import { schnorrVerify } from '../crypto/nostr'
import { type Capability, type CapabilityToken, verifyCapability } from '../identity/capability'
import { type AttestationResult, verifyAttestation } from '../identity/oidc'
import { unionAdapters } from '../signaling/union'
import { type StateOp, type StateSnapshot, StateStore } from '../state/store'
import { TelemetryBus, type TelemetryInput } from '../telemetry'
import { MemoryHub } from '../transport/memory'
import type {
  Attestation,
  Hex,
  Identity,
  IdentityProvider,
  Signal,
  SignalingAdapter,
  SignalPipe,
  TelemetryEvent,
  Transport,
  TransportSignal,
  Unsubscribe,
} from '../types'
import {
  bytesToUtf8,
  compareHex,
  concatBytes,
  fromBase64,
  randomBytes,
  randomId,
  toBase64,
  utf8ToBytes,
} from '../util/bytes'
import { type Clock, realClock } from '../util/clock'
import { Listeners } from '../util/emitter'
import {
  ANNOUNCE_INTERVAL_S,
  ANNOUNCE_TTL_S,
  CHUNK_SIZE,
  type Frame,
  FrameType,
  PROTOCOL_VERSION,
  roomKey,
  roomTopic,
  TELEMETRY_CHANNEL,
} from '../wire'
import { type DevtoolsOptions, startDevtools } from './devtools'
import { type Lane, Link } from './link'
import {
  type ActionDef,
  laneFor,
  type ProtocolDef,
  priorityLevel,
  type RequestDef,
  type StandardSchemaV1,
} from './protocol'
import { type PriorityLevel, type SeqLane, Session } from './session'
import type {
  ActionHandle,
  FileSendOptions,
  FileSource,
  IncomingFile,
  Peer,
  PeerCandidate,
  RequestHandle,
  Room,
  RoomOptions,
  RoomTelemetry,
  SessionInfo,
  Target,
  Topology,
} from './types'

// ---------------------------------------------------------------- wire shapes

interface AnnouncePayload {
  v: number
  pubkey: Hex
  sid: string
  attestations: readonly Attestation[]
  meta: Record<string, unknown>
  cap?: CapabilityToken
  ttl: number
  ts: number
  leave?: boolean
}

interface DirectPayload {
  v: number
  /** Transport name ('' for room-level control such as knock). */
  tr: string
  /** Attempt id chosen by the initiator. */
  at: string
  m: TransportSignal
}

interface Hello {
  v: number
  pubkey: Hex
  sid: string
  topic: Hex
  nonce: Uint8Array
  attestations: Attestation[]
  meta: Record<string, unknown>
  cap?: CapabilityToken
  /** What we hold of the remote's session: its sid and our receive cursors. */
  known?: { sid: string; recv: [number, number] }
}

interface HandshakeResult {
  hello: Hello
  verified: AttestationResult[]
  caps: Capability[]
  backlog: [Frame, Lane][]
}

/** Application-level message carried in session units. */
interface Msg {
  a: string
  d?: unknown
  /** Request id. */
  q?: string
  /** Response to request id. */
  r?: string
  /** Error message for a response. */
  e?: string
  /** Star routing: explicit targets (absent = everyone). */
  t?: Hex[]
  /** Star routing: original sender, stamped by the host. */
  o?: Hex
}

const ROSTER = '__roster'
const STATE_OP = '__state'
const STATE_REQ = '__state/req'
const STATE_SNAP = '__state/snap'
const FILE_START = '__file'
const FILE_CHUNK = '__file/c'
const FILE_END = '__file/e'
const FILE_PIECE = CHUNK_SIZE - 96

const TR_CONTROL = ''

interface SessionEntry {
  session: Session
  hello: Hello
  verified: AttestationResult[]
  caps: Capability[]
  transport: string | null
  resumeTimer: unknown
  unwantedSince?: number | null
  attachedAt: number
}

interface Presence {
  pubkey: Hex
  sid: string
  meta: Record<string, unknown>
  attestations: readonly Attestation[]
  expiresAt: number
}

interface VirtualPeer {
  pubkey: Hex
  meta: Record<string, unknown>
  attestations: Attestation[]
  caps: Capability[]
  confirmedAt: number
  /** Listed in the current host's latest roster. */
  listed: boolean
}

interface AttemptState {
  running: boolean
  failures: number
  nextAt: number
}

class Pipe implements SignalPipe {
  private l = new Listeners<[TransportSignal]>()
  private held: TransportSignal[] = []
  closed = false
  constructor(private out: (m: TransportSignal) => void) {}
  send(m: TransportSignal): void {
    if (!this.closed) this.out(m)
  }
  onMessage(cb: (m: TransportSignal) => void): Unsubscribe {
    const u = this.l.add(cb)
    const held = this.held
    this.held = []
    for (const m of held) cb(m)
    return u
  }
  deliver(m: TransportSignal): void {
    if (this.closed) return
    if (this.l.size === 0) this.held.push(m)
    else this.l.emit(m)
  }
}

function withTimeout<T>(
  clock: Clock,
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = clock.setTimeout(() => {
      onTimeout?.()
      reject(new Error(`${what} timed out after ${ms} ms`))
    }, ms)
    p.then(
      (v) => {
        clock.clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clock.clearTimeout(t)
        reject(e)
      },
    )
  })
}

function transcript(
  topic: Hex,
  signer: Hex,
  verifier: Hex,
  signerNonce: Uint8Array,
  verifierNonce: Uint8Array,
  signerHello: Uint8Array,
): Uint8Array {
  return sha256(
    encodeCbor([
      'beamhop-hs/v1',
      topic,
      signer,
      verifier,
      signerNonce,
      verifierNonce,
      sha256(signerHello),
    ]),
  )
}

function isIdentity(x: IdentityProvider | Identity): x is Identity {
  return typeof (x as Identity).sign === 'function' && typeof (x as Identity).pubkey === 'string'
}

/** Create and join a room. Resolves once the identity is loaded and signaling is subscribed. */
export async function createRoom<P extends ProtocolDef = ProtocolDef>(
  opts: RoomOptions<P>,
): Promise<Room<P>> {
  const identity = isIdentity(opts.identity) ? opts.identity : await opts.identity.load()
  const room = new RoomImpl<P>(opts, identity)
  room.start()
  return room
}

export class RoomImpl<P extends ProtocolDef> implements Room<P> {
  readonly appId: string
  readonly roomId: string
  readonly topic: Hex
  readonly sid = randomId(8)
  readonly topology: Topology
  readonly clock: Clock
  private key: Uint8Array
  private signaling: SignalingAdapter
  private unsubSignal: Unsubscribe | null = null
  private presence = new Map<Hex, Presence>()
  private sessions = new Map<Hex, SessionEntry>()
  private virtual = new Map<Hex, VirtualPeer>()
  private members = new Map<Hex, Peer>()
  private attempts = new Map<Hex, AttemptState>()
  private pipes = new Map<string, Pipe>()
  private links = new Set<Link>()
  private hostKey: Hex | null = null
  private announceTimer: unknown = null
  private tickTimer: unknown = null
  private quickAnnounce: unknown = null
  private lastKnock = new Map<Hex, number>()
  private left = false
  private store: StateStore
  private observers = new Set<Hex>()
  private telemetryUnsub: Unsubscribe | null = null
  private fileSeq = 0
  private incoming = new Map<string, { file: IncomingFileImpl; from: Hex }>()
  private pending = new Map<
    string,
    { resolve(v: unknown): void; reject(e: Error): void; to: Hex; name: string }
  >()
  private handlers = new Map<string, (input: unknown, from: Hex) => unknown>()
  private actionL = new Map<string, Listeners<[unknown, Hex]>>()
  private joinL = new Listeners<[Peer]>()
  private leaveL = new Listeners<[Peer]>()
  private updateL = new Listeners<[Peer]>()
  private hostL = new Listeners<[Hex | null]>()
  private fileL = new Listeners<[IncomingFile]>()
  private bus: TelemetryBus
  private t: Required<NonNullable<RoomOptions['timeouts']>>

  constructor(
    private opts: RoomOptions<P>,
    readonly self: Identity,
  ) {
    this.appId = opts.appId
    this.roomId = opts.roomId
    this.topic = roomTopic(opts.appId, opts.roomId, opts.password)
    this.key = roomKey(opts.appId, opts.roomId, opts.password)
    this.topology = opts.topology ?? 'mesh'
    this.clock = opts.clock ?? realClock
    this.t = {
      connectMs: 15_000,
      handshakeMs: 10_000,
      resumeWindowMs: 30_000,
      pingIntervalMs: 5_000,
      tickMs: 1_000,
      ...opts.timeouts,
    }
    const factories = Array.isArray(opts.signaling) ? opts.signaling : [opts.signaling]
    const adapters = factories.map((f) => f({ identity: self }))
    this.signaling =
      adapters.length === 1 ? (adapters[0] as SignalingAdapter) : unionAdapters(adapters)
    this.bus = new TelemetryBus(opts.telemetry !== false, () => this.clock.now())
    this.store = new StateStore(
      self.pubkey,
      () => this.clock.now(),
      (op) => this.broadcastStateOp(op),
    )
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    this.unsubSignal = this.signaling.subscribe(this.topic, (s) => this.onSignal(s))
    this.recomputeHost()
    this.announce()
    this.scheduleTick()
    this.telemetryUnsub = this.bus.subscribe((e) => this.forwardTelemetry(e))
  }

  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    for (const e of this.sessions.values()) e.session.sendBye('leave')
    await this.announce(true).catch(() => {})
    this.unsubSignal?.()
    this.telemetryUnsub?.()
    for (const h of [this.announceTimer, this.tickTimer, this.quickAnnounce])
      if (h !== null) this.clock.clearTimeout(h)
    for (const [pk, e] of [...this.sessions]) {
      if (e.resumeTimer !== null) this.clock.clearTimeout(e.resumeTimer)
      e.session.close('leave')
      this.sessions.delete(pk)
    }
    for (const l of this.links) l.kill('leave')
    for (const p of this.pipes.values()) p.closed = true
    this.pipes.clear()
    for (const p of this.pending.values()) p.reject(new Error('room left'))
    this.pending.clear()
    for (const { file } of this.incoming.values()) file.fail(new Error('room left'))
    this.incoming.clear()
    this.virtual.clear()
    for (const pk of [...this.members.keys()]) this.refreshMember(pk)
    await this.signaling.close()
  }

  // ------------------------------------------------------------ telemetry helpers

  private tel(e: TelemetryInput): void {
    this.bus.emit(e)
  }

  // ------------------------------------------------------------ signaling: announces

  private async announce(leave = false): Promise<void> {
    if (this.announceTimer !== null) this.clock.clearTimeout(this.announceTimer)
    this.announceTimer = null
    if (this.left && !leave) return
    const payload: AnnouncePayload = {
      v: PROTOCOL_VERSION,
      pubkey: this.self.pubkey,
      sid: this.sid,
      attestations: this.self.attestations,
      meta: this.opts.meta ?? {},
      ttl: ANNOUNCE_TTL_S,
      ts: Math.floor(this.clock.now() / 1000),
      ...(this.opts.capability ? { cap: this.opts.capability } : {}),
      ...(leave ? { leave: true } : {}),
    }
    const nonce = randomBytes(12)
    const ct = gcm(this.key, nonce).encrypt(utf8ToBytes(JSON.stringify(payload)))
    this.tel({ type: 'signal', direction: 'out', kind: 'announce' })
    if (!leave)
      this.announceTimer = this.clock.setTimeout(
        () => void this.announce(),
        ANNOUNCE_INTERVAL_S * 1000,
      )
    try {
      await this.signaling.announce(this.topic, toBase64(concatBytes(nonce, ct)))
    } catch (err) {
      this.tel({ type: 'error', code: 'signaling', message: (err as Error).message })
    }
  }

  private announceSoon(): void {
    if (this.quickAnnounce !== null || this.left) return
    this.quickAnnounce = this.clock.setTimeout(() => {
      this.quickAnnounce = null
      void this.announce()
    }, 20)
  }

  private onSignal(s: Signal): void {
    if (this.left || s.from === this.self.pubkey) return
    if (s.kind === 'announce') this.onAnnounce(s)
    else void this.onDirect(s)
  }

  private onAnnounce(s: Signal): void {
    let p: AnnouncePayload
    try {
      const raw = fromBase64(s.content)
      const pt = gcm(this.key, raw.subarray(0, 12)).decrypt(raw.subarray(12))
      p = JSON.parse(bytesToUtf8(pt))
    } catch {
      return // not for this room key (wrong password) or garbage
    }
    if (p.pubkey !== s.from || p.v !== PROTOCOL_VERSION) return
    this.tel({ type: 'signal', direction: 'in', kind: 'announce', peer: s.from })
    const now = this.clock.now()
    if (p.leave) {
      this.presence.delete(p.pubkey)
      this.recomputeHost()
      return
    }
    if ((p.ts + Math.min(p.ttl, ANNOUNCE_TTL_S)) * 1000 < now - 5000) return // stale
    const isNew = !this.presence.has(p.pubkey)
    this.presence.set(p.pubkey, {
      pubkey: p.pubkey,
      sid: p.sid,
      meta: p.meta ?? {},
      attestations: p.attestations ?? [],
      expiresAt: now + Math.min(p.ttl, ANNOUNCE_TTL_S) * 1000,
    })
    if (isNew) {
      this.recomputeHost()
      this.announceSoon() // let the newcomer discover us without waiting a full interval
    }
    const entry = this.sessions.get(p.pubkey)
    if (entry && entry.session.sid !== p.sid && entry.session.state === 'away') {
      // The peer restarted: its old session can never resume.
      this.dropSession(p.pubkey, 'restarted')
    }
    this.ensure(p.pubkey, true)
  }

  // ------------------------------------------------------------ signaling: directed

  private pipeKey(remote: Hex, tr: string, at: string): string {
    return `${remote}|${tr}|${at}`
  }

  private async sendDirect(remote: Hex, tr: string, at: string, m: TransportSignal): Promise<void> {
    if (this.left) return
    const body: DirectPayload = { v: PROTOCOL_VERSION, tr, at, m }
    this.tel({ type: 'signal', direction: 'out', kind: m.type, peer: remote })
    try {
      const content = await this.self.encrypt(remote, JSON.stringify(body))
      await this.signaling.send(this.topic, remote, content)
    } catch (err) {
      this.tel({ type: 'error', peer: remote, code: 'signaling', message: (err as Error).message })
    }
  }

  private async onDirect(s: Signal): Promise<void> {
    let body: DirectPayload
    try {
      body = JSON.parse(await this.self.decrypt(s.from, s.content))
    } catch {
      return
    }
    if (this.left || !body || body.v !== PROTOCOL_VERSION || typeof body.tr !== 'string' || !body.m)
      return
    this.tel({ type: 'signal', direction: 'in', kind: body.m.type, peer: s.from })
    if (body.tr === TR_CONTROL) {
      if (body.m.type === 'knock') {
        // The peer has no live link to us. If ours looks alive and is not brand new, it is stale
        // (e.g. the far side of a dropped relay socket): drop it so the session resumes on a fresh one.
        const e = this.sessions.get(s.from)
        const link = e?.session.link
        if (
          e &&
          link &&
          e.session.state === 'connected' &&
          this.clock.now() - e.attachedAt > 2000
        ) {
          link.kill('peer reported link down')
        }
        const a = this.attempts.get(s.from)
        if (a) a.nextAt = 0
        this.ensure(s.from, true)
      }
      return
    }
    const key = this.pipeKey(s.from, body.tr, String(body.at))
    const existing = this.pipes.get(key)
    if (existing) {
      existing.deliver(body.m)
      return
    }
    // A new attempt from a peer that initiates towards us.
    if (compareHex(s.from, this.self.pubkey) >= 0) return
    const transport = this.opts.transports.find((t) => t.name === body.tr)
    if (!transport) return
    const pipe = this.makePipe(s.from, body.tr, String(body.at))
    pipe.deliver(body.m)
    void this.runResponder(s.from, transport, String(body.at), pipe)
  }

  private makePipe(remote: Hex, tr: string, at: string): Pipe {
    const key = this.pipeKey(remote, tr, at)
    const pipe = new Pipe((m) => void this.sendDirect(remote, tr, at, m))
    this.pipes.set(key, pipe)
    return pipe
  }

  private closePipe(remote: Hex, tr: string, at: string): void {
    const key = this.pipeKey(remote, tr, at)
    const p = this.pipes.get(key)
    if (p) p.closed = true
    this.pipes.delete(key)
  }

  // ------------------------------------------------------------ topology

  get host(): Hex | null {
    return this.hostKey
  }

  private recomputeHost(): void {
    if (this.topology === 'mesh') return
    const present = new Set<Hex>([this.self.pubkey, ...this.presence.keys()])
    for (const [pk, e] of this.sessions) if (e.session.state === 'connected') present.add(pk)
    const explicit = this.topology.star.host
    let host: Hex
    if (explicit && present.has(explicit)) host = explicit
    else host = [...present].sort(compareHex)[0] as Hex
    if (host === this.hostKey) return
    const prev = this.hostKey
    this.hostKey = host
    this.tel({ type: 'host', host })
    this.hostL.emit(host)
    if (prev !== null) {
      // Roster entries from the previous host get a grace period to be confirmed by the new one.
      for (const v of this.virtual.values()) {
        v.confirmedAt = this.clock.now()
        v.listed = false
      }
    }
    for (const pk of new Set([...this.members.keys(), ...this.sessions.keys()]))
      this.refreshMember(pk)
    if (host === this.self.pubkey) this.sendRoster()
    for (const pk of this.presence.keys()) this.ensure(pk, true)
  }

  private isHost(): boolean {
    return this.topology !== 'mesh' && this.hostKey === this.self.pubkey
  }

  private wanted(remote: Hex): boolean {
    if (this.left) return false
    if (this.topology === 'mesh') return true
    return this.isHost() || remote === this.hostKey
  }

  // ------------------------------------------------------------ connection manager

  private scheduleTick(): void {
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null
      if (this.left) return
      this.tick()
      this.scheduleTick()
    }, this.t.tickMs)
  }

  private tick(): void {
    const now = this.clock.now()
    let changed = false
    for (const [pk, p] of this.presence) {
      if (p.expiresAt < now) {
        this.presence.delete(pk)
        changed = true
      }
    }
    if (changed) this.recomputeHost()
    for (const pk of this.presence.keys()) this.ensure(pk, false)
    // Star: prune direct sessions the topology no longer wants (e.g. made before the host was known).
    if (this.topology !== 'mesh') {
      for (const [pk, e] of [...this.sessions]) {
        if (this.wanted(pk) || e.session.state !== 'connected') {
          e.unwantedSince = null
          continue
        }
        e.unwantedSince ??= now
        if (now - e.unwantedSince >= 2 * this.t.tickMs) {
          e.session.sendBye('topology')
          this.demote(pk)
          this.dropSession(pk, 'topology')
        }
      }
    }
    // Virtual (roster) peers that nobody confirms anymore.
    for (const [pk, v] of [...this.virtual]) {
      const stale = !v.listed && now - v.confirmedAt > this.t.resumeWindowMs
      if (stale || !this.presence.has(pk)) {
        this.virtual.delete(pk)
        this.refreshMember(pk)
      }
    }
    if (this.bus.enabled) {
      for (const [pk, e] of this.sessions) {
        const l = e.session.link
        if (l)
          this.tel({
            type: 'bytes',
            peer: pk,
            channel: 'session',
            sent: l.bytes.sent,
            received: l.bytes.received,
          })
      }
    }
  }

  /** Make sure we are (re)connecting to `remote` if the topology wants it. */
  private ensure(remote: Hex, urgent: boolean): void {
    if (this.left || remote === this.self.pubkey || !this.wanted(remote)) return
    const entry = this.sessions.get(remote)
    if (entry?.session.state === 'connected') return
    const iAmInitiator = compareHex(this.self.pubkey, remote) < 0
    const now = this.clock.now()
    if (!iAmInitiator) {
      // Nudge the initiator (rate-limited) so recovery doesn't wait for its backoff.
      const last = this.lastKnock.get(remote) ?? 0
      if (now - last >= (urgent ? 1000 : 3000)) {
        this.lastKnock.set(remote, now)
        void this.sendDirect(remote, TR_CONTROL, '', { type: 'knock' })
      }
      return
    }
    let a = this.attempts.get(remote)
    if (!a) {
      a = { running: false, failures: 0, nextAt: 0 }
      this.attempts.set(remote, a)
    }
    if (a.running || now < a.nextAt) return
    a.running = true
    const state = a
    void this.runInitiator(remote).then((ok) => {
      state.running = false
      if (ok) {
        state.failures = 0
        state.nextAt = 0
      } else {
        state.failures++
        state.nextAt = this.clock.now() + Math.min(500 * 2 ** (state.failures - 1), 8000)
      }
    })
  }

  private async runInitiator(remote: Hex): Promise<boolean> {
    const ladder = this.opts.transports
    if (ladder.length === 0) return false
    const relay = this.opts.relayFirst ? ladder.find((t) => t.name === 'relay') : undefined
    if (relay && ladder.length > 1) {
      const rest = ladder.filter((t) => t !== relay)
      const r1 = this.tryRung(remote, relay)
      const r2 = (async () => {
        for (const t of rest) if (await this.tryRung(remote, t)) return true
        return false
      })()
      const [a, b] = await Promise.all([r1, r2])
      return a || b
    }
    for (const t of ladder) {
      if (this.left || !this.wanted(remote)) return false
      if (await this.tryRung(remote, t)) return true
    }
    return false
  }

  private async tryRung(remote: Hex, transport: Transport): Promise<boolean> {
    const at = randomId(6)
    const pipe = this.makePipe(remote, transport.name, at)
    const ac = new AbortController()
    try {
      const conn = await withTimeout(
        this.clock,
        transport.connect(remote, {
          initiator: true,
          pipe,
          local: this.self,
          signal: ac.signal,
          ...(this.opts.iceServers ? { iceServers: this.opts.iceServers } : {}),
        }),
        this.t.connectMs,
        `${transport.name} connect`,
        () => ac.abort(),
      )
      if (this.left) {
        conn.close()
        return false
      }
      const link = new Link(conn, transport.name, true)
      return await this.onLink(remote, link, () => this.closePipe(remote, transport.name, at))
    } catch (err) {
      this.closePipe(remote, transport.name, at)
      this.tel({
        type: 'error',
        peer: remote,
        code: `connect:${transport.name}`,
        message: (err as Error).message,
      })
      return false
    }
  }

  private async runResponder(
    remote: Hex,
    transport: Transport,
    at: string,
    pipe: Pipe,
  ): Promise<void> {
    const ac = new AbortController()
    try {
      const conn = await withTimeout(
        this.clock,
        transport.connect(remote, {
          initiator: false,
          pipe,
          local: this.self,
          signal: ac.signal,
          ...(this.opts.iceServers ? { iceServers: this.opts.iceServers } : {}),
        }),
        this.t.connectMs,
        `${transport.name} accept`,
        () => ac.abort(),
      )
      if (this.left) {
        conn.close()
        return
      }
      await this.onLink(remote, new Link(conn, transport.name, false), () =>
        this.closePipe(remote, transport.name, at),
      )
    } catch (err) {
      this.closePipe(remote, transport.name, at)
      this.tel({
        type: 'error',
        peer: remote,
        code: `accept:${transport.name}`,
        message: (err as Error).message,
      })
    }
  }

  /** Handshake a fresh link and attach it to the peer's session. */
  private async onLink(remote: Hex, link: Link, cleanup: () => void): Promise<boolean> {
    this.links.add(link)
    link.onDead(() => {
      this.links.delete(link)
      cleanup()
    })
    this.tel({ type: 'connection', peer: remote, state: 'connecting', path: link.path })
    try {
      const hs = await withTimeout(
        this.clock,
        this.handshake(remote, link),
        this.t.handshakeMs,
        'handshake',
        () => link.kill('handshake timeout'),
      )
      if (this.left || link.dead) {
        link.kill('left')
        return false
      }
      this.attach(remote, link, hs)
      return true
    } catch (err) {
      link.kill((err as Error).message)
      this.tel({ type: 'error', peer: remote, code: 'handshake', message: (err as Error).message })
      return false
    }
  }

  private handshake(remote: Hex, link: Link): Promise<HandshakeResult> {
    return new Promise<HandshakeResult>((resolve, reject) => {
      const nonce = randomBytes(32)
      const existing = this.sessions.get(remote)
      const hello: Hello = {
        v: PROTOCOL_VERSION,
        pubkey: this.self.pubkey,
        sid: this.sid,
        topic: this.topic,
        nonce,
        attestations: [...this.self.attestations],
        meta: this.opts.meta ?? {},
        ...(this.opts.capability ? { cap: this.opts.capability } : {}),
        ...(existing
          ? { known: { sid: existing.session.sid, recv: existing.session.recvCursor() } }
          : {}),
      }
      const myHello = encodeCbor(['h1', hello])
      let theirs: {
        hello: Hello
        bytes: Uint8Array
        verified: AttestationResult[]
        caps: Capability[]
      } | null = null
      let theirSig: Uint8Array | null = null
      let sentSig = false
      let done = false
      const backlog: [Frame, Lane][] = []
      const fail = (msg: string) => {
        if (done) return
        done = true
        unFrame()
        unDead()
        reject(new Error(msg))
      }
      const maybeDone = () => {
        if (done || !theirs || !theirSig || !sentSig) return
        const h = transcript(
          this.topic,
          remote,
          this.self.pubkey,
          theirs.hello.nonce,
          nonce,
          theirs.bytes,
        )
        if (!schnorrVerify(theirSig, h, remote)) return fail('bad handshake signature')
        done = true
        unFrame()
        unDead()
        resolve({ hello: theirs.hello, verified: theirs.verified, caps: theirs.caps, backlog })
      }
      const unDead = link.onDead((r) => fail(`link died during handshake: ${r}`))
      const unFrame = link.onFrame((f, lane) => {
        if (done) return
        if (f.type === FrameType.Close) {
          let reason = 'rejected'
          try {
            reason = String((decodeCbor(f.payload) as unknown[])[0])
          } catch {}
          return fail(`peer closed: ${reason}`)
        }
        if (f.type !== FrameType.Hello) {
          backlog.push([f, lane])
          return
        }
        let m: unknown[]
        try {
          m = decodeCbor(f.payload) as unknown[]
        } catch {
          return fail('bad handshake frame')
        }
        if (m[0] === 'h1' && !theirs) {
          const h = m[1] as Hello
          if (!h || h.v !== PROTOCOL_VERSION) return fail('unsupported version')
          if (h.pubkey !== remote) return fail('unexpected identity')
          if (h.topic !== this.topic) return fail('wrong room')
          if (!(h.nonce instanceof Uint8Array) || h.nonce.length !== 32) return fail('bad nonce')
          const bytes = f.payload.slice()
          void this.admit(h).then(
            async (res) => {
              if (done) return
              if (!res.ok) {
                link.send('r', FrameType.Close, 0, encodeCbor([`rejected: ${res.reason}`]))
                return fail(`rejected peer: ${res.reason}`)
              }
              theirs = { hello: h, bytes, verified: res.verified, caps: res.caps }
              const sig = await this.self.sign(
                transcript(this.topic, this.self.pubkey, remote, nonce, h.nonce, myHello),
              )
              if (done) return
              link.send('r', FrameType.Hello, 0, encodeCbor(['h2', sig]))
              sentSig = true
              maybeDone()
            },
            (err) => fail(`admission error: ${(err as Error).message}`),
          )
        } else if (m[0] === 'h2') {
          if (!(m[1] instanceof Uint8Array)) return fail('bad signature frame')
          theirSig = m[1]
          maybeDone()
        }
      })
      link.onOpen(() => {
        if (!done) link.send('r', FrameType.Hello, 0, myHello)
      })
    })
  }

  private async admit(
    h: Hello,
  ): Promise<
    { ok: true; verified: AttestationResult[]; caps: Capability[] } | { ok: false; reason: string }
  > {
    const policy = this.opts.policy ?? {}
    const atts = Array.isArray(h.attestations) ? h.attestations : []
    const verified = await Promise.all(
      atts.map((a) => verifyAttestation(a, h.pubkey, policy.jwks ? { jwks: policy.jwks } : {})),
    )
    const bad = verified.find((v) => !v.ok)
    if (bad && !bad.ok)
      return { ok: false, reason: `invalid ${bad.type} attestation: ${bad.reason}` }
    if (policy.attest) {
      const at = policy.attest
      const oidcIss = at.oidc ? (Array.isArray(at.oidc.iss) ? at.oidc.iss : [at.oidc.iss]) : []
      const allowed = verified.some((v) => {
        if (!v.ok) return false
        if (v.type === 'anonymous') return !!at.anonymous
        if (v.type === 'nostr') {
          if (!at.nostr) return false
          return at.nostr === true || at.nostr.pubkeys.includes(v.nostrPubkey as Hex)
        }
        if (v.type === 'oidc') {
          if (!at.oidc || !oidcIss.includes(v.issuer as string)) return false
          return !at.oidc.sub || at.oidc.sub.includes(v.subject as string)
        }
        return false
      })
      if (!allowed) return { ok: false, reason: 'no acceptable attestation' }
    }
    let caps: Capability[] = []
    if (h.cap) {
      const issuers = [...(policy.capabilities?.issuers ?? [])]
      if (this.hostKey) issuers.push(this.hostKey)
      const r = verifyCapability(h.cap, {
        room: this.topic,
        pubkey: h.pubkey,
        issuers,
        ...(policy.dev ? { dev: true } : {}),
        now: Math.floor(this.clock.now() / 1000),
      })
      if (r.ok) caps = r.caps
    }
    for (const c of policy.capabilities?.require ?? []) {
      if (!caps.includes(c)) return { ok: false, reason: `missing capability ${c}` }
    }
    const candidate: PeerCandidate = {
      pubkey: h.pubkey,
      meta: h.meta ?? {},
      attestations: atts,
      verified: verified.filter((v) => v.ok),
      caps,
    }
    if (policy.admit && !(await policy.admit(candidate)))
      return { ok: false, reason: 'denied by policy' }
    return { ok: true, verified: candidate.verified, caps }
  }

  // ------------------------------------------------------------ sessions

  private attach(remote: Hex, link: Link, hs: HandshakeResult): void {
    let entry = this.sessions.get(remote)
    if (entry && entry.session.sid !== hs.hello.sid) {
      this.dropSession(remote, 'restarted')
      entry = undefined
    }
    const recv = hs.hello.known && hs.hello.known.sid === this.sid ? hs.hello.known.recv : undefined
    if (!entry) {
      const session = new Session(remote, hs.hello.sid, {
        clock: this.clock,
        pingIntervalMs: this.t.pingIntervalMs,
      })
      entry = {
        session,
        hello: hs.hello,
        verified: hs.verified,
        caps: hs.caps,
        transport: link.transport,
        resumeTimer: null,
        attachedAt: this.clock.now(),
      }
      this.sessions.set(remote, entry)
      this.wireSession(remote, entry)
      session.attach(link, recv, hs.backlog)
      this.tel({ type: 'connection', peer: remote, state: 'connected', path: link.path })
      this.tel({ type: 'path', peer: remote, path: link.path })
      this.recomputeHost()
      this.refreshMember(remote)
      this.afterJoin(remote)
      return
    }
    const s = entry.session
    const cur = s.link
    if (cur && cur !== link && cur.open && link.rank < cur.rank) {
      link.kill('redundant (worse path)')
      return
    }
    const wasAway = s.state === 'away'
    entry.hello = hs.hello
    entry.verified = hs.verified
    entry.caps = hs.caps
    entry.transport = link.transport
    entry.attachedAt = this.clock.now()
    if (entry.resumeTimer !== null) {
      this.clock.clearTimeout(entry.resumeTimer)
      entry.resumeTimer = null
    }
    s.attach(link, recv, hs.backlog)
    if (wasAway) this.tel({ type: 'connection', peer: remote, state: 'back', path: link.path })
    this.tel({ type: 'path', peer: remote, path: link.path })
    this.recomputeHost()
    this.refreshMember(remote, true)
    if (this.isHost()) this.sendRoster()
  }

  private wireSession(remote: Hex, entry: SessionEntry): void {
    const s = entry.session
    s.events.message.add((bytes, lane) => this.onMessage(remote, bytes, lane))
    s.events.rtt.add((ms) => {
      this.tel({ type: 'rtt', peer: remote, ms })
      this.refreshMember(remote, true)
    })
    s.events.progress.add((dir, streamId, done, total) => {
      this.tel({
        type: 'progress',
        peer: remote,
        streamId: dir === 'out' ? streamId : -streamId,
        sent: done,
        total,
      })
    })
    s.events.bye.add((reason) => {
      if (reason === 'topology') {
        // The peer pruned a session the star topology doesn't need; it stays a member via the host.
        this.demote(remote)
        this.dropSession(remote, 'topology')
        return
      }
      this.presence.delete(remote)
      this.virtual.delete(remote)
      this.dropSession(remote, 'left')
      this.recomputeHost()
    })
    s.events.linkLost.add((reason) => {
      if (this.sessions.get(remote) !== entry) return
      this.tel({ type: 'connection', peer: remote, state: 'away' })
      this.tel({ type: 'error', peer: remote, code: 'link-lost', message: reason })
      this.refreshMember(remote, true)
      if (entry.resumeTimer !== null) this.clock.clearTimeout(entry.resumeTimer)
      entry.resumeTimer = this.clock.setTimeout(() => {
        entry.resumeTimer = null
        if (this.sessions.get(remote) === entry && entry.session.state === 'away')
          this.dropSession(remote, 'timeout')
      }, this.t.resumeWindowMs)
      const a = this.attempts.get(remote)
      if (a) a.nextAt = 0
      this.ensure(remote, true)
    })
  }

  private dropSession(remote: Hex, reason: string): void {
    const entry = this.sessions.get(remote)
    if (!entry) return
    this.sessions.delete(remote)
    if (entry.resumeTimer !== null) this.clock.clearTimeout(entry.resumeTimer)
    entry.session.close(reason)
    this.observers.delete(remote)
    this.tel({ type: 'connection', peer: remote, state: 'closed' })
    for (const [id, p] of this.pending) {
      if (p.to === remote) {
        this.pending.delete(id)
        p.reject(new Error(`peer ${reason}`))
      }
    }
    for (const [id, f] of this.incoming) {
      if (f.from === remote && (this.topology === 'mesh' || reason !== 'timeout')) {
        f.file.fail(new Error(`peer ${reason}`))
        this.incoming.delete(id)
      }
    }
    this.refreshMember(remote)
    if (this.isHost()) this.sendRoster()
  }

  /** Keep a peer as a roster member while its direct session is dropped for topology reasons. */
  private demote(remote: Hex): void {
    const e = this.sessions.get(remote)
    if (!e || !this.presence.has(remote) || this.virtual.has(remote)) return
    this.virtual.set(remote, {
      pubkey: remote,
      meta: e.hello.meta ?? {},
      attestations: e.hello.attestations ?? [],
      caps: e.caps,
      confirmedAt: this.clock.now(),
      listed: false,
    })
  }

  private afterJoin(remote: Hex): void {
    // Late joiner catch-up: ask the new peer for its state (mesh, or host <-> client in star).
    void this.sendTo([remote], { a: STATE_REQ }, 0, 1).catch(() => {})
    if (this.isHost()) this.sendRoster()
  }

  // ------------------------------------------------------------ membership

  private peerFrom(pk: Hex): Peer | null {
    const e = this.sessions.get(pk)
    const v = this.virtual.get(pk)
    const isHost = this.topology !== 'mesh' && this.hostKey === pk
    if (e) {
      return {
        pubkey: pk,
        meta: e.hello.meta ?? {},
        attestations: e.hello.attestations ?? [],
        verified: e.verified,
        caps: e.caps,
        state: e.session.state,
        via: 'direct',
        path: e.session.link?.path ?? null,
        rttMs: e.session.rttMs,
        isHost,
      }
    }
    if (v) {
      return {
        pubkey: pk,
        meta: v.meta,
        attestations: v.attestations,
        verified: [],
        caps: v.caps,
        state: 'connected',
        via: 'host',
        path: null,
        rttMs: undefined,
        isHost,
      }
    }
    return null
  }

  private refreshMember(pk: Hex, update = false): void {
    const prev = this.members.get(pk)
    const next = this.left ? null : this.peerFrom(pk)
    if (!prev && next) {
      this.members.set(pk, next)
      this.tel({ type: 'peer', peer: pk, event: 'join' })
      this.joinL.emit(next)
    } else if (prev && !next) {
      this.members.delete(pk)
      this.tel({ type: 'peer', peer: pk, event: 'leave' })
      this.leaveL.emit(prev)
    } else if (prev && next) {
      this.members.set(pk, next)
      if (
        update ||
        prev.state !== next.state ||
        prev.via !== next.via ||
        prev.path !== next.path ||
        prev.isHost !== next.isHost
      ) {
        this.updateL.emit(next)
      }
    }
  }

  get peers(): readonly Peer[] {
    return [...this.members.values()]
  }

  peer(pubkey: Hex): Peer | undefined {
    return this.members.get(pubkey)
  }

  onPeerJoin(cb: (peer: Peer) => void): Unsubscribe {
    return this.joinL.add(cb)
  }
  onPeerLeave(cb: (peer: Peer) => void): Unsubscribe {
    return this.leaveL.add(cb)
  }
  onPeerUpdate(cb: (peer: Peer) => void): Unsubscribe {
    return this.updateL.add(cb)
  }
  onHostChange(cb: (host: Hex | null) => void): Unsubscribe {
    return this.hostL.add(cb)
  }

  private sendRoster(): void {
    if (!this.isHost()) return
    const peers = [...this.sessions.entries()].map(([pk, e]) => ({
      pubkey: pk,
      meta: e.hello.meta ?? {},
      attestations: e.hello.attestations ?? [],
      caps: e.caps,
    }))
    for (const pk of this.sessions.keys()) {
      void this.sendTo([pk], { a: ROSTER, d: peers }, 0, 1).catch(() => {})
    }
  }

  private onRoster(from: Hex, list: unknown): void {
    if (from !== this.hostKey || !Array.isArray(list)) return
    const now = this.clock.now()
    const seen = new Set<Hex>()
    for (const item of list as VirtualPeer[]) {
      if (!item || typeof item.pubkey !== 'string' || item.pubkey === this.self.pubkey) continue
      seen.add(item.pubkey)
      this.virtual.set(item.pubkey, {
        pubkey: item.pubkey,
        meta: item.meta ?? {},
        attestations: item.attestations ?? [],
        caps: item.caps ?? [],
        confirmedAt: now,
        listed: true,
      })
      this.refreshMember(item.pubkey)
    }
    for (const pk of [...this.virtual.keys()]) {
      const v = this.virtual.get(pk)
      if (v && !seen.has(pk) && v.listed) {
        v.listed = false
        v.confirmedAt = now
      }
      // Missing from the roster but still announcing: likely mid-handoff, let the sweep decide.
      if (!seen.has(pk) && !this.presence.has(pk)) {
        this.virtual.delete(pk)
        this.refreshMember(pk)
      }
    }
  }

  // ------------------------------------------------------------ messaging

  private resolveTargets(to: Target | undefined): Hex[] | 'all' {
    if (to === undefined || to === 'all') return 'all'
    return Array.isArray(to) ? to : [to]
  }

  /**
   * Route a message: mesh/host send to each target directly; star clients send through the host,
   * which forwards. Resolves when every next hop acknowledged.
   */
  private sendTo(
    targets: Hex[] | 'all',
    msg: Msg,
    lane: SeqLane | 'x',
    priority: PriorityLevel,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    if (this.left) return Promise.reject(new Error('room left'))
    const starClient = this.topology !== 'mesh' && !this.isHost()
    const hops = new Map<Hex, Msg>()
    if (starClient) {
      const host = this.hostKey
      const hostEntry = host ? this.sessions.get(host) : undefined
      if (targets === 'all') {
        if (hostEntry) hops.set(host as Hex, msg)
      } else {
        const viaHost: Hex[] = []
        for (const t of targets) {
          if (t === host && hostEntry) hops.set(t, msg)
          else if (this.sessions.get(t)?.session.state === 'connected' && !hostEntry)
            hops.set(t, msg)
          else viaHost.push(t)
        }
        if (viaHost.length && hostEntry) {
          const prev = hops.get(host as Hex)
          hops.set(host as Hex, { ...msg, t: prev ? [...viaHost, host as Hex] : viaHost })
        }
      }
    } else {
      const list =
        targets === 'all' ? [...this.sessions.keys()] : targets.filter((t) => this.sessions.has(t))
      for (const t of list) hops.set(t, msg)
    }
    if (hops.size === 0) return Promise.resolve()
    const ps: Promise<void>[] = []
    for (const [pk, m] of hops) {
      const entry = this.sessions.get(pk)
      if (!entry) continue
      const bytes = encodeCbor(m)
      this.noteOut(pk, m, bytes.length)
      ps.push(entry.session.send(bytes, { lane, priority, ...(onProgress ? { onProgress } : {}) }))
    }
    const all = Promise.all(ps).then(() => undefined)
    all.catch(() => {})
    return all
  }

  private noteOut(peer: Hex, m: Msg, size: number): void {
    if (!this.bus.enabled || m.a === TELEMETRY_CHANNEL) return
    this.tel({
      type: 'message',
      peer,
      direction: 'out',
      action: m.a,
      size,
      ...(this.opts.telemetryPayloads !== false && !m.a.startsWith('__file')
        ? { payload: m.d }
        : {}),
    })
  }

  private onMessage(sender: Hex, bytes: Uint8Array, lane: SeqLane | 'x'): void {
    let m: Msg
    try {
      m = decodeCbor(bytes) as Msg
    } catch {
      return
    }
    if (!m || typeof m.a !== 'string') return
    let origin = sender
    if (this.isHost()) {
      // Host-authoritative routing: stamp the true origin and forward.
      const targets = Array.isArray(m.t) ? m.t : null
      const fwd: Msg = { ...m, o: sender }
      delete fwd.t
      const lvl = this.priorityFor(m.a)
      const dests = targets
        ? targets.filter((t) => t !== this.self.pubkey && t !== sender)
        : [...this.sessions.keys()].filter((t) => t !== sender)
      for (const d of dests) {
        const e = this.sessions.get(d)
        if (!e) continue
        const b = encodeCbor(fwd)
        this.noteOut(d, fwd, b.length)
        void e.session.send(b, { lane, priority: lvl }).catch(() => {})
      }
      if (targets && !targets.includes(this.self.pubkey)) return
    } else if (m.o && sender === this.hostKey && this.topology !== 'mesh') {
      origin = m.o
    }
    if (this.bus.enabled && m.a !== TELEMETRY_CHANNEL) {
      this.tel({
        type: 'message',
        peer: origin,
        direction: 'in',
        action: m.a,
        size: bytes.length,
        ...(this.opts.telemetryPayloads !== false && !m.a.startsWith('__file')
          ? { payload: m.d }
          : {}),
      })
    }
    this.deliver(origin, sender, m)
  }

  private priorityFor(name: string): PriorityLevel {
    if (name.startsWith('__file')) return 3
    if (name.startsWith('__')) return 1
    const def = this.opts.protocol?.[name] as ActionDef | RequestDef | undefined
    return def ? priorityLevel(def.priority) : 2
  }

  private deliver(from: Hex, sender: Hex, m: Msg): void {
    switch (m.a) {
      case STATE_OP:
        this.store.apply(m.d as StateOp, true)
        return
      case STATE_REQ:
        void this.sendTo([from], { a: STATE_SNAP, d: this.store.snapshot() }, 0, 2).catch(() => {})
        return
      case STATE_SNAP:
        this.store.merge(m.d as StateSnapshot)
        return
      case ROSTER:
        if (from === sender) this.onRoster(from, m.d)
        return
      case FILE_START:
      case FILE_CHUNK:
      case FILE_END:
        this.onFileMsg(from, m)
        return
      case TELEMETRY_CHANNEL:
        this.onTelemetryMsg(from, m.d)
        return
    }
    if (m.a.startsWith('__')) return
    if (m.r !== undefined) {
      this.onResponse(from, m)
      return
    }
    if (m.q !== undefined) {
      this.onRequest(from, m)
      return
    }
    const def = this.opts.protocol?.[m.a] as ActionDef | undefined
    const emit = (value: unknown) => this.actionL.get(m.a)?.emit(value, from)
    if (this.opts.protocol && (!def || def.kind !== 'action')) {
      this.tel({ type: 'error', peer: from, code: 'unknown-action', message: m.a })
      return
    }
    if (!def) {
      emit(m.d)
      return
    }
    this.validateThen(def.schema, m.d, emit, (msg) =>
      this.tel({ type: 'error', peer: from, code: 'invalid-payload', message: `${m.a}: ${msg}` }),
    )
  }

  private validateThen(
    schema: StandardSchemaV1,
    value: unknown,
    ok: (v: unknown) => void,
    bad: (msg: string) => void,
  ): void {
    const handle = (r: StandardSchemaV1.Result<unknown>) => {
      if (r.issues) bad(r.issues.map((i) => i.message).join('; '))
      else ok(r.value)
    }
    const r = schema['~standard'].validate(value)
    if (r instanceof Promise) r.then(handle, (e) => bad(String(e)))
    else handle(r)
  }

  action<K extends string>(name: K): ActionHandle<any, any> {
    const def = this.opts.protocol?.[name] as ActionDef | undefined
    if (this.opts.protocol && (!def || def.kind !== 'action'))
      throw new Error(`unknown action "${name}"`)
    const reliability = def?.reliability ?? { mode: 'reliable' }
    const lane = laneFor(reliability)
    const prio = def ? priorityLevel(def.priority) : 2
    return {
      send: async (data, o = {}) => {
        let value = data
        if (def) {
          const r = await def.schema['~standard'].validate(data)
          if (r.issues) throw new Error(`${name}: ${r.issues.map((i) => i.message).join('; ')}`)
          value = r.value
        }
        await this.sendTo(
          this.resolveTargets(o.to),
          { a: name, d: value },
          lane,
          prio,
          o.onProgress,
        )
      },
      onMessage: (cb) => {
        let l = this.actionL.get(name)
        if (!l) {
          l = new Listeners()
          this.actionL.set(name, l)
        }
        return l.add(cb)
      },
    }
  }

  request<K extends string>(name: K): RequestHandle<any, any, any, any> {
    const def = this.opts.protocol?.[name] as RequestDef | undefined
    if (this.opts.protocol && (!def || def.kind !== 'request'))
      throw new Error(`unknown request "${name}"`)
    const prio = def ? priorityLevel(def.priority) : 1
    return {
      call: (to, input, o = {}) =>
        new Promise((resolve, reject) => {
          const id = randomId(8)
          const timeoutMs = o.timeoutMs ?? def?.timeoutMs ?? 10_000
          const timer = this.clock.setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`request ${name} timed out`))
          }, timeoutMs)
          this.pending.set(id, {
            to,
            name,
            resolve: (v) => {
              this.clock.clearTimeout(timer)
              resolve(v)
            },
            reject: (e) => {
              this.clock.clearTimeout(timer)
              reject(e)
            },
          })
          const go = (value: unknown) =>
            this.sendTo([to], { a: name, d: value, q: id }, 0, prio).catch((e) =>
              this.pending.get(id)?.reject(e),
            )
          if (def)
            this.validateThen(def.req, input, go, (msg) =>
              this.pending.get(id)?.reject(new Error(`${name}: ${msg}`)),
            )
          else go(input)
        }),
      handle: (fn) => {
        this.handlers.set(name, fn as (input: unknown, from: Hex) => unknown)
        return () => {
          if (this.handlers.get(name) === fn) this.handlers.delete(name)
        }
      },
    }
  }

  private onRequest(from: Hex, m: Msg): void {
    const def = this.opts.protocol?.[m.a] as RequestDef | undefined
    const reply = (res: Msg) => void this.sendTo([from], res, 0, 1).catch(() => {})
    const fail = (e: string) => reply({ a: m.a, r: m.q as string, e })
    const fn = this.handlers.get(m.a)
    if (!fn || (this.opts.protocol && def?.kind !== 'request')) {
      fail('no handler')
      return
    }
    const run = async (input: unknown) => {
      try {
        let out = await fn(input, from)
        if (def) {
          const r = await def.res['~standard'].validate(out)
          if (r.issues)
            return fail(`invalid response: ${r.issues.map((i) => i.message).join('; ')}`)
          out = r.value
        }
        reply({ a: m.a, r: m.q as string, d: out })
      } catch (err) {
        fail((err as Error).message ?? String(err))
      }
    }
    if (def)
      this.validateThen(
        def.req,
        m.d,
        (v) => void run(v),
        (msg) => fail(`invalid request: ${msg}`),
      )
    else void run(m.d)
  }

  private onResponse(from: Hex, m: Msg): void {
    const p = this.pending.get(m.r as string)
    if (!p || p.to !== from) return
    this.pending.delete(m.r as string)
    if (m.e !== undefined) {
      p.reject(new Error(m.e))
      return
    }
    const def = this.opts.protocol?.[m.a] as RequestDef | undefined
    if (!def) {
      p.resolve(m.d)
      return
    }
    this.validateThen(
      def.res,
      m.d,
      (v) => p.resolve(v),
      (msg) => p.reject(new Error(`invalid response: ${msg}`)),
    )
  }

  // ------------------------------------------------------------ files

  async sendFile(source: FileSource, o: FileSendOptions = {}): Promise<void> {
    const targets = this.resolveTargets(o.to)
    const id = randomId(8)
    const streamNo = ++this.fileSeq
    const size =
      o.size ??
      (source instanceof Uint8Array
        ? source.length
        : source instanceof Blob
          ? source.size
          : undefined)
    const name = o.name ?? ((source as { name?: string }).name || 'file')
    const mime =
      o.mime ?? (source instanceof Blob && source.type ? source.type : 'application/octet-stream')
    const acks: Promise<void>[] = []
    acks.push(this.sendTo(targets, { a: FILE_START, d: { id, name, mime, size } }, 0, 3))
    const stream: ReadableStream<Uint8Array> =
      source instanceof Uint8Array
        ? new ReadableStream({
            start(c) {
              c.enqueue(source)
              c.close()
            },
          })
        : source instanceof Blob
          ? (source.stream() as ReadableStream<Uint8Array>)
          : source
    const reader = stream.getReader()
    let sent = 0
    const hops = () => {
      if (this.topology !== 'mesh' && !this.isHost()) return this.hostKey ? [this.hostKey] : []
      return targets === 'all' ? [...this.sessions.keys()] : targets
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      for (let off = 0; off < value.length; off += FILE_PIECE) {
        const piece = value.subarray(off, Math.min(value.length, off + FILE_PIECE))
        // Backpressure: wait until the sessions drained their queues.
        await Promise.all(hops().map((h) => this.sessions.get(h)?.session.waitDrain()))
        if (this.left) throw new Error('room left')
        acks.push(this.sendTo(targets, { a: FILE_CHUNK, d: { id, b: piece } }, 0, 3))
        sent += piece.length
        o.onProgress?.(sent, size)
        for (const h of hops())
          this.tel({ type: 'progress', peer: h, streamId: streamNo, sent, total: size ?? sent })
      }
    }
    acks.push(this.sendTo(targets, { a: FILE_END, d: { id } }, 0, 3))
    await Promise.all(acks)
  }

  onFile(cb: (file: IncomingFile) => void): Unsubscribe {
    return this.fileL.add(cb)
  }

  private onFileMsg(from: Hex, m: Msg): void {
    const d = m.d as { id?: string; name?: string; mime?: string; size?: number; b?: Uint8Array }
    if (!d || typeof d.id !== 'string') return
    const key = `${from}:${d.id}`
    if (m.a === FILE_START) {
      if (this.incoming.has(key)) return
      const file = new IncomingFileImpl(
        d.id,
        from,
        String(d.name ?? 'file'),
        String(d.mime ?? 'application/octet-stream'),
        typeof d.size === 'number' ? d.size : undefined,
      )
      this.incoming.set(key, { file, from })
      this.fileL.emit(file)
      return
    }
    const entry = this.incoming.get(key)
    if (!entry) return
    if (m.a === FILE_CHUNK && d.b instanceof Uint8Array) {
      entry.file.push(d.b)
      this.tel({
        type: 'progress',
        peer: from,
        streamId: -1,
        sent: entry.file.received,
        total: entry.file.size ?? entry.file.received,
      })
    } else if (m.a === FILE_END) {
      entry.file.end()
      this.incoming.delete(key)
    }
  }

  // ------------------------------------------------------------ state

  private broadcastStateOp(op: StateOp): void {
    void this.sendTo('all', { a: STATE_OP, d: op }, 0, 2).catch(() => {})
  }

  readonly state = {
    map: <V>(name: string) => this.store.map<V>(name),
    log: <V>(name: string) => this.store.log<V>(name),
    sync: async () => {
      const targets =
        this.topology !== 'mesh' && !this.isHost()
          ? this.hostKey
            ? [this.hostKey]
            : []
          : [...this.sessions.keys()]
      await this.sendTo(targets, { a: STATE_REQ }, 0, 1)
    },
    digest: () => this.store.digest(),
  }

  // ------------------------------------------------------------ telemetry

  readonly telemetry: RoomTelemetry = this.makeTelemetry()

  private makeTelemetry(): RoomTelemetry {
    const room = this
    return {
      get bus(): TelemetryBus {
        return room.bus
      },
      subscribe: (cb, o) => room.bus.subscribe(cb, o),
      subscribeRemote: (cb) => room.bus.subscribeRemote(cb),
      observe: async (peers?: Target) => {
        await room.sendTo(
          room.resolveTargets(peers),
          { a: TELEMETRY_CHANNEL, d: { sub: true } },
          1,
          1,
        )
      },
    }
  }

  private onTelemetryMsg(from: Hex, d: unknown): void {
    const body = d as { sub?: boolean; ev?: TelemetryEvent }
    if (!body) return
    if (body.sub !== undefined) {
      const caps = this.sessions.get(from)?.caps ?? this.virtual.get(from)?.caps ?? []
      if (body.sub && caps.includes('debug')) this.observers.add(from)
      else this.observers.delete(from)
      return
    }
    if (body.ev) this.bus.emitRemote(from, body.ev)
  }

  private forwardTelemetry(e: TelemetryEvent): void {
    if (this.observers.size === 0) return
    if (e.type === 'message' && e.action === TELEMETRY_CHANNEL) return
    const ev = e.type === 'message' ? { ...e, payload: undefined } : e
    for (const o of this.observers) {
      void this.sendTo([o], { a: TELEMETRY_CHANNEL, d: { ev } }, 1, 3).catch(() => {})
    }
  }

  devtools(o: DevtoolsOptions = {}): { close(): void } {
    const peersChanged = new Listeners<[]>()
    const unsubs = [this.joinL, this.leaveL, this.updateL].map((l) =>
      l.add(() => peersChanged.emit()),
    )
    unsubs.push(this.hostL.add(() => peersChanged.emit()))
    const handle = startDevtools(
      {
        roomId: this.roomId,
        selfKey: this.self.pubkey,
        studioPeers: () => [
          {
            pubkey: this.self.pubkey,
            isSelf: true,
            isHost: this.hostKey === this.self.pubkey,
            attestations: this.self.attestations.map((a) => a.type),
            meta: this.opts.meta ?? {},
            ...(typeof this.opts.meta?.name === 'string' ? { name: this.opts.meta.name } : {}),
          },
          ...this.peers.map((p) => ({
            pubkey: p.pubkey,
            isHost: p.isHost,
            attestations: p.attestations.map((a) => a.type),
            meta: p.meta,
            ...(typeof p.meta.name === 'string' ? { name: p.meta.name } : {}),
          })),
        ],
        onPeersChanged: (cb) => peersChanged.add(cb),
        onTelemetry: (cb) => this.bus.subscribe(cb),
        recentTelemetry: () => this.bus.recent(),
        memoryHubs: () => {
          const hubs = new Set<MemoryHub>()
          for (const t of this.opts.transports) {
            const hub = (t as { hub?: unknown }).hub
            if (hub instanceof MemoryHub) hubs.add(hub)
          }
          return [...hubs]
        },
        killLinks: (peer) => {
          for (const [pk, e] of this.sessions)
            if (peer === 'all' || pk === peer) e.session.link?.kill('devtools fault')
        },
        connectionInfo: async (peer) => {
          const link = this.sessions.get(peer)?.session.link
          if (!link) return null
          const st = await link.conn.stats().catch(() => null)
          return {
            state: link.conn.state,
            path: link.path,
            channels: Object.values(link.channels).map((c) => ({
              label: c.label,
              reliability: c.reliability.mode,
              readyState: c.readyState,
              bufferedAmount: c.bufferedAmount,
              bufferedAmountLowThreshold: c.bufferedAmountLowThreshold,
            })),
            candidatePairs: st
              ? [
                  {
                    local: st.localCandidateType ?? link.transport,
                    remote: st.remoteCandidateType ?? link.transport,
                    path: st.path,
                    state: 'succeeded' as const,
                    nominated: true,
                    ...(st.rttMs !== undefined ? { rttMs: st.rttMs } : {}),
                  },
                ]
              : [],
          }
        },
        checkAdmission: async (id) => {
          const r = await this.admit({
            v: PROTOCOL_VERSION,
            pubkey: id.pubkey,
            sid: '',
            topic: this.topic,
            nonce: new Uint8Array(32),
            attestations: [id.attestation],
            meta: {},
          })
          return r.ok ? { admitted: true } : { admitted: false, reason: r.reason }
        },
        reportError: (code, message) => this.tel({ type: 'error', code, message }),
      },
      o,
    )
    return {
      close: () => {
        for (const u of unsubs) u()
        handle.close()
      },
    }
  }

  readonly debug = {
    sessions: (): SessionInfo[] =>
      [...this.sessions.entries()].map(([pk, e]) => ({
        remote: pk,
        state: e.session.state,
        path: e.session.link?.path ?? null,
        transport: e.session.link?.transport ?? null,
        rttMs: e.session.rttMs,
        unacked: e.session.unackedCount,
        queuedBytes: e.session.pendingBytes,
      })),
    presence: (): Hex[] => [...this.presence.keys()],
  }
}

class IncomingFileImpl implements IncomingFile {
  received = 0
  readonly stream: ReadableStream<Uint8Array>
  private controller!: ReadableStreamDefaultController<Uint8Array>
  private progressL = new Listeners<[number, number | undefined]>()
  private finished = false

  constructor(
    readonly id: string,
    readonly from: Hex,
    readonly name: string,
    readonly mime: string,
    readonly size: number | undefined,
  ) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c
      },
    })
  }

  push(b: Uint8Array): void {
    if (this.finished) return
    this.received += b.length
    this.controller.enqueue(b)
    this.progressL.emit(this.received, this.size)
  }

  end(): void {
    if (this.finished) return
    this.finished = true
    this.controller.close()
  }

  fail(e: Error): void {
    if (this.finished) return
    this.finished = true
    this.controller.error(e)
  }

  onProgress(cb: (received: number, total: number | undefined) => void): Unsubscribe {
    return this.progressL.add(cb)
  }

  async bytes(): Promise<Uint8Array> {
    const reader = this.stream.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }
    return concatBytes(...parts)
  }
}
