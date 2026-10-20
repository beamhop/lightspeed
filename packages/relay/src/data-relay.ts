import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  type RelayControl,
  relayHelloHash,
} from '@beamhop/p2p/wire'
import type { ServerWebSocket } from 'bun'
import type { AppStore } from './apps'
import type { BanStore } from './policy'
import { DATA_METRICS, type UsageMeter } from './usage'
import { isHex64, randomHex, verifySchnorr } from './util/crypto'

export interface DataSocketData {
  route: 'data'
  appId: string
  ip: string
  challenge: string
  pubkey: string | null
  windowStart: number
  windowCount: number
}

type WS = ServerWebSocket<DataSocketData>

/**
 * wss://host/a/<appId>/data — authenticates peers with a signed challenge (wire.ts RelayControl)
 * and forwards opaque envelopes between pubkeys of the same app, counting bytes per app.
 */
export class DataRelay {
  private peers = new Map<string, Map<string, WS>>()
  private connections = 0
  framesForwarded = 0

  constructor(
    private apps: AppStore,
    private bans: BanStore,
    private meter: UsageMeter,
    readonly opts: { maxFrameBytes: number; messagesPerSecond: number },
  ) {}

  socketData(appId: string, ip: string): DataSocketData {
    return {
      route: 'data',
      appId,
      ip,
      challenge: randomHex(32),
      pubkey: null,
      windowStart: 0,
      windowCount: 0,
    }
  }

  private send(ws: WS, msg: RelayControl) {
    ws.send(JSON.stringify(msg))
  }

  private fail(ws: WS, code: string, message: string, close = false) {
    this.send(ws, { type: 'error', code, message })
    if (close) ws.close(4000, code)
  }

  open(ws: WS) {
    this.connections++
    this.send(ws, { type: 'challenge', challenge: ws.data.challenge })
  }

  message(ws: WS, msg: string | Buffer) {
    const d = ws.data
    if (this.opts.messagesPerSecond > 0) {
      const t = Date.now()
      if (t - d.windowStart >= 1000) {
        d.windowStart = t
        d.windowCount = 0
      }
      if (++d.windowCount > this.opts.messagesPerSecond)
        return this.fail(ws, 'rate-limited', 'too many messages')
    }
    if (typeof msg === 'string') return this.control(ws, msg)
    if (!d.pubkey) return this.fail(ws, 'not-authenticated', 'send hello first', true)
    const app = this.apps.active(d.appId)
    if (!app) return this.fail(ws, 'app-disabled', 'app is disabled or deleted', true)
    if (msg.byteLength > this.opts.maxFrameBytes)
      return this.fail(ws, 'too-large', 'frame exceeds the size limit')
    this.meter.add(d.appId, 'data_bytes_in', msg.byteLength)
    if (
      app.dataMonthlyBytes > 0 &&
      this.meter.month(d.appId, DATA_METRICS) >= app.dataMonthlyBytes
    ) {
      return this.fail(ws, 'quota-exceeded', 'monthly data relay quota exhausted')
    }
    let env: { pubkey: string; body: Uint8Array }
    try {
      env = decodeRelayEnvelope(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength))
    } catch {
      return this.fail(ws, 'bad-envelope', 'malformed relay envelope')
    }
    const dest = this.peers.get(d.appId)?.get(env.pubkey)
    if (!dest) return this.send(ws, { type: 'peer-offline', pubkey: env.pubkey })
    const out = encodeRelayEnvelope(d.pubkey, env.body)
    dest.send(out)
    this.framesForwarded++
    this.meter.add(d.appId, 'data_bytes_out', out.byteLength)
  }

  private control(ws: WS, text: string) {
    let msg: RelayControl
    try {
      msg = JSON.parse(text) as RelayControl
    } catch {
      return this.fail(ws, 'bad-message', 'invalid JSON')
    }
    if (msg.type !== 'hello')
      return this.fail(ws, 'bad-message', `unexpected message type ${String(msg.type)}`)
    const d = ws.data
    if (d.pubkey) return this.fail(ws, 'already-authenticated', 'hello already accepted')
    const pubkey = String(msg.pubkey ?? '').toLowerCase()
    if (!isHex64(pubkey) || typeof msg.sig !== 'string')
      return this.fail(ws, 'bad-hello', 'hello needs pubkey and sig', true)
    if (!verifySchnorr(msg.sig, relayHelloHash(d.appId, d.challenge), pubkey)) {
      return this.fail(ws, 'bad-signature', 'challenge signature does not verify', true)
    }
    if (this.bans.pubkeyBanned(pubkey)) return this.fail(ws, 'banned', 'pubkey is banned', true)
    let room = this.peers.get(d.appId)
    if (!room) {
      room = new Map()
      this.peers.set(d.appId, room)
    }
    const prev = room.get(pubkey)
    if (prev && prev !== ws) {
      prev.data.pubkey = null
      prev.close(4001, 'replaced')
    }
    d.pubkey = pubkey
    room.set(pubkey, ws)
    this.send(ws, { type: 'ready' })
  }

  close(ws: WS) {
    this.connections--
    const d = ws.data
    if (!d.pubkey) return
    const room = this.peers.get(d.appId)
    if (room?.get(d.pubkey) === ws) room.delete(d.pubkey)
    if (room && room.size === 0) this.peers.delete(d.appId)
  }

  /** Disconnect every peer of an app (app deleted or disabled). */
  kickApp(appId: string) {
    for (const ws of this.peers.get(appId)?.values() ?? []) ws.close(4002, 'app-disabled')
  }

  stats() {
    const perApp: Record<string, number> = {}
    let peers = 0
    for (const [app, room] of this.peers) {
      perApp[app] = room.size
      peers += room.size
    }
    return { connections: this.connections, peers, perApp, framesForwarded: this.framesForwarded }
  }
}
