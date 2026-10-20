// WebRTC transport: perfect negotiation over a SignalPipe, trickle ICE, negotiated data channels
// announced over an in-band control channel, ICE restart, path detection, stats and media.
import type {
  Channel,
  Connection,
  ConnectionStats,
  Hex,
  PathType,
  Reliability,
  SignalPipe,
  Transport,
  TransportConnectOptions,
  TransportSignal,
  Unsubscribe,
} from '../types'

export interface WebRTCTransportOptions {
  iceServers?: RTCIceServer[]
  iceTransportPolicy?: RTCIceTransportPolicy
  /** Constructor to use instead of `globalThis.RTCPeerConnection` (polyfills, tests). */
  RTCPeerConnection?: typeof RTCPeerConnection
  /** Reject `connect()` if not connected within this time. Default 30000 ms. */
  connectTimeoutMs?: number
  /** ICE restarts attempted per failure episode before the connection is closed. Default 3. */
  maxIceRestarts?: number
  /** How long ICE may sit in `disconnected` before an ICE restart. Default 3000 ms. */
  disconnectedGraceMs?: number
  /** Time an ICE restart may take before another one is attempted. Default 10000 ms. */
  restartTimeoutMs?: number
}

/** Pre-negotiated control channel (id 0) carrying channel open/ack/close messages. */
export const CONTROL_CHANNEL_LABEL = '__beamhop/ctl'
export const CONTROL_CHANNEL_ID = 0
const MAX_CHANNEL_ID = 65534

type ControlMessage =
  | { t: 'open'; label: string; id: number; rel: Reliability }
  | { t: 'ack'; label: string; id: number }
  | { t: 'close'; label: string; id: number }

export function webrtcTransport(options: WebRTCTransportOptions = {}): Transport {
  return {
    name: 'webrtc',
    connect(remote: Hex, opts: TransportConnectOptions): Promise<Connection> {
      const PC =
        options.RTCPeerConnection ??
        (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection
      if (!PC) {
        return Promise.reject(
          new Error('RTCPeerConnection is not available; pass options.RTCPeerConnection'),
        )
      }
      const conn = new WebRTCConnection(remote, opts, options, PC)
      return conn.ready()
    },
  }
}

/** Maps a channel reliability to RTCDataChannelInit fields. */
export function reliabilityToInit(rel: Reliability): RTCDataChannelInit {
  switch (rel.mode) {
    case 'reliable':
      return { ordered: true }
    case 'unordered':
      return { ordered: false }
    case 'unreliable':
      return { ordered: false, maxRetransmits: rel.maxRetransmits }
  }
}

/** host/srflx/prflx on both ends → direct; a relay candidate on either end → TURN. */
export function pathFromCandidates(local?: string, remote?: string): PathType {
  return local === 'relay' || remote === 'relay' ? 'turn' : 'direct'
}

class Emitter<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>()
  on(cb: (...args: A) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  emit(...args: A): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(...args)
      } catch (err) {
        queueMicrotask(() => {
          throw err
        })
      }
    }
  }
  get size(): number {
    return this.listeners.size
  }
  clear(): void {
    this.listeners.clear()
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return new Uint8Array(0)
}

class WebRTCChannel implements Channel {
  dc: RTCDataChannel
  /** True once the remote side has created the matching negotiated channel. */
  acked: boolean
  private closed = false
  private opened = false
  private threshold = 0
  private readonly openEv = new Emitter<[]>()
  private readonly messageEv = new Emitter<[Uint8Array]>()
  private readonly lowEv = new Emitter<[]>()
  private readonly closeEv = new Emitter<[]>()

  constructor(
    readonly label: string,
    readonly reliability: Reliability,
    dc: RTCDataChannel,
    acked: boolean,
    private readonly onLocalClose: (ch: WebRTCChannel) => void,
  ) {
    this.dc = dc
    this.acked = acked
    this.bind(dc)
  }

  get id(): number {
    return this.dc.id ?? -1
  }

  bind(dc: RTCDataChannel): void {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = this.threshold
    dc.addEventListener('open', () => {
      if (this.dc === dc) this.check()
    })
    dc.addEventListener('message', (ev: MessageEvent) => {
      if (this.dc === dc && !this.closed) this.messageEv.emit(toBytes(ev.data))
    })
    dc.addEventListener('bufferedamountlow', () => {
      if (this.dc === dc) this.lowEv.emit()
    })
    dc.addEventListener('close', () => {
      if (this.dc === dc) this.markClosed()
    })
    this.check()
  }

  /** Fires onOpen once both the local data channel is open and the remote acknowledged it. */
  check(): void {
    if (!this.opened && this.readyState === 'open') {
      this.opened = true
      this.openEv.emit()
    }
  }

  get readyState(): Channel['readyState'] {
    if (this.closed) return 'closed'
    const s = this.dc.readyState
    if (s === 'open') return this.acked ? 'open' : 'connecting'
    return s
  }

  get bufferedAmount(): number {
    return this.dc.bufferedAmount
  }

  get bufferedAmountLowThreshold(): number {
    return this.threshold
  }

  set bufferedAmountLowThreshold(v: number) {
    this.threshold = v
    this.dc.bufferedAmountLowThreshold = v
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') {
      throw new Error(`channel "${this.label}" is not open (${this.readyState})`)
    }
    this.dc.send(data as Uint8Array<ArrayBuffer>)
  }

  onOpen(cb: () => void): Unsubscribe {
    if (this.opened && !this.closed) queueMicrotask(() => this.opened && !this.closed && cb())
    return this.openEv.on(cb)
  }

  onMessage(cb: (data: Uint8Array) => void): Unsubscribe {
    return this.messageEv.on(cb)
  }

  onBufferedAmountLow(cb: () => void): Unsubscribe {
    return this.lowEv.on(cb)
  }

  onClose(cb: () => void): Unsubscribe {
    if (this.closed) queueMicrotask(cb)
    return this.closeEv.on(cb)
  }

  markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.closeEv.emit()
    this.openEv.clear()
    this.messageEv.clear()
    this.lowEv.clear()
    this.closeEv.clear()
  }

  close(): void {
    if (this.closed) return
    this.onLocalClose(this)
    try {
      this.dc.close()
    } catch {
      // already closed
    }
    this.markClosed()
  }
}

export class WebRTCConnection implements Connection {
  readonly pc: RTCPeerConnection
  readonly initiator: boolean
  private _path: PathType = 'direct'
  private _state: Connection['state'] = 'connecting'
  private readonly pipe: SignalPipe
  private readonly polite: boolean
  private makingOffer = false
  private ignoreOffer = false
  private settingRemoteAnswerPending = false
  private pendingCandidates: (RTCIceCandidateInit | null)[] = []
  private signalChain: Promise<void> = Promise.resolve()
  private readonly ctl: RTCDataChannel
  private ctlQueue: string[] = []
  private readonly channels = new Map<string, WebRTCChannel>()
  private nextId: number
  private readonly unclaimed: Channel[] = []
  private readonly senders = new Map<string, RTCRtpSender[]>()
  private restarts = 0
  private restartPending = false
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly restartTimeoutMs: number
  private readonly unsubPipe: Unsubscribe
  private readonly stateEv = new Emitter<[Connection['state']]>()
  private readonly channelEv = new Emitter<[Channel]>()
  private readonly trackEv = new Emitter<[MediaStreamTrack, readonly MediaStream[]]>()
  private readonly pathEv = new Emitter<[PathType]>()
  private readonly errorEv = new Emitter<[Error]>()
  private readyPromise: Promise<Connection>
  private settleReady: ((err?: Error) => void) | undefined
  private readonly maxRestarts: number
  private readonly graceMs: number

  constructor(
    readonly remote: Hex,
    opts: TransportConnectOptions,
    options: WebRTCTransportOptions,
    PC: typeof RTCPeerConnection,
  ) {
    this.initiator = opts.initiator
    this.polite = !opts.initiator
    this.pipe = opts.pipe
    this.maxRestarts = options.maxIceRestarts ?? 3
    this.graceMs = options.disconnectedGraceMs ?? 3000
    this.restartTimeoutMs = options.restartTimeoutMs ?? 10_000
    this.nextId = this.initiator ? 2 : 1

    const config: RTCConfiguration = {}
    if (options.iceServers) config.iceServers = options.iceServers
    if (options.iceTransportPolicy) config.iceTransportPolicy = options.iceTransportPolicy
    this.pc = new PC(config)

    this.readyPromise = new Promise<Connection>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.settleReady?.(new Error('webrtc connect timed out')),
        options.connectTimeoutMs ?? 30_000,
      )
      const onAbort = () => this.settleReady?.(new Error('webrtc connect aborted'))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.settleReady = (err) => {
        this.settleReady = undefined
        clearTimeout(timeout)
        opts.signal?.removeEventListener('abort', onAbort)
        if (err) {
          this.close()
          reject(err)
        } else resolve(this)
      }
      if (opts.signal?.aborted) onAbort()
    })

    const pc = this.pc
    pc.addEventListener('negotiationneeded', () => void this.negotiate())
    pc.addEventListener('icecandidate', (ev: RTCPeerConnectionIceEvent) => {
      const c = ev.candidate
      this.send({ type: 'candidate', candidate: c ? candidateInit(c) : null })
    })
    pc.addEventListener('connectionstatechange', () => this.onPcState())
    pc.addEventListener('iceconnectionstatechange', () => this.onPcState())
    pc.addEventListener('track', (ev: RTCTrackEvent) => this.trackEv.emit(ev.track, ev.streams))

    this.ctl = pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
      ordered: true,
    })
    this.ctl.addEventListener('open', () => {
      const q = this.ctlQueue
      this.ctlQueue = []
      for (const m of q) this.ctl.send(m)
    })
    this.ctl.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      try {
        this.onControl(JSON.parse(ev.data) as ControlMessage)
      } catch {
        // malformed control message
      }
    })

    this.unsubPipe = this.pipe.onMessage((m) => {
      this.signalChain = this.signalChain
        .then(() => this.onSignal(m))
        .catch((err) => this.errorEv.emit(err instanceof Error ? err : new Error(String(err))))
    })
  }

  ready(): Promise<Connection> {
    return this.readyPromise
  }

  get path(): PathType {
    return this._path
  }

  get state(): Connection['state'] {
    return this._state
  }

  // ------------------------------------------------------------- negotiation

  private send(m: TransportSignal): void {
    if (this._state === 'closed') return
    this.pipe.send(m)
  }

  private async negotiate(): Promise<void> {
    if (this._state === 'closed') return
    try {
      this.makingOffer = true
      await this.pc.setLocalDescription()
      const d = this.pc.localDescription
      if (d && d.type === 'offer') this.send({ type: 'offer', sdp: d.sdp })
    } catch (err) {
      this.errorEv.emit(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.makingOffer = false
    }
  }

  private async onSignal(m: TransportSignal): Promise<void> {
    if (this._state === 'closed') return
    const pc = this.pc
    if (m.type === 'offer' || m.type === 'answer') {
      const sdp = (m as { sdp: string }).sdp
      const readyForOffer =
        !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswerPending)
      const collision = m.type === 'offer' && !readyForOffer
      this.ignoreOffer = !this.polite && collision
      if (this.ignoreOffer) return
      this.settingRemoteAnswerPending = m.type === 'answer'
      try {
        await pc.setRemoteDescription({ type: m.type as 'offer' | 'answer', sdp })
      } finally {
        this.settingRemoteAnswerPending = false
      }
      await this.drainCandidates()
      if (m.type === 'offer') {
        await pc.setLocalDescription()
        const d = pc.localDescription
        if (d) this.send({ type: 'answer', sdp: d.sdp })
      }
      return
    }
    if (m.type === 'candidate') {
      const c = (m as { candidate: RTCIceCandidateInit | null }).candidate
      if (!pc.remoteDescription) {
        this.pendingCandidates.push(c)
        return
      }
      await this.addCandidate(c)
      return
    }
    if (m.type === 'restart') {
      if (this.initiator) this.restartIce(true)
    }
  }

  private async addCandidate(c: RTCIceCandidateInit | null): Promise<void> {
    try {
      if (c?.candidate) await this.pc.addIceCandidate(c)
      // null / empty candidate = end-of-candidates; older stacks reject it, so skip.
    } catch (err) {
      if (!this.ignoreOffer) this.errorEv.emit(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async drainCandidates(): Promise<void> {
    const list = this.pendingCandidates
    this.pendingCandidates = []
    for (const c of list) await this.addCandidate(c)
  }

  // ------------------------------------------------------------- state / ICE restart

  private onPcState(): void {
    if (this._state === 'closed') return
    const s = connectionStateOf(this.pc)
    if (s === 'connected') {
      clearTimeout(this.disconnectTimer)
      clearTimeout(this.restartTimer)
      this.disconnectTimer = undefined
      this.restartTimer = undefined
      this.restartPending = false
      this.restarts = 0
      this.setState('connected')
      this.settleReady?.()
      void this.refreshPath()
      return
    }
    if (s === 'failed') {
      if (this._state === 'connected') this.setState('disconnected')
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = undefined
      this.restartIce(false)
      return
    }
    if (s === 'disconnected') {
      if (this._state === 'connected') this.setState('disconnected')
      if (!this.disconnectTimer) {
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = undefined
          if (connectionStateOf(this.pc) === 'disconnected') this.restartIce(false)
        }, this.graceMs)
      }
      return
    }
    if (s === 'closed') this.close()
  }

  /** Initiator runs restartIce(); the responder asks the initiator to over the pipe. */
  private restartIce(requestedByRemote: boolean): void {
    if (this._state === 'closed') return
    if (this.restartPending && requestedByRemote) return
    if (!this.restartPending) {
      if (this.restarts >= this.maxRestarts) {
        this.close()
        return
      }
      this.restarts++
      this.restartPending = true
      // If this attempt does not reconnect, try again (or give up after maxRestarts).
      clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        if (connectionStateOf(this.pc) === 'connected') return
        this.restartPending = false
        this.restartIce(false)
      }, this.restartTimeoutMs)
    }
    if (this.initiator) this.pc.restartIce()
    else this.send({ type: 'restart' })
  }

  private setState(s: Connection['state']): void {
    if (this._state === s) return
    this._state = s
    this.stateEv.emit(s)
  }

  // ------------------------------------------------------------- paths and stats

  private async selectedPair(): Promise<{
    pair?: Record<string, unknown>
    local?: Record<string, unknown>
    remote?: Record<string, unknown>
    transport?: Record<string, unknown>
  }> {
    const report = await this.pc.getStats()
    let transport: Record<string, unknown> | undefined
    let pair: Record<string, unknown> | undefined
    const all = new Map<string, Record<string, unknown>>()
    report.forEach((s: Record<string, unknown>) => {
      all.set(s.id as string, s)
      if (s.type === 'transport' && !transport) transport = s
    })
    const pairId = transport?.selectedCandidatePairId as string | undefined
    if (pairId) pair = all.get(pairId)
    if (!pair) {
      for (const s of all.values()) {
        if (s.type !== 'candidate-pair') continue
        if (s.selected === true || (s.nominated === true && s.state === 'succeeded')) {
          pair = s
          break
        }
      }
    }
    const local = pair ? all.get(pair.localCandidateId as string) : undefined
    const remote = pair ? all.get(pair.remoteCandidateId as string) : undefined
    return { pair, local, remote, transport }
  }

  private async refreshPath(): Promise<PathType> {
    try {
      const { local, remote } = await this.selectedPair()
      if (local || remote) {
        const p = pathFromCandidates(
          local?.candidateType as string | undefined,
          remote?.candidateType as string | undefined,
        )
        if (p !== this._path) {
          this._path = p
          this.pathEv.emit(p)
        }
      }
    } catch {
      // stats unavailable (closed pc)
    }
    return this._path
  }

  async stats(): Promise<ConnectionStats> {
    const out: ConnectionStats = { path: this._path, bytesSent: 0, bytesReceived: 0 }
    try {
      const { pair, local, remote, transport } = await this.selectedPair()
      const src = pair ?? transport
      out.bytesSent = Number(src?.bytesSent ?? transport?.bytesSent ?? 0)
      out.bytesReceived = Number(src?.bytesReceived ?? transport?.bytesReceived ?? 0)
      const rtt = pair?.currentRoundTripTime
      if (typeof rtt === 'number') out.rttMs = rtt * 1000
      if (typeof local?.candidateType === 'string') out.localCandidateType = local.candidateType
      if (typeof remote?.candidateType === 'string') out.remoteCandidateType = remote.candidateType
      if (local || remote) {
        const p = pathFromCandidates(out.localCandidateType, out.remoteCandidateType)
        if (p !== this._path) {
          this._path = p
          this.pathEv.emit(p)
        }
        out.path = p
      }
    } catch {
      // closed
    }
    return out
  }

  // ------------------------------------------------------------- channels

  private sendControl(m: ControlMessage): void {
    const s = JSON.stringify(m)
    if (this.ctl.readyState === 'open') this.ctl.send(s)
    else if (this.ctl.readyState === 'connecting') this.ctlQueue.push(s)
  }

  private createDc(label: string, id: number, rel: Reliability): RTCDataChannel {
    return this.pc.createDataChannel(label, { ...reliabilityToInit(rel), negotiated: true, id })
  }

  private allocateId(): number {
    const id = this.nextId
    if (id > MAX_CHANNEL_ID) throw new Error('out of data channel ids')
    this.nextId += 2
    return id
  }

  private readonly onChannelClosedLocally = (ch: WebRTCChannel): void => {
    if (this.channels.get(ch.label) === ch) this.channels.delete(ch.label)
    this.sendControl({ t: 'close', label: ch.label, id: ch.id })
  }

  private track(ch: WebRTCChannel): void {
    this.channels.set(ch.label, ch)
    ch.onClose(() => {
      if (this.channels.get(ch.label) === ch) this.channels.delete(ch.label)
    })
  }

  openChannel(label: string, reliability: Reliability): Channel {
    if (this._state === 'closed') throw new Error('connection is closed')
    if (label === CONTROL_CHANNEL_LABEL) throw new Error(`"${label}" is reserved`)
    const existing = this.channels.get(label)
    if (existing) return existing
    const id = this.allocateId()
    const ch = new WebRTCChannel(
      label,
      reliability,
      this.createDc(label, id, reliability),
      false,
      this.onChannelClosedLocally,
    )
    this.track(ch)
    this.sendControl({ t: 'open', label, id, rel: reliability })
    return ch
  }

  private onControl(m: ControlMessage): void {
    if (this._state === 'closed' || typeof m?.label !== 'string') return
    const ch = this.channels.get(m.label)
    switch (m.t) {
      case 'open': {
        if (ch) {
          if (ch.id === m.id) {
            ch.acked = true
            ch.check()
          } else if (m.id < ch.id) {
            // Both sides opened the same label at once: the lower id wins.
            const old = ch.dc
            ch.acked = true
            ch.bind(this.createDc(m.label, m.id, ch.reliability))
            try {
              old.close()
            } catch {
              // ignore
            }
          } else {
            return // ours wins; the remote adopts our id when our 'open' arrives
          }
          this.sendControl({ t: 'ack', label: m.label, id: m.id })
          return
        }
        const fresh = new WebRTCChannel(
          m.label,
          m.rel,
          this.createDc(m.label, m.id, m.rel),
          true,
          this.onChannelClosedLocally,
        )
        this.track(fresh)
        this.sendControl({ t: 'ack', label: m.label, id: m.id })
        if (this.channelEv.size > 0) this.channelEv.emit(fresh)
        else this.unclaimed.push(fresh)
        return
      }
      case 'ack': {
        if (ch && ch.id === m.id) {
          ch.acked = true
          ch.check()
        }
        return
      }
      case 'close': {
        if (ch && ch.id === m.id) {
          this.channels.delete(m.label)
          try {
            ch.dc.close()
          } catch {
            // ignore
          }
          ch.markClosed()
        }
        return
      }
    }
  }

  onChannel(cb: (channel: Channel) => void): Unsubscribe {
    const off = this.channelEv.on(cb)
    if (this.unclaimed.length) {
      const list = this.unclaimed.splice(0)
      queueMicrotask(() => {
        for (const ch of list) if (ch.readyState !== 'closed') cb(ch)
      })
    }
    return off
  }

  onStateChange(cb: (state: Connection['state']) => void): Unsubscribe {
    return this.stateEv.on(cb)
  }

  /** Fires when the detected path (direct/turn) changes. Not part of the Connection contract. */
  onPathChange(cb: (path: PathType) => void): Unsubscribe {
    return this.pathEv.on(cb)
  }

  /** Non-fatal negotiation errors (for telemetry/debugging). */
  onError(cb: (err: Error) => void): Unsubscribe {
    return this.errorEv.on(cb)
  }

  // ------------------------------------------------------------- media

  addStream(stream: MediaStream): void {
    if (this.senders.has(stream.id)) return
    this.senders.set(
      stream.id,
      stream.getTracks().map((t) => this.pc.addTrack(t, stream)),
    )
  }

  removeStream(stream: MediaStream): void {
    const list = this.senders.get(stream.id)
    if (!list) return
    this.senders.delete(stream.id)
    for (const s of list) {
      try {
        this.pc.removeTrack(s)
      } catch {
        // closed
      }
    }
  }

  onTrack(cb: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void): Unsubscribe {
    return this.trackEv.on(cb)
  }

  // ------------------------------------------------------------- teardown

  close(): void {
    if (this._state === 'closed') return
    clearTimeout(this.disconnectTimer)
    clearTimeout(this.restartTimer)
    this.unsubPipe()
    for (const ch of [...this.channels.values()]) {
      try {
        ch.dc.close()
      } catch {
        // ignore
      }
      ch.markClosed()
    }
    this.channels.clear()
    try {
      this.ctl.close()
    } catch {
      // ignore
    }
    try {
      this.pc.close()
    } catch {
      // ignore
    }
    this.setState('closed')
    this.settleReady?.(new Error('connection closed before it was established'))
    this.stateEv.clear()
    this.channelEv.clear()
    this.trackEv.clear()
    this.pathEv.clear()
  }
}

type PcState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

/** connectionState where supported, otherwise derived from iceConnectionState. */
function connectionStateOf(pc: RTCPeerConnection): PcState {
  if (pc.connectionState) return pc.connectionState
  switch (pc.iceConnectionState) {
    case 'connected':
    case 'completed':
      return 'connected'
    case 'checking':
      return 'connecting'
    default:
      return pc.iceConnectionState as PcState
  }
}

function candidateInit(c: RTCIceCandidate): RTCIceCandidateInit {
  if (typeof c.toJSON === 'function') return c.toJSON()
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment,
  }
}
