// The only place the demo touches a P2P implementation. Screens talk to `DemoRoom`; this module picks
// the real @beamhop/p2p stack (Nostr signaling + WebRTC) or the BroadcastChannel fallback (`?local=1`).
import type { DemoConfig } from './config'

export type Hex = string
export type Unsubscribe = () => void
export type PathKind = 'direct' | 'turn' | 'relay' | 'memory' | 'local' | 'unknown'

export interface DemoPeer {
  id: Hex
  name: string
  color: string
  self?: boolean
  path?: PathKind
  rttMs?: number
  state?: 'connecting' | 'connected' | 'away' | 'disconnected'
}

export interface ChatMessage {
  id: string
  from: Hex
  name: string
  text: string
  at: number
}

export interface CursorUpdate {
  from: Hex
  /** Normalized 0..1 canvas coordinates. */
  x: number
  y: number
}

export interface FileProgress {
  transferId: string
  peer: Hex
  direction: 'in' | 'out'
  name: string
  mime: string
  sent: number
  total: number
  done: boolean
  error?: string
  /** Set on completed incoming transfers. */
  blob?: Blob
}

export interface SignalLogEntry {
  at: number
  direction: 'in' | 'out'
  kind: string
  peer?: Hex
}

export interface RelayStatus {
  url: string
  state: 'connecting' | 'open' | 'closed' | 'error'
  error?: string
}

export interface PeerTelemetry {
  path: PathKind
  state: string
  rttMs?: number
  candidatePair?: string
  bytes: Record<string, { sent: number; received: number }>
}

export interface TelemetrySnapshot {
  relays: RelayStatus[]
  peers: Record<Hex, PeerTelemetry>
  signaling: SignalLogEntry[]
}

export interface DemoRoom {
  readonly mode: 'beamhop' | 'local'
  readonly roomId: string
  readonly self: DemoPeer
  /** Informational banner shown above the room (e.g. why it runs in a degraded mode). */
  readonly notice?: string
  peers(): DemoPeer[]
  onPeers(cb: (peers: DemoPeer[]) => void): Unsubscribe
  sendChat(text: string): void
  onChat(cb: (msg: ChatMessage) => void): Unsubscribe
  /** Unreliable/unordered: latest position wins, drops are fine. */
  sendCursor(x: number, y: number): void
  onCursor(cb: (c: CursorUpdate) => void): Unsubscribe
  /** Sends to every current peer; progress is reported per peer. */
  sendFile(file: File | Blob, name: string, onProgress?: (p: FileProgress) => void): Promise<void>
  onFile(cb: (p: FileProgress) => void): Unsubscribe
  startCall(stream: MediaStream): Promise<void>
  /** Swap the outgoing stream (camera switch, screen share). */
  replaceCallStream(stream: MediaStream): Promise<void>
  stopCall(): void
  onRemoteStream(cb: (peer: Hex, stream: MediaStream | null) => void): Unsubscribe
  telemetry(): TelemetrySnapshot
  onTelemetry(cb: (t: TelemetrySnapshot) => void): Unsubscribe
  leave(): Promise<void>
}

export async function joinDemoRoom(cfg: DemoConfig): Promise<DemoRoom> {
  if (cfg.local) {
    const { joinLocalRoom } = await import('./net/local')
    return joinLocalRoom(cfg)
  }
  const { joinBeamhopRoom } = await import('./net/beamhop')
  return joinBeamhopRoom(cfg)
}
