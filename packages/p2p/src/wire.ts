// Wire formats shared by the library and the relay. Spec: docs/PROTOCOL.md.
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { Hex } from './types'

export const PROTOCOL_VERSION = 1
export const KIND_ANNOUNCE = 20100
export const KIND_SIGNAL = 20101
export const ANNOUNCE_TTL_S = 30
export const ANNOUNCE_INTERVAL_S = 20
export const CHUNK_SIZE = 16 * 1024
export const TELEMETRY_CHANNEL = '__beamhop/telemetry'

const PREFIX = utf8ToBytes('beamhop/v1')

function roomInput(appId: string, roomId: string, password = ''): Uint8Array {
  // Length-prefix each part so ("ab","c") and ("a","bc") differ.
  const parts = [appId, roomId, password].map(utf8ToBytes)
  const out = new Uint8Array(PREFIX.length + parts.reduce((n, p) => n + 4 + p.length, 0))
  out.set(PREFIX, 0)
  let o = PREFIX.length
  const view = new DataView(out.buffer)
  for (const p of parts) {
    view.setUint32(o, p.length)
    out.set(p, o + 4)
    o += 4 + p.length
  }
  return out
}

/** Room topic carried in the `t` tag: sha256("beamhop/v1" ‖ appId ‖ roomId ‖ password). */
export function roomTopic(appId: string, roomId: string, password?: string): Hex {
  return bytesToHex(sha256(roomInput(appId, roomId, password)))
}

/** 32-byte AES-256-GCM key for room-wide announces. */
export function roomKey(appId: string, roomId: string, password?: string): Uint8Array {
  return hkdf(sha256, roomInput(appId, roomId, password), undefined, 'beamhop/v1 room key', 32)
}

// ---------------------------------------------------------------- data frames

export enum FrameType {
  Hello = 0,
  Connect = 1,
  Data = 2,
  Close = 3,
  Ping = 4,
}

export interface Frame {
  version: number
  type: FrameType
  streamId: number
  payload: Uint8Array
}

export const FRAME_HEADER = 6

/** version u8 · type u8 · streamId u16 · length u16 · payload (big-endian). */
export function encodeFrame(f: Omit<Frame, 'version'> & { version?: number }): Uint8Array {
  if (f.payload.length > 0xffff) throw new RangeError('frame payload exceeds 65535 bytes')
  const out = new Uint8Array(FRAME_HEADER + f.payload.length)
  const v = new DataView(out.buffer)
  v.setUint8(0, f.version ?? PROTOCOL_VERSION)
  v.setUint8(1, f.type)
  v.setUint16(2, f.streamId)
  v.setUint16(4, f.payload.length)
  out.set(f.payload, FRAME_HEADER)
  return out
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < FRAME_HEADER) throw new RangeError('short frame')
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const length = v.getUint16(4)
  if (buf.length < FRAME_HEADER + length) throw new RangeError('truncated frame')
  return {
    version: v.getUint8(0),
    type: v.getUint8(1) as FrameType,
    streamId: v.getUint16(2),
    payload: buf.subarray(FRAME_HEADER, FRAME_HEADER + length),
  }
}

// ---------------------------------------------------------------- relay data path

/** Binary relay-path message: 32-byte pubkey (destination when sent, source when received) ‖ body. */
export function encodeRelayEnvelope(pubkey: Hex, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(32 + body.length)
  out.set(hexToBytes(pubkey), 0)
  out.set(body, 32)
  return out
}

export function decodeRelayEnvelope(buf: Uint8Array): { pubkey: Hex; body: Uint8Array } {
  if (buf.length < 32) throw new RangeError('short relay envelope')
  return { pubkey: bytesToHex(buf.subarray(0, 32)), body: buf.subarray(32) }
}

/** Text control messages on wss://relay/a/<appId>/data. */
export type RelayControl =
  | { type: 'challenge'; challenge: Hex }
  | { type: 'hello'; pubkey: Hex; sig: Hex }
  | { type: 'ready' }
  | { type: 'error'; code: string; message: string }
  | { type: 'peer-offline'; pubkey: Hex }

/** 32-byte hash the client signs (BIP-340) to answer the relay's challenge. */
export function relayHelloHash(appId: string, challenge: Hex): Uint8Array {
  return sha256(utf8ToBytes(`beamhop-relay-hello:${appId}:${challenge}`))
}

// ---------------------------------------------------------------- TURN REST credentials

/** username = <expiry unix seconds>:<appId>:<pubkey> */
export function turnUsername(expiry: number, appId: string, pubkey: Hex): string {
  return `${Math.floor(expiry)}:${appId}:${pubkey}`
}

export function parseTurnUsername(
  username: string,
): { expiry: number; appId: string; pubkey: string } | null {
  const m = /^(\d+):([^:]+):(.+)$/.exec(username)
  if (!m) return null
  return { expiry: Number(m[1]), appId: m[2] as string, pubkey: m[3] as string }
}

/** credential = base64(HMAC-SHA1(appSecret, username)) */
export function turnPassword(appSecret: string, username: string): string {
  const mac = hmac(sha1, utf8ToBytes(appSecret), utf8ToBytes(username))
  return btoa(String.fromCharCode(...mac))
}

export interface TurnCredentialsResponse {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[]
  ttl: number
}
