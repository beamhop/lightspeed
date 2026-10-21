// BroadcastChannel fallback for the demo (`?local=1`). Every tab of the same browser that opens the
// same room joins one channel; presence, chat, cursors, files and RTT run over it, and calls use real
// RTCPeerConnections with the channel as the signaling pipe. No network is involved.
import { colorFor, type DemoConfig } from '../config'
import type {
  ChatMessage,
  CursorUpdate,
  DemoPeer,
  DemoRoom,
  FileProgress,
  Hex,
  PeerTelemetry,
  SignalLogEntry,
  TelemetrySnapshot,
  Unsubscribe,
} from '../p2p'
import { ChatLog, Emitter, messageId, pushCapped } from './emitter'
import { describeCandidatePath, selectedCandidateType } from './rtc'

export const LOCAL_CHUNK_SIZE = 16 * 1024

/** The subset of BroadcastChannel the fallback needs; tests may inject their own bus. */
export interface BusLike {
  postMessage(message: unknown): void
  onmessage: ((ev: MessageEvent) => void) | null
  close(): void
}

export interface LocalRoomOptions {
  notice?: string
  channelFactory?: (name: string) => BusLike
  heartbeatMs?: number
  timeoutMs?: number
  chunkSize?: number
  peerId?: Hex
}

type RtcSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }

export type LocalMessage =
  | { t: 'hello'; from: Hex; name: string; reply?: boolean; inCall?: boolean }
  | { t: 'beat'; from: Hex }
  | { t: 'bye'; from: Hex }
  | { t: 'chat'; from: Hex; id: string; text: string; at: number }
  | { t: 'history'; from: Hex; to: Hex; messages: ChatMessage[] }
  | { t: 'cursor'; from: Hex; x: number; y: number }
  | { t: 'ping'; from: Hex; to: Hex; sentAt: number }
  | { t: 'pong'; from: Hex; to: Hex; sentAt: number }
  | { t: 'file-start'; from: Hex; id: string; name: string; mime: string; size: number }
  | { t: 'file-chunk'; from: Hex; id: string; offset: number; data: ArrayBuffer }
  | { t: 'file-end'; from: Hex; id: string }
  | { t: 'file-ack'; from: Hex; to: Hex; id: string; received: number }
  | { t: 'call'; from: Hex; active: boolean }
  | { t: 'rtc'; from: Hex; to: Hex; signal: RtcSignal }

function randomHex(bytes = 32): Hex {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function localChannelName(roomId: string, password = ''): string {
  return `beamhop-demo/v1/${roomId}/${password}`
}

function approxSize(msg: LocalMessage): number {
  if (msg.t === 'file-chunk') return msg.data.byteLength
  return JSON.stringify(msg).length
}

interface RemoteState {
  peer: DemoPeer
  lastSeen: number
  inCall: boolean
  telemetry: PeerTelemetry
}

interface Incoming {
  from: Hex
  name: string
  mime: string
  size: number
  chunks: { offset: number; data: Uint8Array }[]
  received: number
}

export function joinLocalRoom(cfg: DemoConfig, opts: LocalRoomOptions = {}): DemoRoom {
  const heartbeatMs = opts.heartbeatMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? heartbeatMs * 4
  const chunkSize = opts.chunkSize ?? LOCAL_CHUNK_SIZE
  const factory =
    opts.channelFactory ?? ((name: string) => new BroadcastChannel(name) as unknown as BusLike)
  const bus = factory(localChannelName(cfg.roomId, cfg.password))
  const selfId = opts.peerId ?? randomHex()
  const self: DemoPeer = {
    id: selfId,
    name: cfg.name,
    color: colorFor(selfId),
    self: true,
    path: 'local',
    state: 'connected',
  }

  const remotes = new Map<Hex, RemoteState>()
  const signaling: SignalLogEntry[] = []
  const peersEv = new Emitter<DemoPeer[]>()
  const chatEv = new Emitter<ChatMessage>()
  const cursorEv = new Emitter<CursorUpdate>()
  const fileEv = new Emitter<FileProgress>()
  const streamEv = new Emitter<{ peer: Hex; stream: MediaStream | null }>()
  const telemetryEv = new Emitter<TelemetrySnapshot>()
  const callPeersEv = new Emitter<Hex[]>()
  const chatLog = new ChatLog()
  const incoming = new Map<string, Incoming>()
  const ackWaiters = new Map<string, (from: Hex, received: number) => void>()
  const asked = new Set<Hex>()
  let closed = false

  // ------------------------------------------------------------- transport + accounting

  function account(peer: Hex | 'all', channel: string, sent: number, received: number) {
    const targets = peer === 'all' ? [...remotes.values()] : [remotes.get(peer)].filter(Boolean)
    for (const r of targets as RemoteState[]) {
      const b = r.telemetry.bytes[channel] ?? { sent: 0, received: 0 }
      b.sent += sent
      b.received += received
      r.telemetry.bytes[channel] = b
    }
  }

  function channelOf(msg: LocalMessage): string {
    if (msg.t === 'chat' || msg.t === 'history') return 'chat'
    if (msg.t === 'cursor') return 'cursor'
    if (msg.t.startsWith('file')) return 'file'
    if (msg.t === 'ping' || msg.t === 'pong') return 'ping'
    return 'signal'
  }

  function post(msg: LocalMessage) {
    if (closed) return
    bus.postMessage(msg)
    const to = 'to' in msg ? msg.to : 'all'
    account(to, channelOf(msg), approxSize(msg), 0)
    if (msg.t === 'hello' || msg.t === 'bye' || msg.t === 'rtc' || msg.t === 'call') {
      pushCapped(signaling, {
        at: Date.now(),
        direction: 'out',
        kind: msg.t === 'rtc' ? msg.signal.type : msg.t,
        ...('to' in msg ? { peer: msg.to } : {}),
      })
    }
  }

  function peerList(): DemoPeer[] {
    return [self, ...[...remotes.values()].map((r) => r.peer)]
  }

  function emitPeers() {
    peersEv.emit(peerList())
  }

  const callPeers = () => [...remotes].filter(([, r]) => r.inCall).map(([id]) => id)
  function setInCall(r: RemoteState, inCall: boolean) {
    if (r.inCall === inCall) return
    r.inCall = inCall
    callPeersEv.emit(callPeers())
  }

  function addChat(m: ChatMessage) {
    if (chatLog.add(m)) chatEv.emit(m)
  }

  function snapshot(): TelemetrySnapshot {
    const peers: Record<Hex, PeerTelemetry> = {}
    for (const [id, r] of remotes) peers[id] = structuredClone(r.telemetry)
    return {
      relays: [{ url: 'BroadcastChannel (this browser)', state: closed ? 'closed' : 'open' }],
      peers,
      signaling: [...signaling],
    }
  }

  function upsertPeer(id: Hex, name: string, inCall?: boolean): RemoteState {
    let r = remotes.get(id)
    if (!r) {
      r = {
        peer: { id, name, color: colorFor(id), path: 'local', state: 'connected' },
        lastSeen: Date.now(),
        inCall: false,
        telemetry: { path: 'local', state: 'connected', bytes: {} },
      }
      remotes.set(id, r)
      emitPeers()
      // Catch the newcomer up on chat it missed.
      const messages = chatLog.all()
      if (messages.length) post({ t: 'history', from: selfId, to: id, messages })
      if (localStream) {
        void ensurePc(id)
      }
    } else if (r.peer.name !== name) {
      r.peer = { ...r.peer, name }
      emitPeers()
    }
    r.lastSeen = Date.now()
    if (inCall !== undefined) setInCall(r, inCall)
    return r
  }

  function dropPeer(id: Hex) {
    const r = remotes.get(id)
    if (!r) return
    remotes.delete(id)
    if (r.inCall) callPeersEv.emit(callPeers())
    closePc(id)
    ackWaiters.forEach((cb) => {
      cb(id, Number.POSITIVE_INFINITY)
    })
    emitPeers()
  }

  // ------------------------------------------------------------- receive

  bus.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as LocalMessage
    if (!msg || typeof msg !== 'object' || msg.from === selfId || closed) return
    if ('to' in msg && msg.to !== selfId) return
    if (msg.t !== 'hello' && msg.t !== 'bye' && !remotes.has(msg.from) && !asked.has(msg.from)) {
      // Unknown peer (its hello predates us or was lost): introduce ourselves once; it replies.
      asked.add(msg.from)
      post({ t: 'hello', from: selfId, name: self.name, inCall: !!localStream })
    }
    const r = remotes.get(msg.from)
    if (r) {
      r.lastSeen = Date.now()
      account(msg.from, channelOf(msg), 0, approxSize(msg))
    }
    if (msg.t === 'hello' || msg.t === 'bye' || msg.t === 'rtc' || msg.t === 'call') {
      pushCapped(signaling, {
        at: Date.now(),
        direction: 'in',
        kind: msg.t === 'rtc' ? msg.signal.type : msg.t,
        peer: msg.from,
      })
    }
    switch (msg.t) {
      case 'hello': {
        const known = remotes.has(msg.from)
        upsertPeer(msg.from, msg.name, msg.inCall)
        if (!known && !msg.reply) {
          post({ t: 'hello', from: selfId, name: self.name, reply: true, inCall: !!localStream })
        }
        if (msg.inCall) void ensurePc(msg.from)
        break
      }
      case 'beat':
        break
      case 'bye':
        dropPeer(msg.from)
        break
      case 'chat': {
        const name = remotes.get(msg.from)?.peer.name ?? msg.from.slice(0, 8)
        addChat({ id: msg.id, from: msg.from, name, text: msg.text, at: msg.at })
        break
      }
      case 'history':
        for (const m of msg.messages) addChat(m)
        break
      case 'cursor':
        cursorEv.emit({ from: msg.from, x: msg.x, y: msg.y })
        break
      case 'ping':
        post({ t: 'pong', from: selfId, to: msg.from, sentAt: msg.sentAt })
        break
      case 'pong': {
        const rt = remotes.get(msg.from)
        if (rt) {
          const ms = Math.max(0, Math.round(performance.now() - msg.sentAt))
          rt.telemetry.rttMs = ms
          rt.peer = { ...rt.peer, rttMs: ms }
          emitPeers()
        }
        break
      }
      case 'file-start':
        incoming.set(msg.id, {
          from: msg.from,
          name: msg.name,
          mime: msg.mime,
          size: msg.size,
          chunks: [],
          received: 0,
        })
        fileEv.emit({
          transferId: msg.id,
          peer: msg.from,
          direction: 'in',
          name: msg.name,
          mime: msg.mime,
          sent: 0,
          total: msg.size,
          done: false,
        })
        break
      case 'file-chunk': {
        const inc = incoming.get(msg.id)
        if (!inc) break
        inc.chunks.push({ offset: msg.offset, data: new Uint8Array(msg.data) })
        inc.received += msg.data.byteLength
        post({ t: 'file-ack', from: selfId, to: msg.from, id: msg.id, received: inc.received })
        fileEv.emit({
          transferId: msg.id,
          peer: msg.from,
          direction: 'in',
          name: inc.name,
          mime: inc.mime,
          sent: inc.received,
          total: inc.size,
          done: false,
        })
        break
      }
      case 'file-end': {
        const inc = incoming.get(msg.id)
        if (!inc) break
        incoming.delete(msg.id)
        inc.chunks.sort((a, b) => a.offset - b.offset)
        const blob = new Blob(
          inc.chunks.map((c) => c.data as BlobPart),
          { type: inc.mime },
        )
        const ok = blob.size === inc.size
        // Empty files have no chunks, so acknowledge completion explicitly.
        post({ t: 'file-ack', from: selfId, to: msg.from, id: msg.id, received: blob.size })
        fileEv.emit({
          transferId: msg.id,
          peer: msg.from,
          direction: 'in',
          name: inc.name,
          mime: inc.mime,
          sent: blob.size,
          total: inc.size,
          done: true,
          ...(ok ? { blob } : { error: `expected ${inc.size} bytes, got ${blob.size}` }),
        })
        break
      }
      case 'file-ack':
        ackWaiters.get(msg.id)?.(msg.from, msg.received)
        break
      case 'call': {
        const rc = remotes.get(msg.from)
        if (rc) setInCall(rc, msg.active)
        if (msg.active) void ensurePc(msg.from)
        else {
          streamEv.emit({ peer: msg.from, stream: null })
          if (!localStream) closePc(msg.from)
        }
        break
      }
      case 'rtc':
        void onRtc(msg.from, msg.signal)
        break
    }
  }

  // ------------------------------------------------------------- presence loop

  post({ t: 'hello', from: selfId, name: self.name })
  const timer = setInterval(() => {
    post({ t: 'beat', from: selfId })
    const now = Date.now()
    for (const [id, r] of remotes) {
      if (now - r.lastSeen > timeoutMs) dropPeer(id)
      else post({ t: 'ping', from: selfId, to: id, sentAt: performance.now() })
    }
    telemetryEv.emit(snapshot())
    void refreshCallPaths()
  }, heartbeatMs)
  const onUnload = () => post({ t: 'bye', from: selfId })
  if (typeof addEventListener === 'function') addEventListener('pagehide', onUnload)

  // ------------------------------------------------------------- calls (WebRTC over the bus)

  let localStream: MediaStream | null = null
  const pcs = new Map<Hex, RTCPeerConnection>()
  const remoteStreams = new Map<Hex, MediaStream>()

  function closePc(id: Hex) {
    const pc = pcs.get(id)
    if (pc) {
      pc.close()
      pcs.delete(id)
    }
    if (remoteStreams.delete(id)) streamEv.emit({ peer: id, stream: null })
  }

  function newPc(id: Hex): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcs.set(id, pc)
    pc.onicecandidate = (e) =>
      post({
        t: 'rtc',
        from: selfId,
        to: id,
        // Plain init dict: RTCIceCandidate itself can't be structured-cloned.
        signal: { type: 'candidate', candidate: e.candidate?.toJSON() ?? null },
      })
    pc.ontrack = (e) => {
      let s = remoteStreams.get(id)
      if (!s) {
        s = new MediaStream()
        remoteStreams.set(id, s)
      }
      s.addTrack(e.track)
      streamEv.emit({ peer: id, stream: s })
    }
    return pc
  }

  async function attachLocalTracks(pc: RTCPeerConnection) {
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track?.kind
      const track = localStream?.getTracks().find((x) => x.kind === kind) ?? null
      await t.sender.replaceTrack(track)
    }
  }

  async function ensurePc(id: Hex) {
    if (typeof RTCPeerConnection === 'undefined' || pcs.has(id)) return
    // Deterministic initiator: the lower id creates the offer.
    if (selfId > id) return
    const pc = newPc(id)
    pc.addTransceiver('audio', { direction: 'sendrecv' })
    pc.addTransceiver('video', { direction: 'sendrecv' })
    await attachLocalTracks(pc)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    post({ t: 'rtc', from: selfId, to: id, signal: { type: 'offer', sdp: offer.sdp ?? '' } })
  }

  async function onRtc(from: Hex, signal: RtcSignal) {
    if (typeof RTCPeerConnection === 'undefined') return
    if (signal.type === 'offer') {
      closePc(from)
      const pc = newPc(from)
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
      for (const t of pc.getTransceivers()) t.direction = 'sendrecv'
      await attachLocalTracks(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      post({ t: 'rtc', from: selfId, to: from, signal: { type: 'answer', sdp: answer.sdp ?? '' } })
    } else if (signal.type === 'answer') {
      await pcs.get(from)?.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
    } else if (signal.type === 'candidate') {
      const pc = pcs.get(from)
      if (pc && signal.candidate) await pc.addIceCandidate(signal.candidate).catch(() => {})
    }
  }

  async function refreshCallPaths() {
    for (const [id, pc] of pcs) {
      const r = remotes.get(id)
      if (!r || pc.connectionState !== 'connected') continue
      const sel = await selectedCandidateType(pc).catch(() => null)
      if (sel) r.telemetry.candidatePair = describeCandidatePath(sel.local, sel.remote)
    }
  }

  // ------------------------------------------------------------- public API

  const room: DemoRoom = {
    mode: 'local',
    roomId: cfg.roomId,
    self,
    ...(opts.notice ? { notice: opts.notice } : {}),
    peers: peerList,
    onPeers: (cb) => peersEv.on(cb),
    sendChat(text) {
      const msg: ChatMessage = {
        id: messageId(),
        from: selfId,
        name: self.name,
        text,
        at: Date.now(),
      }
      post({ t: 'chat', from: selfId, id: msg.id, text, at: msg.at })
      addChat(msg)
    },
    messages: () => chatLog.all(),
    onChat: (cb) => chatEv.on(cb),
    sendCursor(x, y) {
      post({ t: 'cursor', from: selfId, x, y })
    },
    onCursor: (cb) => cursorEv.on(cb),
    async sendFile(file, name, onProgress) {
      const id = messageId()
      const total = file.size
      const mime = file.type || 'application/octet-stream'
      const targets = new Map<Hex, number>([...remotes.keys()].map((k) => [k, 0]))
      const report = (peer: Hex, sent: number, extra: Partial<FileProgress> = {}) => {
        const p: FileProgress = {
          transferId: id,
          peer,
          direction: 'out',
          name,
          mime,
          sent: Math.min(sent, total),
          total,
          done: sent >= total,
          ...extra,
        }
        onProgress?.(p)
        fileEv.emit(p)
      }
      const finished = new Promise<void>((resolve) => {
        const check = () => {
          for (const v of targets.values()) if (v < total) return
          ackWaiters.delete(id)
          resolve()
        }
        ackWaiters.set(id, (from, received) => {
          if (!targets.has(from)) return
          if (received === Number.POSITIVE_INFINITY) {
            report(from, targets.get(from) ?? 0, { done: true, error: 'peer left' })
            targets.set(from, total)
          } else {
            targets.set(from, received)
            report(from, received)
          }
          check()
        })
        check()
      })
      post({ t: 'file-start', from: selfId, id, name, mime, size: total })
      const buf = new Uint8Array(await file.arrayBuffer())
      for (let offset = 0; offset < buf.length; offset += chunkSize) {
        const data = buf.slice(offset, offset + chunkSize).buffer
        post({ t: 'file-chunk', from: selfId, id, offset, data })
        // Yield so acks and UI updates interleave with the send loop.
        await new Promise((r) => setTimeout(r, 0))
      }
      post({ t: 'file-end', from: selfId, id })
      await finished
    },
    onFile: (cb) => fileEv.on(cb),
    async startCall(stream) {
      localStream = stream
      post({ t: 'call', from: selfId, active: true })
      for (const id of remotes.keys()) await ensurePc(id)
      for (const pc of pcs.values()) await attachLocalTracks(pc)
    },
    async replaceCallStream(stream) {
      localStream = stream
      for (const pc of pcs.values()) await attachLocalTracks(pc)
    },
    stopCall() {
      localStream = null
      post({ t: 'call', from: selfId, active: false })
      for (const [id, pc] of pcs) {
        if (remotes.get(id)?.inCall) void attachLocalTracks(pc)
        else closePc(id)
      }
    },
    onRemoteStream: (cb) => streamEv.on(({ peer, stream }) => cb(peer, stream)),
    callPeers,
    onCallPeers: (cb) => callPeersEv.on(cb),
    telemetry: snapshot,
    onTelemetry: (cb) => telemetryEv.on(cb),
    async leave() {
      if (closed) return
      post({ t: 'bye', from: selfId })
      closed = true
      clearInterval(timer)
      if (typeof removeEventListener === 'function') removeEventListener('pagehide', onUnload)
      for (const id of [...pcs.keys()]) closePc(id)
      bus.onmessage = null
      bus.close()
      for (const e of [peersEv, chatEv, cursorEv, fileEv, streamEv, callPeersEv, telemetryEv]) {
        e.clear()
      }
    },
  }
  return room
}

export type { Unsubscribe }
