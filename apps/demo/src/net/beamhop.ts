// DemoRoom backed by the real stack: @beamhop/p2p rooms, Nostr signaling over three public relays and
// WebRTC with public STUN. Written against the API named in docs/PLAN.md (0.x, subject to change).
// The library modules are loaded dynamically and checked at runtime; if they are not built yet this
// throws LibraryUnavailableError and p2p.ts falls back to the BroadcastChannel implementation.
import { APP_ID, colorFor, type DemoConfig } from '../config'
import {
  type ChatMessage,
  type CursorUpdate,
  type DemoPeer,
  type DemoRoom,
  type FileProgress,
  type Hex,
  LibraryUnavailableError,
  type PathKind,
  type PeerTelemetry,
  type SignalLogEntry,
  type TelemetrySnapshot,
  type Unsubscribe,
} from '../p2p'
import { Emitter, messageId, pushCapped } from './emitter'

// ---------------------------------------------------------------- intended library surface

type Reliability =
  | { mode: 'reliable' }
  | { mode: 'unordered' }
  | { mode: 'unreliable'; maxRetransmits: number }

interface LibPeer {
  pubkey: Hex
  meta?: Record<string, unknown>
}

interface LibAction<T> {
  send(data: T, to?: Hex | Hex[]): Promise<void> | void
  on(cb: (data: T, from: LibPeer) => void): Unsubscribe
}

interface LibStreamSendOptions {
  onProgress?: (p: { sent: number; total: number }) => void
}

interface LibStreamChannel {
  send(
    to: Hex,
    stream: ReadableStream<Uint8Array>,
    meta: Record<string, unknown>,
    opts?: LibStreamSendOptions,
  ): Promise<void>
  on(
    cb: (
      incoming: {
        meta: Record<string, unknown>
        stream: ReadableStream<Uint8Array>
        total?: number
      },
      from: LibPeer,
    ) => void,
  ): Unsubscribe
}

interface LibTelemetryEvent {
  type: string
  at: number
  peer?: Hex
  [k: string]: unknown
}

interface LibRoom {
  readonly self: LibPeer
  peers(): LibPeer[]
  onPeerJoin(cb: (p: LibPeer) => void): Unsubscribe
  onPeerLeave(cb: (p: LibPeer) => void): Unsubscribe
  action<T>(name: string): LibAction<T>
  stream(name: string): LibStreamChannel
  addStream?(stream: MediaStream, to?: Hex): void
  removeStream?(stream: MediaStream, to?: Hex): void
  onPeerStream?(cb: (stream: MediaStream, from: LibPeer) => void): Unsubscribe
  telemetry: { subscribe(cb: (e: LibTelemetryEvent) => void): Unsubscribe }
  signalingStatus?(): {
    url: string
    state: 'connecting' | 'open' | 'closed' | 'error'
    error?: string
  }[]
  leave(): Promise<void>
}

interface P2PModule {
  createRoom(opts: Record<string, unknown>): Promise<LibRoom> | LibRoom
  anonymous(opts?: Record<string, unknown>): unknown
  nostr?(opts?: Record<string, unknown>): unknown
  defineProtocol(def: Record<string, unknown>): unknown
  relayTransport?(opts: Record<string, unknown>): unknown
}

interface WebrtcModule {
  webrtcTransport(opts: { iceServers: RTCIceServer[] }): unknown
}

interface NostrSignalingModule {
  nostrSignaling(opts: { relays: string[] }): unknown
}

async function loadLibrary(): Promise<{
  p2p: P2PModule
  webrtc: WebrtcModule
  signaling: NostrSignalingModule
}> {
  let mods: unknown[]
  try {
    mods = await Promise.all([
      import('@beamhop/p2p'),
      // @ts-expect-error -- the webrtc entry point may not exist yet; vite.config.ts stubs it when missing.
      import('@beamhop/p2p/webrtc'),
      import('@beamhop/signaling-nostr'),
    ])
  } catch (err) {
    throw new LibraryUnavailableError(err instanceof Error ? err.message : String(err))
  }
  const [p2p, webrtc, signaling] = mods as [P2PModule, WebrtcModule, NostrSignalingModule]
  const missing = [
    typeof p2p.createRoom !== 'function' && 'createRoom',
    typeof p2p.anonymous !== 'function' && 'anonymous',
    typeof p2p.defineProtocol !== 'function' && 'defineProtocol',
    typeof webrtc.webrtcTransport !== 'function' && 'webrtcTransport',
    typeof signaling.nostrSignaling !== 'function' && 'nostrSignaling',
  ].filter(Boolean)
  if (missing.length) throw new LibraryUnavailableError(`missing ${missing.join(', ')}`)
  return { p2p, webrtc, signaling }
}

// ---------------------------------------------------------------- demo protocol

const UNRELIABLE: Reliability = { mode: 'unreliable', maxRetransmits: 0 }
const RELIABLE: Reliability = { mode: 'reliable' }

/** The demo's typed protocol: one reliable chat action, one unreliable cursor action, one file stream. */
export const demoProtocolDefinition = {
  chat: { reliability: RELIABLE },
  cursor: { reliability: UNRELIABLE, priority: 'low' },
  file: { reliability: RELIABLE, stream: true },
  call: { reliability: RELIABLE },
} as const

interface ChatPayload {
  id: string
  text: string
  at: number
}
interface CursorPayload {
  x: number
  y: number
}

async function turnServersFor(own: NonNullable<DemoConfig['ownRelay']>): Promise<RTCIceServer[]> {
  const base = own.url.replace(/^ws/, 'http').replace(/\/$/, '')
  const res = await fetch(`${base}/a/${encodeURIComponent(own.appId)}/turn-credentials`, {
    method: 'POST',
    headers: own.apiKey ? { Authorization: `Bearer ${own.apiKey}` } : {},
  })
  if (!res.ok) throw new Error(`turn-credentials: HTTP ${res.status}`)
  const body = (await res.json()) as { iceServers: RTCIceServer[] }
  return body.iceServers
}

function pathOf(p: unknown): PathKind {
  return p === 'direct' || p === 'turn' || p === 'relay' || p === 'memory' ? p : 'unknown'
}

export async function joinBeamhopRoom(cfg: DemoConfig): Promise<DemoRoom> {
  const { p2p, webrtc, signaling } = await loadLibrary()

  const log: SignalLogEntry[] = []
  const tel = new Map<Hex, PeerTelemetry>()
  const relays = [...cfg.relays]
  let iceServers = [...cfg.iceServers]
  const transports: unknown[] = []
  if (cfg.ownRelay) {
    const appRealm = `${cfg.ownRelay.url.replace(/\/$/, '')}/a/${cfg.ownRelay.appId}`
    relays.unshift(appRealm)
    try {
      iceServers = [...iceServers, ...(await turnServersFor(cfg.ownRelay))]
      pushCapped(log, { at: Date.now(), direction: 'in', kind: 'turn-credentials' })
    } catch (err) {
      pushCapped(log, {
        at: Date.now(),
        direction: 'in',
        kind: `turn-credentials failed: ${err instanceof Error ? err.message : err}`,
      })
    }
    if (p2p.relayTransport) transports.push(p2p.relayTransport({ url: `${appRealm}/data` }))
  }
  transports.unshift(webrtc.webrtcTransport({ iceServers }))

  const identity =
    cfg.identity === 'nostr' && p2p.nostr
      ? p2p.nostr({ nip07: true })
      : p2p.anonymous({ persist: true })

  const room = await p2p.createRoom({
    appId: cfg.ownRelay?.appId ?? APP_ID,
    roomId: cfg.roomId,
    ...(cfg.password ? { password: cfg.password } : {}),
    identity,
    signaling: signaling.nostrSignaling({ relays }),
    transports,
    topology: 'mesh',
    protocol: p2p.defineProtocol(demoProtocolDefinition),
    meta: { name: cfg.name },
    telemetry: true,
  })

  const selfId = room.self.pubkey
  const self: DemoPeer = {
    id: selfId,
    name: cfg.name,
    color: colorFor(selfId),
    self: true,
    state: 'connected',
  }
  const names = new Map<Hex, string>()
  const peersEv = new Emitter<DemoPeer[]>()
  const fileEv = new Emitter<FileProgress>()
  const telemetryEv = new Emitter<TelemetrySnapshot>()
  const streamEv = new Emitter<{ peer: Hex; stream: MediaStream | null }>()
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
    ...room.peers().map((p) => {
      const t = tel.get(p.pubkey)
      const name =
        (typeof p.meta?.name === 'string' ? p.meta.name : undefined) ??
        names.get(p.pubkey) ??
        p.pubkey.slice(0, 8)
      return {
        id: p.pubkey,
        name,
        color: colorFor(p.pubkey),
        path: t?.path ?? 'unknown',
        ...(t?.rttMs !== undefined ? { rttMs: t.rttMs } : {}),
        state: (t?.state === 'connected' ? 'connected' : 'connecting') as DemoPeer['state'],
      }
    }),
  ]

  const snapshot = (): TelemetrySnapshot => ({
    relays:
      room.signalingStatus?.() ?? relays.map((url) => ({ url, state: 'connecting' as const })),
    peers: Object.fromEntries([...tel].map(([k, v]) => [k, structuredClone(v)])),
    signaling: [...log],
  })

  subs.push(room.onPeerJoin(() => peersEv.emit(peerList())))
  subs.push(
    room.onPeerLeave((p) => {
      tel.delete(p.pubkey)
      streamEv.emit({ peer: p.pubkey, stream: null })
      peersEv.emit(peerList())
    }),
  )
  subs.push(
    room.telemetry.subscribe((e) => {
      const peer = e.peer
      switch (e.type) {
        case 'signal':
          pushCapped(log, {
            at: e.at,
            direction: e.direction === 'in' ? 'in' : 'out',
            kind: String(e.kind),
            ...(peer ? { peer } : {}),
          })
          break
        case 'connection':
          if (peer) {
            const t = peerTel(peer)
            t.state = String(e.state)
            if (e.path) t.path = pathOf(e.path)
          }
          break
        case 'path':
          if (peer) {
            const t = peerTel(peer)
            t.path = pathOf(e.path)
            if (typeof e.candidatePair === 'string') t.candidatePair = e.candidatePair
          }
          break
        case 'rtt':
          if (peer && typeof e.ms === 'number') peerTel(peer).rttMs = Math.round(e.ms)
          break
        case 'bytes':
          if (peer && typeof e.channel === 'string') {
            peerTel(peer).bytes[e.channel] = {
              sent: Number(e.sent) || 0,
              received: Number(e.received) || 0,
            }
          }
          break
      }
    }),
  )
  const timer = setInterval(() => {
    telemetryEv.emit(snapshot())
    peersEv.emit(peerList())
  }, 1000)

  const chat = room.action<ChatPayload>('chat')
  const cursor = room.action<CursorPayload>('cursor')
  const files = room.stream('file')
  const chatEv = new Emitter<ChatMessage>()
  subs.push(
    chat.on((data, from) => {
      const name = typeof from.meta?.name === 'string' ? from.meta.name : from.pubkey.slice(0, 8)
      names.set(from.pubkey, name)
      chatEv.emit({ id: data.id, from: from.pubkey, name, text: data.text, at: data.at })
    }),
  )

  subs.push(
    files.on(async (incoming, from) => {
      const id = String(incoming.meta.id ?? messageId())
      const name = String(incoming.meta.name ?? 'file')
      const mime = String(incoming.meta.mime ?? 'application/octet-stream')
      const total = Number(incoming.meta.size ?? incoming.total ?? 0)
      const parts: Uint8Array[] = []
      let received = 0
      const base = {
        transferId: id,
        peer: from.pubkey,
        direction: 'in' as const,
        name,
        mime,
        total,
      }
      fileEv.emit({ ...base, sent: 0, done: false })
      try {
        const reader = incoming.stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(value)
          received += value.byteLength
          fileEv.emit({ ...base, sent: received, done: false })
        }
        const blob = new Blob(parts as BlobPart[], { type: mime })
        fileEv.emit({ ...base, sent: received, done: true, blob })
      } catch (err) {
        fileEv.emit({ ...base, sent: received, done: true, error: String(err) })
      }
    }),
  )

  let callStream: MediaStream | null = null
  if (room.onPeerStream) {
    subs.push(room.onPeerStream((stream, from) => streamEv.emit({ peer: from.pubkey, stream })))
  }

  const demo: DemoRoom = {
    mode: 'beamhop',
    roomId: cfg.roomId,
    self,
    peers: peerList,
    onPeers: (cb) => peersEv.on(cb),
    sendChat(text) {
      const msg = { id: messageId(), text, at: Date.now() }
      void chat.send(msg)
      // Echo locally so the sender sees its own message immediately.
      chatEv.emit({ ...msg, from: selfId, name: self.name })
    },
    onChat: (cb) => chatEv.on(cb),
    sendCursor(x, y) {
      void cursor.send({ x, y })
    },
    onCursor: (cb) =>
      cursor.on((d, from) => cb({ from: from.pubkey, x: d.x, y: d.y } satisfies CursorUpdate)),
    async sendFile(file, name, onProgress) {
      const id = messageId()
      const mime = file.type || 'application/octet-stream'
      const total = file.size
      await Promise.all(
        room.peers().map(async (p) => {
          const report = (sent: number, extra: Partial<FileProgress> = {}) => {
            const prog: FileProgress = {
              transferId: id,
              peer: p.pubkey,
              direction: 'out',
              name,
              mime,
              sent,
              total,
              done: sent >= total,
              ...extra,
            }
            onProgress?.(prog)
            fileEv.emit(prog)
          }
          try {
            await files.send(
              p.pubkey,
              file.stream() as ReadableStream<Uint8Array>,
              { id, name, mime, size: total },
              { onProgress: ({ sent }) => report(sent) },
            )
            report(total)
          } catch (err) {
            report(0, { done: true, error: String(err) })
          }
        }),
      )
    },
    onFile: (cb) => fileEv.on(cb),
    async startCall(stream) {
      callStream = stream
      room.addStream?.(stream)
    },
    async replaceCallStream(stream) {
      if (callStream) room.removeStream?.(callStream)
      callStream = stream
      room.addStream?.(stream)
    },
    stopCall() {
      if (callStream) room.removeStream?.(callStream)
      callStream = null
    },
    onRemoteStream: (cb) => streamEv.on(({ peer, stream }) => cb(peer, stream)),
    telemetry: snapshot,
    onTelemetry: (cb) => telemetryEv.on(cb),
    async leave() {
      clearInterval(timer)
      for (const off of subs) off()
      await room.leave()
    },
  }
  return demo
}
