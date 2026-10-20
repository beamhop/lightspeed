import { afterEach, describe, expect, test } from 'bun:test'
import type { Channel, Connection, Identity, SignalPipe, TransportSignal } from '../types'
import {
  CONTROL_CHANNEL_ID,
  pathFromCandidates,
  reliabilityToInit,
  type WebRTCConnection,
  webrtcTransport,
} from './webrtc'

// =====================================================================================
// In-memory fake RTCPeerConnection. Models just enough of the spec for the transport:
// offer/answer state machine with implicit rollback, trickle ICE with ufrags (so ICE
// restarts are observable), negotiated data channels over a fake SCTP association,
// bufferedAmount, getStats() with a selected candidate pair, and media tracks.
// =====================================================================================

type CandType = 'host' | 'srflx' | 'relay'

interface FakeSdp {
  pc: number
  ufrag: string
  app: boolean
  tracks: { id: string; kind: string; streams: string[] }[]
}

let ufragCounter = 0
const newUfrag = () => `u${(++ufragCounter).toString(36)}`
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): void {
  const ev = new Event(type)
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(ev, k, { value: v, enumerable: true })
  }
  target.dispatchEvent(ev)
}

class FakeNetwork {
  readonly pcs: FakePC[] = []
  candidateType: CandType = 'host'
  blocked = false
  /** Messages sent on negotiated channels the peer has not created (dropped like SCTP would). */
  droppedMessages = 0

  readonly RTCPeerConnection: typeof RTCPeerConnection
  constructor() {
    const net = this
    this.RTCPeerConnection = class extends FakePC {
      constructor(config?: RTCConfiguration) {
        super(net, config ?? {})
      }
    } as unknown as typeof RTCPeerConnection
  }

  byId(id: number): FakePC | undefined {
    return this.pcs.find((p) => p.fakeId === id)
  }

  /** Kill all current candidate pairs: connected PCs go disconnected, then failed. */
  fail(): void {
    this.blocked = true
    for (const pc of this.pcs) {
      pc.remoteCandidatesOk = false
      if (pc.connectionState === 'connected') {
        pc.setIce('disconnected')
        setTimeout(() => pc.setIce('failed'), 20)
      }
    }
  }

  heal(): void {
    this.blocked = false
    for (const pc of this.pcs) pc.tryConnect()
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType: BinaryType = 'blob'
  readonly ordered: boolean
  readonly maxRetransmits: number | null
  readonly negotiated: boolean
  private outbox: (string | ArrayBuffer)[] = []
  sentCount = 0

  constructor(
    readonly pc: FakePC,
    readonly label: string,
    readonly id: number,
    init: RTCDataChannelInit,
  ) {
    super()
    this.ordered = init.ordered ?? true
    this.maxRetransmits = init.maxRetransmits ?? null
    this.negotiated = !!init.negotiated
  }

  /** Negotiated channels open as soon as the SCTP association is up. */
  sctpUp(): void {
    if (this.readyState !== 'connecting') return
    this.readyState = 'open'
    setTimeout(() => fire(this, 'open'), 0)
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError')
    let payload: string | ArrayBuffer
    let size: number
    if (typeof data === 'string') {
      payload = data
      size = data.length
    } else {
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      payload = view.slice().buffer
      size = view.byteLength
    }
    this.sentCount++
    this.bufferedAmount += size
    this.outbox.push(payload)
    this.flush()
  }

  flush(): void {
    if (this.outbox.length === 0 || this.pc.connectionState !== 'connected') return
    const items = this.outbox.splice(0)
    setTimeout(() => {
      for (const payload of items) {
        const size = typeof payload === 'string' ? payload.length : payload.byteLength
        const before = this.bufferedAmount
        this.bufferedAmount -= size
        const peer = this.pc.peer?.dcs.get(this.id)
        if (peer && peer.readyState === 'open') {
          peer.dispatchEvent(new MessageEvent('message', { data: payload }))
        } else {
          this.pc.net.droppedMessages++
        }
        if (
          before > this.bufferedAmountLowThreshold &&
          this.bufferedAmount <= this.bufferedAmountLowThreshold
        ) {
          fire(this, 'bufferedamountlow')
        }
      }
    }, 1)
  }

  close(): void {
    if (this.readyState === 'closed' || this.readyState === 'closing') return
    this.readyState = 'closing'
    this.pc.dcs.delete(this.id)
    setTimeout(() => {
      this.readyState = 'closed'
      fire(this, 'close')
      // SCTP stream reset closes the peer's channel with the same id.
      const peer = this.pc.peer?.dcs.get(this.id)
      if (peer) peer.close()
    }, 0)
  }
}

class FakePC extends EventTarget {
  static nextId = 1
  readonly fakeId = FakePC.nextId++
  signalingState: RTCSignalingState = 'stable'
  iceConnectionState: RTCIceConnectionState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  private currentLocal: RTCSessionDescriptionInit | null = null
  ufrag = newUfrag()
  private gatheredUfrag: string | null = null
  remoteUfrag: string | null = null
  remoteCandidatesOk = false
  remoteCandidateType: CandType | undefined
  peer: FakePC | undefined
  readonly dcs = new Map<number, FakeDataChannel>()
  private wantsApp = false
  appNegotiated = false
  private needRestart = false
  restartCount = 0
  offersCreated = 0
  readonly localTracks = new Map<string, { track: MediaStreamTrack; streams: string[] }>()
  private negotiatedTracksKey = '[]'
  private readonly remoteTracksSeen = new Set<string>()
  private readonly remoteStreams = new Map<string, MediaStream>()
  private negotiationScheduled = false
  bytesSent = 0

  constructor(
    readonly net: FakeNetwork,
    readonly config: RTCConfiguration,
  ) {
    super()
    net.pcs.push(this)
  }

  get localType(): CandType {
    return this.config.iceTransportPolicy === 'relay' ? 'relay' : this.net.candidateType
  }

  // ------------------------------------------------------------- negotiation

  private tracksKey(): string {
    return JSON.stringify([...this.localTracks.values()].map((t) => [t.track.id, t.streams]).sort())
  }

  private scheduleNegotiation(): void {
    if (this.negotiationScheduled) return
    this.negotiationScheduled = true
    setTimeout(() => {
      this.negotiationScheduled = false
      if (this.signalingState !== 'stable') return
      const needed =
        this.needRestart ||
        (this.wantsApp && !this.appNegotiated) ||
        this.tracksKey() !== this.negotiatedTracksKey
      if (needed) fire(this, 'negotiationneeded')
    }, 0)
  }

  private sdp(): string {
    const body: FakeSdp = {
      pc: this.fakeId,
      ufrag: this.ufrag,
      app: this.wantsApp || this.appNegotiated,
      tracks: [...this.localTracks.values()].map((t) => ({
        id: t.track.id,
        kind: t.track.kind,
        streams: t.streams,
      })),
    }
    return JSON.stringify(body)
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    await tick()
    if (this.signalingState === 'closed') throw new DOMException('closed', 'InvalidStateError')
    let type = desc?.type
    if (!type) type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer'
    if (type === 'rollback') {
      this.signalingState = 'stable'
      this.localDescription = this.currentLocal
      return
    }
    if (type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        throw new DOMException('bad state for offer', 'InvalidStateError')
      }
      if (this.needRestart) {
        this.ufrag = newUfrag()
        this.needRestart = false
      }
      this.offersCreated++
      this.localDescription = { type: 'offer', sdp: this.sdp() }
      this.signalingState = 'have-local-offer'
      fire(this, 'signalingstatechange')
    } else {
      if (this.signalingState !== 'have-remote-offer') {
        throw new DOMException('bad state for answer', 'InvalidStateError')
      }
      const remote = JSON.parse(this.remoteDescription?.sdp ?? '{}') as FakeSdp
      this.localDescription = { type: 'answer', sdp: this.sdp() }
      this.currentLocal = this.localDescription
      this.appNegotiated = remote.app
      this.negotiatedTracksKey = this.tracksKey()
      this.signalingState = 'stable'
      fire(this, 'signalingstatechange')
      this.scheduleNegotiation()
    }
    this.gather()
    this.tryConnect()
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await tick()
    if (this.signalingState === 'closed') throw new DOMException('closed', 'InvalidStateError')
    const remote = JSON.parse(desc.sdp ?? '{}') as FakeSdp
    if (desc.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        // implicit rollback (perfect negotiation, polite side)
        this.signalingState = 'stable'
        this.localDescription = this.currentLocal
      }
      if (this.signalingState !== 'stable') {
        throw new DOMException('offer in wrong state', 'InvalidStateError')
      }
      this.signalingState = 'have-remote-offer'
      if (this.remoteUfrag !== null && this.remoteUfrag !== remote.ufrag) {
        this.ufrag = newUfrag() // remote ICE restart → restart locally as well
      }
    } else if (desc.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') {
        throw new DOMException('answer in wrong state', 'InvalidStateError')
      }
      const mine = JSON.parse(this.localDescription?.sdp ?? '{}') as FakeSdp
      this.currentLocal = this.localDescription
      this.appNegotiated = mine.app && remote.app
      this.negotiatedTracksKey = JSON.stringify(mine.tracks.map((t) => [t.id, t.streams]).sort())
      this.signalingState = 'stable'
      this.scheduleNegotiation()
    }
    fire(this, 'signalingstatechange')
    this.remoteDescription = { type: desc.type, sdp: desc.sdp ?? '' }
    if (this.remoteUfrag !== remote.ufrag) {
      this.remoteUfrag = remote.ufrag
      this.remoteCandidatesOk = false
    }
    this.peer = this.net.byId(remote.pc)
    for (const t of remote.tracks) {
      if (this.remoteTracksSeen.has(t.id)) continue
      this.remoteTracksSeen.add(t.id)
      const track = { id: t.id, kind: t.kind } as MediaStreamTrack
      const streams = t.streams.map((sid) => {
        let s = this.remoteStreams.get(sid)
        if (!s) {
          s = { id: sid } as MediaStream
          this.remoteStreams.set(sid, s)
        }
        return s
      })
      fire(this, 'track', { track, streams })
    }
    this.tryConnect()
  }

  private gather(): void {
    if (this.gatheredUfrag === this.ufrag) return
    const ufrag = this.ufrag
    this.gatheredUfrag = ufrag
    const type = this.localType
    setTimeout(() => {
      if (this.signalingState === 'closed') return
      const init: RTCIceCandidateInit = {
        candidate: `candidate:1 1 udp 2122260223 10.0.0.${this.fakeId} 5000${this.fakeId} typ ${type}`,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: ufrag,
      }
      fire(this, 'icecandidate', { candidate: { ...init, toJSON: () => init } })
      fire(this, 'icecandidate', { candidate: null })
    }, 2)
  }

  async addIceCandidate(c?: RTCIceCandidateInit | null): Promise<void> {
    await tick()
    if (!this.remoteDescription)
      throw new DOMException('no remote description', 'InvalidStateError')
    if (!c?.candidate) return
    if (c.usernameFragment !== this.remoteUfrag) return // stale generation
    this.remoteCandidatesOk = true
    this.remoteCandidateType = /typ (\w+)/.exec(c.candidate)?.[1] as CandType
    this.tryConnect()
  }

  restartIce(): void {
    this.needRestart = true
    this.restartCount++
    this.scheduleNegotiation()
  }

  // ------------------------------------------------------------- ICE / SCTP

  setIce(state: RTCIceConnectionState): void {
    if (this.signalingState === 'closed' || this.iceConnectionState === state) return
    this.iceConnectionState = state
    fire(this, 'iceconnectionstatechange')
    const conn: RTCPeerConnectionState =
      state === 'checking' ? 'connecting' : state === 'completed' ? 'connected' : (state as never)
    if (this.connectionState !== conn) {
      this.connectionState = conn
      fire(this, 'connectionstatechange')
    }
  }

  private iceReady(): boolean {
    return (
      !!this.localDescription &&
      !!this.remoteDescription &&
      this.remoteCandidatesOk &&
      this.remoteUfrag !== null
    )
  }

  tryConnect(): void {
    const peer = this.peer
    if (!peer || this.net.blocked) return
    if (!this.iceReady() || !peer.iceReady()) return
    if (this.remoteUfrag !== peer.ufrag || peer.remoteUfrag !== this.ufrag) return
    if (this.connectionState === 'connected' && peer.connectionState === 'connected') return
    setTimeout(() => {
      for (const pc of [this, peer]) {
        if (pc.signalingState === 'closed') continue
        pc.setIce('checking')
        pc.setIce('connected')
        pc.linkChannels()
      }
    }, 3)
  }

  linkChannels(): void {
    if (this.connectionState !== 'connected' || !this.appNegotiated) return
    for (const dc of this.dcs.values()) {
      dc.sctpUp()
      dc.flush()
    }
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): RTCDataChannel {
    if (this.signalingState === 'closed') throw new DOMException('closed', 'InvalidStateError')
    if (!init.negotiated || init.id === undefined) {
      throw new Error('fake only supports negotiated data channels')
    }
    if (this.dcs.has(init.id)) throw new DOMException('id in use', 'OperationError')
    const dc = new FakeDataChannel(this, label, init.id, init)
    this.dcs.set(init.id, dc)
    this.wantsApp = true
    if (!this.appNegotiated) this.scheduleNegotiation()
    else setTimeout(() => this.linkChannels(), 0)
    return dc as unknown as RTCDataChannel
  }

  // ------------------------------------------------------------- media

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    this.localTracks.set(track.id, { track, streams: streams.map((s) => s.id) })
    this.scheduleNegotiation()
    return { track } as RTCRtpSender
  }

  removeTrack(sender: RTCRtpSender): void {
    if (sender.track) this.localTracks.delete(sender.track.id)
    this.scheduleNegotiation()
  }

  // ------------------------------------------------------------- stats / close

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    await tick()
    const m = new Map<string, Record<string, unknown>>()
    const connected = this.connectionState === 'connected'
    let sent = 0
    for (const dc of this.dcs.values()) sent += dc.sentCount
    m.set('T1', {
      id: 'T1',
      type: 'transport',
      selectedCandidatePairId: connected ? 'CP1' : undefined,
    })
    if (connected) {
      m.set('CP1', {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L1',
        remoteCandidateId: 'R1',
        currentRoundTripTime: 0.012,
        bytesSent: sent * 10,
        bytesReceived: 7,
      })
      m.set('L1', { id: 'L1', type: 'local-candidate', candidateType: this.localType })
      m.set('R1', { id: 'R1', type: 'remote-candidate', candidateType: this.remoteCandidateType })
    }
    return m
  }

  close(): void {
    if (this.signalingState === 'closed') return
    this.signalingState = 'closed'
    this.iceConnectionState = 'closed'
    this.connectionState = 'closed' // per spec: no events fired by close()
    for (const dc of [...this.dcs.values()]) dc.close()
  }
}

// =====================================================================================
// helpers
// =====================================================================================

function pipePair(): { a: SignalPipe; b: SignalPipe; log: TransportSignal[] } {
  const log: TransportSignal[] = []
  const listeners = {
    a: new Set<(m: TransportSignal) => void>(),
    b: new Set<(m: TransportSignal) => void>(),
  }
  const mk = (self: 'a' | 'b', other: 'a' | 'b'): SignalPipe => ({
    send(m) {
      log.push(m)
      const copy = JSON.parse(JSON.stringify(m)) as TransportSignal
      setTimeout(() => {
        for (const cb of listeners[other]) cb(copy)
      }, 1)
    },
    onMessage(cb) {
      listeners[self].add(cb)
      return () => listeners[self].delete(cb)
    },
  })
  return { a: mk('a', 'b'), b: mk('b', 'a'), log }
}

const ident = (pubkey: string) => ({ pubkey }) as Identity
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const open: Connection[] = []

async function waitFor(cond: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

async function pair(
  net = new FakeNetwork(),
  extra: Parameters<typeof webrtcTransport>[0] = {},
): Promise<{ a: WebRTCConnection; b: WebRTCConnection; net: FakeNetwork; log: TransportSignal[] }> {
  const t = webrtcTransport({ RTCPeerConnection: net.RTCPeerConnection, ...extra })
  const { a: pa, b: pb, log } = pipePair()
  const [a, b] = (await Promise.all([
    t.connect(B, { initiator: true, pipe: pa, local: ident(A) }),
    t.connect(A, { initiator: false, pipe: pb, local: ident(B) }),
  ])) as [WebRTCConnection, WebRTCConnection]
  open.push(a, b)
  return { a, b, net, log }
}

function nextChannel(c: Connection): Promise<Channel> {
  return new Promise((resolve) => {
    const off = c.onChannel((ch) => {
      off()
      resolve(ch)
    })
  })
}

function nextMessage(ch: Channel): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const off = ch.onMessage((d) => {
      off()
      resolve(d)
    })
  })
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

afterEach(() => {
  for (const c of open.splice(0)) c.close()
})

// =====================================================================================
// tests
// =====================================================================================

describe('helpers', () => {
  test('reliability mapping', () => {
    expect(reliabilityToInit({ mode: 'reliable' })).toEqual({ ordered: true })
    expect(reliabilityToInit({ mode: 'unordered' })).toEqual({ ordered: false })
    expect(reliabilityToInit({ mode: 'unreliable', maxRetransmits: 2 })).toEqual({
      ordered: false,
      maxRetransmits: 2,
    })
  })

  test('path from candidate types', () => {
    expect(pathFromCandidates('host', 'host')).toBe('direct')
    expect(pathFromCandidates('srflx', 'prflx')).toBe('direct')
    expect(pathFromCandidates('relay', 'host')).toBe('turn')
    expect(pathFromCandidates('host', 'relay')).toBe('turn')
  })

  test('connect fails clearly without an RTCPeerConnection', async () => {
    const { a } = pipePair()
    const t = webrtcTransport()
    await expect(t.connect(B, { initiator: true, pipe: a, local: ident(A) })).rejects.toThrow(
      /RTCPeerConnection/,
    )
  })
})

describe('webrtcTransport', () => {
  test('negotiates (with glare), opens channels and exchanges messages', async () => {
    const { a, b, net, log } = await pair()
    expect(a.state).toBe('connected')
    expect(b.state).toBe('connected')
    expect(a.initiator).toBe(true)
    // both sides created the control channel → both offered; the impolite initiator won
    expect(log.filter((m) => m.type === 'offer').length).toBeGreaterThanOrEqual(1)
    expect(log.some((m) => m.type === 'answer')).toBe(true)
    expect(log.some((m) => m.type === 'candidate')).toBe(true)
    expect(net.pcs[0]?.dcs.get(CONTROL_CHANNEL_ID)?.label).toBe('__beamhop/ctl')

    const incoming = nextChannel(b)
    const chA = a.openChannel('chat', { mode: 'reliable' })
    expect(chA.readyState).toBe('connecting')
    const opened = new Promise<void>((r) => chA.onOpen(r))
    const chB = await incoming
    expect(chB.label).toBe('chat')
    expect(chB.reliability).toEqual({ mode: 'reliable' })
    await opened
    expect(chA.readyState).toBe('open')
    await waitFor(() => chB.readyState === 'open', 1000, 'remote open')

    const gotB = nextMessage(chB)
    chA.send(bytes('hello'))
    expect(text(await gotB)).toBe('hello')
    const gotA = nextMessage(chA)
    chB.send(bytes('world'))
    expect(text(await gotA)).toBe('world')
    expect(net.droppedMessages).toBe(0)
    expect(a.openChannel('chat', { mode: 'reliable' })).toBe(chA)
  })

  test('maps reliability onto negotiated data channels', async () => {
    const { a, b, net } = await pair()
    const seen: Channel[] = []
    b.onChannel((c) => seen.push(c))
    const u = a.openChannel('pos', { mode: 'unreliable', maxRetransmits: 0 })
    const o = a.openChannel('files', { mode: 'unordered' })
    await waitFor(() => u.readyState === 'open' && o.readyState === 'open', 1000, 'open')
    const [pcA, pcB] = net.pcs
    const ids = [...(pcA?.dcs.values() ?? [])].map((d) => [d.label, d.id, d.negotiated])
    expect(ids).toEqual([
      ['__beamhop/ctl', 0, true],
      ['pos', 2, true],
      ['files', 4, true],
    ])
    const pos = pcB?.dcs.get(2)
    expect(pos?.ordered).toBe(false)
    expect(pos?.maxRetransmits).toBe(0)
    expect(pcB?.dcs.get(4)?.ordered).toBe(false)
    expect(pcB?.dcs.get(4)?.maxRetransmits).toBeNull()
    expect(seen.map((c) => [c.label, c.reliability.mode])).toEqual([
      ['pos', 'unreliable'],
      ['files', 'unordered'],
    ])
    // responder allocates odd ids
    const r = b.openChannel('back', { mode: 'reliable' })
    await waitFor(() => r.readyState === 'open', 1000, 'responder channel')
    expect(net.pcs[1]?.dcs.get(1)?.label).toBe('back')
  })

  test('simultaneous open of the same label converges on one channel', async () => {
    const { a, b, net } = await pair()
    const remoteSeen: Channel[] = []
    a.onChannel((c) => remoteSeen.push(c))
    b.onChannel((c) => remoteSeen.push(c))
    const chA = a.openChannel('game', { mode: 'reliable' })
    const chB = b.openChannel('game', { mode: 'reliable' })
    await waitFor(() => chA.readyState === 'open' && chB.readyState === 'open', 1000, 'open')
    expect(remoteSeen).toHaveLength(0)
    const got = nextMessage(chB)
    chA.send(bytes('ping'))
    expect(text(await got)).toBe('ping')
    const got2 = nextMessage(chA)
    chB.send(bytes('pong'))
    expect(text(await got2)).toBe('pong')
    // lower id (responder's 1) won on both sides
    expect(net.pcs[0]?.dcs.get(1)?.label).toBe('game')
    expect(net.pcs[0]?.dcs.has(2)).toBe(false)
  })

  test('remote channels opened before onChannel is attached are delivered later', async () => {
    const { a, b } = await pair()
    const chA = a.openChannel('early', { mode: 'reliable' })
    await waitFor(() => chA.readyState === 'open', 1000, 'open')
    const late = await nextChannel(b)
    expect(late.label).toBe('early')
    const opened = await new Promise<boolean>((r) => late.onOpen(() => r(true)))
    expect(opened).toBe(true)
  })

  test('bufferedAmountLow fires as the buffer drains', async () => {
    const { a, b } = await pair()
    b.onChannel(() => {})
    const ch = a.openChannel('bulk', { mode: 'reliable' })
    await waitFor(() => ch.readyState === 'open', 1000, 'open')
    ch.bufferedAmountLowThreshold = 1024
    expect(ch.bufferedAmountLowThreshold).toBe(1024)
    let low = 0
    ch.onBufferedAmountLow(() => low++)
    for (let i = 0; i < 4; i++) ch.send(new Uint8Array(1000))
    expect(ch.bufferedAmount).toBe(4000)
    await waitFor(() => low === 1, 1000, 'bufferedamountlow')
    expect(ch.bufferedAmount).toBe(0)
  })

  test('detects a direct path and reports stats', async () => {
    const net = new FakeNetwork()
    net.candidateType = 'srflx'
    const { a } = await pair(net)
    await waitFor(() => a.path === 'direct', 500, 'path')
    const s = await a.stats()
    expect(s.path).toBe('direct')
    expect(s.localCandidateType).toBe('srflx')
    expect(s.remoteCandidateType).toBe('srflx')
    expect(s.rttMs).toBeCloseTo(12)
    expect(s.bytesReceived).toBe(7)
  })

  test('detects a TURN path from a relay candidate (iceTransportPolicy relay)', async () => {
    const net = new FakeNetwork()
    const { a, b } = await pair(net, {
      iceTransportPolicy: 'relay',
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }],
    })
    expect(net.pcs[0]?.config.iceTransportPolicy).toBe('relay')
    expect(net.pcs[0]?.config.iceServers?.[0]?.urls).toBe('turn:turn.example:3478')
    await waitFor(() => a.path === 'turn' && b.path === 'turn', 500, 'turn path')
    expect((await b.stats()).localCandidateType).toBe('relay')
  })

  test('ICE restart after failure recovers the connection and keeps channels', async () => {
    const net = new FakeNetwork()
    const { a, b } = await pair(net, { disconnectedGraceMs: 50 })
    const incoming = nextChannel(b)
    const chA = a.openChannel('chat', { mode: 'reliable' })
    const chB = await incoming
    await waitFor(() => chA.readyState === 'open' && chB.readyState === 'open', 1000, 'open')

    const states: string[] = []
    a.onStateChange((s) => states.push(s))
    const paths: string[] = []
    a.onPathChange((p) => paths.push(p))
    const ufragBefore = net.pcs[0]?.ufrag

    net.fail()
    await waitFor(() => a.state === 'disconnected', 1000, 'disconnected')
    await waitFor(() => (net.pcs[0]?.restartCount ?? 0) >= 1, 1000, 'restartIce on initiator')
    expect(net.pcs[1]?.restartCount).toBe(0) // only the initiator restarts
    net.candidateType = 'relay' // the new candidate pair goes through TURN
    net.heal()
    await waitFor(() => a.state === 'connected' && b.state === 'connected', 2000, 'reconnected')
    expect(net.pcs[0]?.ufrag).not.toBe(ufragBefore)
    expect(states).toEqual(['disconnected', 'connected'])
    await waitFor(() => a.path === 'turn', 500, 'path change')
    expect(paths).toEqual(['turn'])

    const got = nextMessage(chB)
    chA.send(bytes('still here'))
    expect(text(await got)).toBe('still here')
  })

  test('responder asks the initiator to restart', async () => {
    const net = new FakeNetwork()
    const { a, b, log } = await pair(net, { disconnectedGraceMs: 50 })
    // Only the responder notices the failure.
    const pcB = net.pcs[1] as FakePC
    pcB.remoteCandidatesOk = false
    net.blocked = true
    pcB.setIce('failed')
    await waitFor(() => log.some((m) => m.type === 'restart'), 1000, 'restart request')
    await waitFor(() => (net.pcs[0]?.restartCount ?? 0) === 1, 1000, 'initiator restart')
    net.heal()
    await waitFor(() => b.state === 'connected', 2000, 'reconnected')
    expect(a.state).toBe('connected')
  })

  test('gives up after maxIceRestarts', async () => {
    const net = new FakeNetwork()
    const { a } = await pair(net, { maxIceRestarts: 1, restartTimeoutMs: 50 })
    const closed = new Promise<void>((r) => a.onStateChange((s) => s === 'closed' && r()))
    net.fail()
    await closed
    expect(a.state).toBe('closed')
  })

  test('media: addStream / onTrack / removeStream renegotiate', async () => {
    const { a, b, log } = await pair()
    const tracks: [MediaStreamTrack, readonly MediaStream[]][] = []
    b.onTrack((t, s) => tracks.push([t, s]))
    const offersBefore = log.filter((m) => m.type === 'offer').length
    const track = { id: 'cam-1', kind: 'video' } as MediaStreamTrack
    const stream = { id: 'stream-1', getTracks: () => [track] } as unknown as MediaStream
    a.addStream(stream)
    await waitFor(() => tracks.length === 1, 1000, 'ontrack')
    expect(tracks[0]?.[0].id).toBe('cam-1')
    expect(tracks[0]?.[0].kind).toBe('video')
    expect(tracks[0]?.[1].map((s) => s.id)).toEqual(['stream-1'])
    expect(log.filter((m) => m.type === 'offer').length).toBe(offersBefore + 1)
    await waitFor(
      () => fakeOf(a).signalingState === 'stable' && fakeOf(b).signalingState === 'stable',
      1000,
      'stable after first round',
    )

    // the responder can add media too (it becomes the offerer for that round)
    const back: MediaStreamTrack[] = []
    a.onTrack((t) => back.push(t))
    const mic = { id: 'mic-1', kind: 'audio' } as MediaStreamTrack
    b.addStream({ id: 's2', getTracks: () => [mic] } as unknown as MediaStream)
    await waitFor(() => back.length === 1, 1000, 'responder track')
    await waitFor(
      () => fakeOf(a).signalingState === 'stable' && fakeOf(b).signalingState === 'stable',
      1000,
      'stable',
    )

    const offersBeforeRemove = log.filter((m) => m.type === 'offer').length
    a.removeStream(stream)
    await waitFor(
      () => log.filter((m) => m.type === 'offer').length === offersBeforeRemove + 1,
      1000,
      'renegotiation after remove',
    )
    expect(fakeOf(a).localTracks.size).toBe(0)
    expect(a.state).toBe('connected')
  })

  test('close tears down channels and notifies', async () => {
    const { a, b } = await pair()
    const incoming = nextChannel(b)
    const chA = a.openChannel('x', { mode: 'reliable' })
    const chB = await incoming
    await waitFor(() => chA.readyState === 'open', 1000, 'open')
    const closedB = new Promise<void>((r) => chB.onClose(r))
    const states: string[] = []
    a.onStateChange((s) => states.push(s))
    a.close()
    expect(chA.readyState).toBe('closed')
    expect(states).toEqual(['closed'])
    await closedB
    expect(() => a.openChannel('y', { mode: 'reliable' })).toThrow(/closed/)
  })

  test('channel close is mirrored and the label can be reopened', async () => {
    const { a, b } = await pair()
    const seen: Channel[] = []
    b.onChannel((c) => seen.push(c))
    const ch1 = a.openChannel('tmp', { mode: 'reliable' })
    await waitFor(() => ch1.readyState === 'open' && seen.length === 1, 1000, 'open')
    const remoteClosed = new Promise<void>((r) => seen[0]?.onClose(r))
    ch1.close()
    await remoteClosed
    const ch2 = a.openChannel('tmp', { mode: 'reliable' })
    expect(ch2).not.toBe(ch1)
    await waitFor(() => ch2.readyState === 'open' && seen.length === 2, 1000, 'reopen')
    const got = nextMessage(seen[1] as Channel)
    ch2.send(bytes('again'))
    expect(text(await got)).toBe('again')
  })

  test('abort signal and timeout reject connect()', async () => {
    const net = new FakeNetwork()
    const t = webrtcTransport({ RTCPeerConnection: net.RTCPeerConnection, connectTimeoutMs: 50 })
    const { a } = pipePair() // nobody on the other end
    const ac = new AbortController()
    const p1 = t.connect(B, { initiator: true, pipe: a, local: ident(A), signal: ac.signal })
    ac.abort()
    await expect(p1).rejects.toThrow(/aborted/)
    expect(net.pcs[0]?.signalingState).toBe('closed')
    await expect(t.connect(B, { initiator: true, pipe: a, local: ident(A) })).rejects.toThrow(
      /timed out/,
    )
  })
})

function fakeOf(c: WebRTCConnection): FakePC {
  return c.pc as unknown as FakePC
}
