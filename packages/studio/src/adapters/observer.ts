// Observer peer: Studio joins the room as a real @beamhop/p2p peer holding a capability token with
// the `debug` cap, then calls `room.telemetry.observe()` so every peer streams its telemetry to us on
// the reserved `__beamhop/telemetry` channel (`room.telemetry.subscribeRemote`). Peers only honour
// the subscription when the token verifies against their room policy (a trusted issuer, the star
// host, or `policy.dev: true`).
//
// Default wiring for a Beamhop relay at `relay` (ws[s]://host): Nostr signaling on the app realm
// `/a/<appId>` and the relay data transport `/a/<appId>/data` (no WebRTC needed for an observer).
import {
  anonymous,
  type CapabilityToken,
  createRoom,
  getPublicKey,
  type Hex,
  type Identity,
  type IdentityProvider,
  issueCapability,
  keyIdentity,
  type Room,
  relayTransport,
  roomTopic,
  type SignalingFactory,
  type Transport,
} from '@beamhop/p2p'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { hexToBytes } from '@noble/hashes/utils'
import { parseSecretKey, sessionSecretKey } from '../identity'
import type {
  ActiveFault,
  AdmissionResult,
  ConnectionInfo,
  Fault,
  StudioEvent,
  StudioIdentity,
  StudioPeer,
  StudioRoom,
  TelemetryEvent,
  Unsubscribe,
} from '../room-adapter'
import { UnsupportedError } from '../room-adapter'

export interface ObserverRoomOptions {
  appId: string
  roomId: string
  /** Base URL of a Beamhop relay (ws://, wss://, http:// or https://). */
  relay: string
  password?: string
  /**
   * Pre-issued capability token (object or JSON) with the `debug` cap. It names a session pubkey,
   * so pass that session's secret key as `secretKey` too.
   */
  debugToken?: CapabilityToken | string
  /** Session secret key (hex or nsec) to join with. Default: a fresh anonymous key. */
  secretKey?: string
  /**
   * App secret key (hex or nsec) to issue the debug token locally for whatever session key the
   * observer joins with. Without it and without `debugToken`, Studio self-signs a token, which
   * only rooms with `policy.dev: true` accept.
   */
  appSecretKey?: string
  /** Signaling relays (default `<relay>/a/<appId>`). */
  relays?: string[]
  /** Overrides for tests and embedding (e.g. memorySignaling + memoryTransport). */
  signaling?: SignalingFactory
  transports?: Transport[]
  /** How long setIdentity waits for a peer to admit or reject the new identity (default 10 s). */
  admissionTimeoutMs?: number
}

function wsBase(url: string): string {
  return url.trim().replace(/^http/, 'ws').replace(/\/+$/, '')
}

function parseToken(t: CapabilityToken | string): CapabilityToken {
  return typeof t === 'string' ? (JSON.parse(t) as CapabilityToken) : t
}

export class ObserverRoom implements StudioRoom {
  readonly mode = 'observer' as const
  readonly roomId: string
  readonly capabilities = { faults: false, connectionInfo: true, identity: true }
  readonly options: ObserverRoomOptions
  static readonly available = true

  private room: Room | null = null
  private joining: Promise<void> | null = null
  private log: StudioEvent[] = []
  private listeners = new Set<(e: StudioEvent) => void>()
  private seq = 0
  private subs: Unsubscribe[] = []
  private identity: IdentityProvider | Identity
  private sessionKey: Uint8Array | null = null

  constructor(options: ObserverRoomOptions) {
    this.options = options
    this.roomId = options.roomId
    if (options.secretKey) {
      this.sessionKey = parseSecretKey(options.secretKey)
      this.identity = keyIdentity(this.sessionKey)
    } else {
      this.identity = anonymous()
    }
  }

  /** The underlying room once joined (tests, advanced use). */
  get current(): Room | null {
    return this.room
  }

  async join(): Promise<void> {
    if (this.room) return
    if (!this.joining) {
      this.joining = this.connect().finally(() => {
        this.joining = null
      })
    }
    return this.joining
  }

  private async capabilityFor(pubkey: Hex): Promise<CapabilityToken> {
    const o = this.options
    if (o.debugToken) {
      const tok = parseToken(o.debugToken)
      if (tok.pubkey !== pubkey)
        throw new Error(
          'debug token was issued for a different session key; pass its secretKey as well',
        )
      return tok
    }
    const room = roomTopic(o.appId, o.roomId, o.password || undefined)
    const caps = ['join', 'debug']
    if (o.appSecretKey)
      return issueCapability(parseSecretKey(o.appSecretKey), { room, pubkey, caps })
    // Self-signed: accepted by dev rooms only.
    if (this.sessionKey) return issueCapability(this.sessionKey, { room, pubkey, caps })
    const id = await this.loadIdentity()
    return issueCapability(id, { room, pubkey, caps })
  }

  private async loadIdentity(): Promise<Identity> {
    if ('load' in this.identity) this.identity = await this.identity.load()
    return this.identity
  }

  private async connect(): Promise<void> {
    const o = this.options
    const identity = await this.loadIdentity()
    const capability = await this.capabilityFor(identity.pubkey)
    const base = wsBase(o.relay)
    const realm = `${base}/a/${encodeURIComponent(o.appId)}`
    const room = await createRoom({
      appId: o.appId,
      roomId: o.roomId,
      ...(o.password ? { password: o.password } : {}),
      identity,
      signaling: o.signaling ?? nostrSignaling({ relays: o.relays ?? [realm] }),
      transports: o.transports ?? [relayTransport({ url: `${realm}/data`, appId: o.appId })],
      capability,
      meta: { name: 'Studio observer', studio: true },
    })
    this.room = room
    const self = room.self.pubkey
    this.subs.push(
      room.telemetry.subscribe((e) => this.push(self, e), { replay: true }),
      room.telemetry.subscribeRemote((from, e) => this.push(from, e)),
      // Ask every peer (now and when it joins or rejoins) to stream its telemetry to us.
      room.onPeerJoin((p) => void room.telemetry.observe(p.pubkey).catch(() => {})),
    )
    if (room.peers.length) await room.telemetry.observe('all').catch(() => {})
  }

  private push(source: Hex, event: TelemetryEvent): void {
    const se: StudioEvent = { seq: ++this.seq, source, event }
    this.log.push(se)
    for (const l of this.listeners) l(se)
  }

  async leave(): Promise<void> {
    if (this.joining) await this.joining.catch(() => {})
    for (const u of this.subs.splice(0)) u()
    const r = this.room
    this.room = null
    if (r) await r.leave()
  }

  history(): readonly StudioEvent[] {
    return this.log
  }

  subscribe(cb: (event: StudioEvent) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  peers(): StudioPeer[] {
    const r = this.room
    if (!r) return []
    return [
      {
        pubkey: r.self.pubkey,
        name: 'Studio',
        isSelf: true,
        attestations: r.self.attestations.map((a) => a.type),
      },
      ...r.peers.map((p) => ({
        pubkey: p.pubkey,
        ...(typeof p.meta.name === 'string' ? { name: p.meta.name } : {}),
        isHost: p.isHost,
        attestations: p.attestations.map((a) => a.type),
        meta: p.meta,
      })),
    ]
  }

  async injectFault(_fault: Fault): Promise<ActiveFault> {
    throw new UnsupportedError('Fault injection', this.mode)
  }

  async clearFault(_id: string): Promise<void> {}

  faults(): readonly ActiveFault[] {
    return []
  }

  /** Only the observer's own sessions are visible from here (source = Studio's pubkey). */
  connectionInfo(source: Hex, peer: Hex): ConnectionInfo | null {
    const r = this.room
    if (!r || source !== r.self.pubkey) return null
    const s = r.debug.sessions().find((x) => x.remote === peer)
    if (!s || !s.path) return null
    return {
      state: s.state === 'connected' ? 'connected' : 'disconnected',
      path: s.path,
      channels: [],
      candidatePairs: [],
    }
  }

  /**
   * Re-join as `identity` and report whether the room's peers admit it. Needs the identity's
   * session secret key, which Studio has for identities it created (anonymous, Nostr).
   */
  async setIdentity(identity: StudioIdentity): Promise<AdmissionResult> {
    const sk = sessionSecretKey(identity)
    if (!sk)
      return {
        admitted: false,
        reason:
          'Studio does not hold the session key for this identity, so the observer cannot join as it',
      }
    await this.leave()
    this.sessionKey = hexToBytes(sk)
    this.identity = keyIdentity(this.sessionKey, [identity.attestation])
    if (getPublicKey(this.sessionKey) !== identity.pubkey)
      return { admitted: false, reason: 'session key does not match the identity pubkey' }
    try {
      await this.join()
    } catch (err) {
      return { admitted: false, reason: (err as Error).message }
    }
    const room = this.room as Room | null
    if (!room) return { admitted: false, reason: 'not joined' }
    if (room.peers.length) return { admitted: true }
    return new Promise<AdmissionResult>((resolve) => {
      const offs: Unsubscribe[] = []
      const done = (r: AdmissionResult) => {
        clearTimeout(timer)
        for (const off of offs) off()
        resolve(r)
      }
      const timer = setTimeout(
        () => done({ admitted: false, reason: 'no peer admitted the observer in time' }),
        this.options.admissionTimeoutMs ?? 10_000,
      )
      offs.push(
        room.onPeerJoin(() => done({ admitted: true })),
        room.telemetry.subscribe((e) => {
          if (e.type === 'error' && e.code === 'handshake' && /rejected/.test(e.message))
            done({ admitted: false, reason: e.message })
        }),
      )
    })
  }
}
