// DemoRoom backed by the real stack: an @beamhop/p2p room with Nostr signaling over public relays
// (@beamhop/signaling-nostr). The data path follows `cfg.transport`:
//   p2p   WebRTC data channels over public STUN (@beamhop/p2p/webrtc)
//   turn  WebRTC with TURN credentials from your relay and `iceTransportPolicy: 'relay'`
//   relay the WebSocket data relay at wss://<relay>/a/<appId>/data
// TURN and relay also add the app realm on your relay for signaling.
//
// Calls use a separate RTCPeerConnection per peer for media, negotiated over the room's reliable
// `call` action (the room API carries data only).
import {
  action,
  anonymous,
  any,
  createRoom,
  defineProtocol,
  type Hex,
  type Identity,
  type IdentityProvider,
  nostr,
  type Peer,
  type RoomTimeouts,
  relayTransport,
  type SignalingAdapter,
  type SignalingFactory,
  type Transport,
} from '@beamhop/p2p'
import { webrtcTransport } from '@beamhop/p2p/webrtc'
import { nostrSignaling, signEvent } from '@beamhop/signaling-nostr'
import { APP_ID, colorFor, type DemoConfig, needsOwnRelay } from '../config'
import type {
  ChatMessage,
  DemoPeer,
  DemoRoom,
  FileProgress,
  PathKind,
  PeerTelemetry,
  SignalLogEntry,
  TelemetrySnapshot,
  Unsubscribe,
} from '../p2p'
import { ChatLog, Emitter, messageId, pushCapped } from './emitter'
import { describeCandidatePath, selectedCandidateType } from './rtc'

// ---------------------------------------------------------------- demo protocol

interface ChatPayload {
  id: string
  text: string
  at: number
}
interface CursorPayload {
  x: number
  y: number
}
type RtcSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }
type CallPayload = { t: 'state'; active: boolean } | { t: 'rtc'; signal: RtcSignal }
interface HistoryPayload {
  messages: { id: string; from: Hex; name: string; text: string; at: number }[]
}

/**
 * The demo's typed protocol: reliable chat (plus a history catch-up sent to late joiners),
 * unreliable low-priority cursors, call negotiation.
 */
export const demoProtocol = defineProtocol({
  chat: action(any<ChatPayload>()),
  history: action(any<HistoryPayload>(), { priority: 'low' }),
  cursor: action(any<CursorPayload>(), { reliability: 'unreliable', priority: 'low' }),
  call: action(any<CallPayload>(), { priority: 'high' }),
})

/**
 * Test/embedding hooks: replace signaling, transports and identity (e.g. memorySignaling +
 * memoryTransport in bun tests). Not part of the UI.
 */
export interface BeamhopInternals {
  signaling?: SignalingFactory
  transports?: Transport[]
  identity?: IdentityProvider | Identity
  timeouts?: RoomTimeouts
  /** Telemetry snapshot interval (default 1000 ms). */
  tickMs?: number
}

const NIP98_KIND = 27235

/**
 * Mints TURN credentials from `POST /a/<appId>/turn-credentials`: with the API key when given,
 * otherwise with a NIP-98 event signed by the room identity (so link joiners need no key).
 */
export async function turnServersFor(
  own: NonNullable<DemoConfig['ownRelay']>,
  identity: Pick<Identity, 'pubkey' | 'sign'>,
  fetchImpl: typeof fetch = fetch,
): Promise<RTCIceServer[]> {
  const base = own.url.replace(/^ws/, 'http').replace(/\/$/, '')
  const url = `${base}/a/${encodeURIComponent(own.appId)}/turn-credentials`
  let authorization: string
  if (own.apiKey) {
    authorization = `Bearer ${own.apiKey}`
  } else {
    const ev = await signEvent(
      {
        kind: NIP98_KIND,
        tags: [
          ['u', url],
          ['method', 'POST'],
        ],
        content: '',
      },
      identity,
    )
    authorization = `Nostr ${btoa(JSON.stringify(ev))}`
  }
  const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: authorization } })
  if (!res.ok) throw new Error(`turn-credentials: HTTP ${res.status}`)
  const body = (await res.json()) as { iceServers: RTCIceServer[] }
  return body.iceServers
}

function demoState(p: Peer): DemoPeer['state'] {
  return p.state === 'away' ? 'away' : 'connected'
}

function nameOf(p: Peer | undefined, id: Hex): string {
  const n = p?.meta.name
  return typeof n === 'string' && n ? n : id.slice(0, 8)
}

export async function joinBeamhopRoom(
  cfg: DemoConfig,
  internals: BeamhopInternals = {},
): Promise<DemoRoom> {
  const log: SignalLogEntry[] = []
  const relays = [...cfg.relays]
  let iceServers = [...cfg.iceServers]
  let iceTransportPolicy: RTCIceTransportPolicy = 'all'
  let transports: Transport[]
  let appId = APP_ID

  const identity: Identity = await (async () => {
    const id =
      internals.identity ?? (cfg.identity === 'nostr' ? nostr() : anonymous({ persist: true }))
    return 'load' in id ? id.load() : id
  })()

  const own = needsOwnRelay(cfg.transport) ? cfg.ownRelay : undefined
  if (needsOwnRelay(cfg.transport) && !own) {
    throw new Error(`The ${cfg.transport} transport needs a Beamhop relay URL and app id`)
  }
  const appRealm = own && `${own.url.replace(/\/$/, '')}/a/${own.appId}`
  if (own && appRealm) {
    appId = own.appId
    relays.unshift(appRealm)
    try {
      iceServers = [...iceServers, ...(await turnServersFor(own, identity))]
      pushCapped(log, { at: Date.now(), direction: 'in', kind: 'turn-credentials' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Forced TURN is useless without credentials; the data relay only loses TURN for calls.
      if (cfg.transport === 'turn') throw new Error(`Could not get TURN credentials (${msg})`)
      pushCapped(log, { at: Date.now(), direction: 'in', kind: `turn-credentials failed: ${msg}` })
    }
  }
  if (cfg.transport === 'turn') iceTransportPolicy = 'relay'

  if (internals.transports) {
    transports = internals.transports
  } else if (cfg.transport === 'relay' && appRealm) {
    transports = [relayTransport({ url: `${appRealm}/data`, appId })]
  } else {
    transports = [webrtcTransport({ iceServers, iceTransportPolicy })]
  }

  // Keep a handle on the signaling adapter so the lobby can show per-relay status.
  let adapter: SignalingAdapter | undefined
  const baseSignaling = internals.signaling ?? nostrSignaling({ relays })
  const signaling: SignalingFactory = (ctx) => {
    adapter = baseSignaling(ctx)
    return adapter
  }

  const room = await createRoom({
    appId,
    roomId: cfg.roomId,
    ...(cfg.password ? { password: cfg.password } : {}),
    identity,
    signaling,
    transports,
    iceServers,
    topology: 'mesh',
    protocol: demoProtocol,
    meta: { name: cfg.name },
    ...(internals.timeouts ? { timeouts: internals.timeouts } : {}),
  })

  const selfId = room.self.pubkey
  const self: DemoPeer = {
    id: selfId,
    name: cfg.name,
    color: colorFor(selfId),
    self: true,
    state: 'connected',
  }
  const tel = new Map<Hex, PeerTelemetry>()
  const peersEv = new Emitter<DemoPeer[]>()
  const chatEv = new Emitter<ChatMessage>()
  const fileEv = new Emitter<FileProgress>()
  const telemetryEv = new Emitter<TelemetrySnapshot>()
  const streamEv = new Emitter<{ peer: Hex; stream: MediaStream | null }>()
  const callPeersEv = new Emitter<Hex[]>()
  const chatLog = new ChatLog()
  const subs: Unsubscribe[] = []

  const peerTel = (id: Hex): PeerTelemetry => {
    let t = tel.get(id)
    if (!t) {
      t = { path: 'unknown', state: 'connecting', bytes: {} }
      tel.set(id, t)
    }
    return t
  }

  const peerList = (): DemoPeer[] => [
    self,
    ...room.peers.map((p) => ({
      id: p.pubkey,
      name: nameOf(p, p.pubkey),
      color: colorFor(p.pubkey),
      path: (p.path ?? 'unknown') as PathKind,
      ...(p.rttMs !== undefined ? { rttMs: Math.round(p.rttMs) } : {}),
      state: demoState(p),
    })),
  ]

  const snapshot = (): TelemetrySnapshot => {
    for (const p of room.peers) {
      const t = peerTel(p.pubkey)
      t.state = p.state
      if (p.path) t.path = p.path
      if (p.rttMs !== undefined) t.rttMs = Math.round(p.rttMs)
    }
    return {
      relays: adapter?.status?.() ?? relays.map((url) => ({ url, state: 'connecting' as const })),
      peers: Object.fromEntries([...tel].map(([k, v]) => [k, structuredClone(v)])),
      signaling: [...log],
    }
  }

  subs.push(
    room.telemetry.subscribe((e) => {
      switch (e.type) {
        case 'signal':
          pushCapped(log, {
            at: e.at,
            direction: e.direction,
            kind: String(e.kind),
            ...(e.peer ? { peer: e.peer } : {}),
          })
          break
        case 'connection': {
          const t = peerTel(e.peer)
          t.state = e.state
          if (e.path) t.path = e.path
          break
        }
        case 'path': {
          const t = peerTel(e.peer)
          t.path = e.path
          if (e.candidatePair) t.candidatePair = e.candidatePair
          break
        }
        case 'rtt':
          peerTel(e.peer).rttMs = Math.round(e.ms)
          break
        case 'bytes':
          peerTel(e.peer).bytes[e.channel] = { sent: e.sent, received: e.received }
          break
      }
    }),
  )

  const emitPeers = () => peersEv.emit(peerList())
  subs.push(
    room.onPeerJoin((p) => {
      emitPeers()
      if (localStream) void sendCall(p.pubkey, { t: 'state', active: true })
      // Chat is ephemeral on the wire, so catch the newcomer up with what this peer has seen.
      const messages = chatLog.all()
      if (messages.length) void history.send({ messages }, { to: p.pubkey }).catch(() => {})
    }),
  )
  subs.push(room.onPeerUpdate(emitPeers))
  subs.push(
    room.onPeerLeave((p) => {
      tel.delete(p.pubkey)
      if (inCall.delete(p.pubkey)) emitCallPeers()
      closePc(p.pubkey)
      emitPeers()
    }),
  )

  const timer = setInterval(() => {
    telemetryEv.emit(snapshot())
    emitPeers()
    void refreshCallPaths()
  }, internals.tickMs ?? 1000)

  // ------------------------------------------------------------- chat, cursors

  const chat = room.action('chat')
  const history = room.action('history')
  const cursor = room.action('cursor')
  const addChat = (m: ChatMessage) => {
    if (chatLog.add(m)) chatEv.emit(m)
  }
  subs.push(
    chat.onMessage((data, from) => {
      addChat({
        id: data.id,
        from,
        name: nameOf(room.peer(from), from),
        text: data.text,
        at: data.at,
      })
    }),
  )
  subs.push(
    history.onMessage((data) => {
      for (const m of data.messages ?? []) {
        if (typeof m?.id !== 'string' || typeof m.text !== 'string') continue
        addChat({
          id: m.id,
          from: String(m.from),
          name: String(m.name ?? ''),
          text: m.text.slice(0, 2000),
          at: Number(m.at) || 0,
        })
      }
    }),
  )

  // ------------------------------------------------------------- files

  subs.push(
    room.onFile((f) => {
      const base = {
        transferId: f.id,
        peer: f.from,
        direction: 'in' as const,
        name: f.name,
        mime: f.mime,
        total: f.size ?? 0,
      }
      fileEv.emit({ ...base, sent: 0, done: false })
      f.onProgress((received, total) => {
        fileEv.emit({ ...base, total: total ?? received, sent: received, done: false })
      })
      f.bytes().then(
        (bytes) => {
          const blob = new Blob([bytes as BlobPart], { type: f.mime })
          fileEv.emit({ ...base, total: f.size ?? blob.size, sent: blob.size, done: true, blob })
        },
        (err) => fileEv.emit({ ...base, sent: f.received, done: true, error: String(err) }),
      )
    }),
  )

  // ------------------------------------------------------------- calls

  const call = room.action('call')
  let localStream: MediaStream | null = null
  const inCall = new Set<Hex>()
  const pcs = new Map<Hex, RTCPeerConnection>()
  const remoteStreams = new Map<Hex, MediaStream>()
  const hasRtc = () => typeof RTCPeerConnection !== 'undefined'
  const emitCallPeers = () => callPeersEv.emit([...inCall])

  function sendCall(to: Hex, payload: CallPayload): Promise<void> {
    return call.send(payload, { to }).catch(() => {})
  }

  function closePc(id: Hex) {
    const pc = pcs.get(id)
    if (pc) {
      pc.close()
      pcs.delete(id)
    }
    if (remoteStreams.delete(id)) streamEv.emit({ peer: id, stream: null })
  }

  function newPc(id: Hex): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy })
    pcs.set(id, pc)
    // RTCIceCandidate's fields are prototype getters: send the plain init dict, or the codec
    // serializes `{}` and the receiver reads every candidate as end-of-candidates.
    pc.onicecandidate = (e) =>
      void sendCall(id, {
        t: 'rtc',
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
    if (!hasRtc() || pcs.has(id)) return
    // Deterministic initiator, as in the library: the lower pubkey creates the offer.
    if (selfId > id) return
    const pc = newPc(id)
    pc.addTransceiver('audio', { direction: 'sendrecv' })
    pc.addTransceiver('video', { direction: 'sendrecv' })
    await attachLocalTracks(pc)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await sendCall(id, { t: 'rtc', signal: { type: 'offer', sdp: offer.sdp ?? '' } })
  }

  async function onRtc(from: Hex, signal: RtcSignal) {
    if (!hasRtc()) return
    if (signal.type === 'offer') {
      closePc(from)
      const pc = newPc(from)
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
      for (const t of pc.getTransceivers()) t.direction = 'sendrecv'
      await attachLocalTracks(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await sendCall(from, { t: 'rtc', signal: { type: 'answer', sdp: answer.sdp ?? '' } })
    } else if (signal.type === 'answer') {
      await pcs.get(from)?.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
    } else if (signal.type === 'candidate') {
      const pc = pcs.get(from)
      if (pc && signal.candidate) await pc.addIceCandidate(signal.candidate).catch(() => {})
    }
  }

  subs.push(
    call.onMessage((msg, from) => {
      if (msg.t === 'state') {
        if (msg.active) {
          if (!inCall.has(from)) {
            inCall.add(from)
            emitCallPeers()
          }
          void ensurePc(from)
        } else {
          if (inCall.delete(from)) emitCallPeers()
          streamEv.emit({ peer: from, stream: null })
          if (!localStream) closePc(from)
        }
      } else if (msg.t === 'rtc') {
        void onRtc(from, msg.signal).catch((err) => console.warn('call negotiation failed', err))
      }
    }),
  )

  async function refreshCallPaths() {
    for (const [id, pc] of pcs) {
      if (pc.connectionState !== 'connected') continue
      const sel = await selectedCandidateType(pc).catch(() => null)
      if (sel) peerTel(id).candidatePair = describeCandidatePath(sel.local, sel.remote)
    }
  }

  // ------------------------------------------------------------- DemoRoom

  let closed = false
  const demo: DemoRoom = {
    mode: 'beamhop',
    roomId: cfg.roomId,
    self,
    peers: peerList,
    onPeers: (cb) => peersEv.on(cb),
    sendChat(text) {
      const msg = { id: messageId(), text, at: Date.now() }
      void chat.send(msg).catch((err) => console.warn('chat send failed', err))
      // Echo locally so the sender sees its own message immediately.
      addChat({ ...msg, from: selfId, name: self.name })
    },
    messages: () => chatLog.all(),
    onChat: (cb) => chatEv.on(cb),
    sendCursor(x, y) {
      void cursor.send({ x, y }).catch(() => {})
    },
    onCursor: (cb) => cursor.onMessage((d, from) => cb({ from, x: d.x, y: d.y })),
    async sendFile(file, name, onProgress) {
      const id = messageId()
      const mime = file.type || 'application/octet-stream'
      const total = file.size
      await Promise.all(
        room.peers.map(async (p) => {
          const report = (sent: number, extra: Partial<FileProgress> = {}) => {
            const prog: FileProgress = {
              transferId: id,
              peer: p.pubkey,
              direction: 'out',
              name,
              mime,
              sent,
              total,
              done: false,
              ...extra,
            }
            onProgress?.(prog)
            fileEv.emit(prog)
          }
          try {
            report(0)
            await room.sendFile(file, {
              to: p.pubkey,
              name,
              mime,
              size: total,
              onProgress: (sent) => {
                if (sent < total) report(sent)
              },
            })
            report(total, { done: true })
          } catch (err) {
            report(0, { done: true, error: String(err) })
          }
        }),
      )
    },
    onFile: (cb) => fileEv.on(cb),
    async startCall(stream) {
      localStream = stream
      await Promise.all(room.peers.map((p) => sendCall(p.pubkey, { t: 'state', active: true })))
      for (const p of room.peers) await ensurePc(p.pubkey)
      for (const pc of pcs.values()) await attachLocalTracks(pc)
    },
    async replaceCallStream(stream) {
      localStream = stream
      for (const pc of pcs.values()) await attachLocalTracks(pc)
    },
    stopCall() {
      localStream = null
      for (const p of room.peers) void sendCall(p.pubkey, { t: 'state', active: false })
      for (const [id, pc] of pcs) {
        if (inCall.has(id)) void attachLocalTracks(pc)
        else closePc(id)
      }
    },
    onRemoteStream: (cb) => streamEv.on(({ peer, stream }) => cb(peer, stream)),
    callPeers: () => [...inCall],
    onCallPeers: (cb) => callPeersEv.on(cb),
    telemetry: snapshot,
    onTelemetry: (cb) => telemetryEv.on(cb),
    async leave() {
      if (closed) return
      closed = true
      clearInterval(timer)
      for (const off of subs) off()
      for (const id of [...pcs.keys()]) closePc(id)
      await room.leave()
      for (const e of [peersEv, chatEv, fileEv, streamEv, callPeersEv, telemetryEv]) e.clear()
    },
  }
  return demo
}
