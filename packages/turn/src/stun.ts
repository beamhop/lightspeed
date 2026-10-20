// STUN message codec (RFC 8489) with the TURN attributes of RFC 8656.
// Every decoder in this file is total: malformed input yields `null`, never an exception.
import { createHash, createHmac } from 'node:crypto'

export const MAGIC_COOKIE = 0x2112a442
export const HEADER_SIZE = 20
const FINGERPRINT_XOR = 0x5354554e

// ------------------------------------------------------------------ methods and classes

export const Method = {
  Binding: 0x001,
  Allocate: 0x003,
  Refresh: 0x004,
  Send: 0x006,
  Data: 0x007,
  CreatePermission: 0x008,
  ChannelBind: 0x009,
} as const

export const Class = {
  Request: 0,
  Indication: 1,
  Success: 2,
  Error: 3,
} as const
export type StunClass = (typeof Class)[keyof typeof Class]

export const Attr = {
  MappedAddress: 0x0001,
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  UnknownAttributes: 0x000a,
  ChannelNumber: 0x000c,
  Lifetime: 0x000d,
  XorPeerAddress: 0x0012,
  Data: 0x0013,
  Realm: 0x0014,
  Nonce: 0x0015,
  XorRelayedAddress: 0x0016,
  RequestedAddressFamily: 0x0017,
  EvenPort: 0x0018,
  RequestedTransport: 0x0019,
  DontFragment: 0x001a,
  MessageIntegritySha256: 0x001c,
  PasswordAlgorithm: 0x001d,
  Userhash: 0x001e,
  XorMappedAddress: 0x0020,
  ReservationToken: 0x0022,
  Priority: 0x0024,
  UseCandidate: 0x0025,
  PasswordAlgorithms: 0x8002,
  AlternateDomain: 0x8003,
  Software: 0x8022,
  AlternateServer: 0x8023,
  Fingerprint: 0x8028,
  IceControlled: 0x8029,
  IceControlling: 0x802a,
  AdditionalAddressFamily: 0x8000,
  AddressErrorCode: 0x8001,
  ResponseOrigin: 0x802b,
  OtherAddress: 0x802c,
} as const

export const ErrorReason: Record<number, string> = {
  300: 'Try Alternate',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  420: 'Unknown Attribute',
  437: 'Allocation Mismatch',
  438: 'Stale Nonce',
  440: 'Address Family not Supported',
  441: 'Wrong Credentials',
  442: 'Unsupported Transport Protocol',
  443: 'Peer Address Family Mismatch',
  486: 'Allocation Quota Reached',
  500: 'Server Error',
  508: 'Insufficient Capacity',
}

/** Combine a 12-bit method and a 2-bit class into the 14-bit STUN message type. */
export function messageType(method: number, cls: StunClass): number {
  return (
    (method & 0x000f) |
    ((method & 0x0070) << 1) |
    ((method & 0x0f80) << 2) |
    ((cls & 1) << 4) |
    ((cls & 2) << 7)
  )
}

export function splitType(type: number): { method: number; cls: StunClass } {
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2)
  const cls = (((type >> 4) & 1) | ((type >> 7) & 2)) as StunClass
  return { method, cls }
}

// ------------------------------------------------------------------ message model

export interface StunAttribute {
  type: number
  value: Uint8Array
  /** Offset of the attribute header inside `raw`. */
  offset: number
}

export interface StunMessage {
  type: number
  method: number
  cls: StunClass
  transactionId: Uint8Array
  attributes: StunAttribute[]
  /** The exact bytes the message was decoded from (needed for integrity checks). */
  raw: Uint8Array
}

/** Cheap check: could these bytes start a STUN message (first two bits 0, magic cookie)? */
export function isStun(buf: Uint8Array): boolean {
  return (
    buf.length >= HEADER_SIZE &&
    (buf[0] as number) < 0x40 &&
    buf[4] === 0x21 &&
    buf[5] === 0x12 &&
    buf[6] === 0xa4 &&
    buf[7] === 0x42
  )
}

/** ChannelData starts with a channel number in 0x4000-0x7FFF (first two bits 01). */
export function isChannelData(buf: Uint8Array): boolean {
  return buf.length >= 4 && ((buf[0] as number) & 0xc0) === 0x40
}

/**
 * Decode one STUN message. Returns null for anything that is not a well-formed STUN message,
 * including a FINGERPRINT that does not match. Trailing bytes after the declared length are ignored.
 */
export function decodeStun(buf: Uint8Array): StunMessage | null {
  if (!isStun(buf)) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const type = view.getUint16(0)
  const length = view.getUint16(2)
  if (length % 4 !== 0 || HEADER_SIZE + length > buf.length) return null
  const raw = buf.subarray(0, HEADER_SIZE + length)
  const attributes: StunAttribute[] = []
  let off = HEADER_SIZE
  const end = HEADER_SIZE + length
  while (off < end) {
    if (off + 4 > end) return null
    const atype = view.getUint16(off)
    const alen = view.getUint16(off + 2)
    if (off + 4 + alen > end) return null
    attributes.push({ type: atype, value: raw.subarray(off + 4, off + 4 + alen), offset: off })
    off += 4 + pad4(alen)
  }
  if (off !== end) return null
  // FINGERPRINT, when present, must be last and must match.
  const fpIdx = attributes.findIndex((a) => a.type === Attr.Fingerprint)
  if (fpIdx >= 0) {
    const fp = attributes[fpIdx] as StunAttribute
    if (fpIdx !== attributes.length - 1 || fp.value.length !== 4) return null
    const expected = fingerprintOf(raw, fp.offset)
    const got = new DataView(fp.value.buffer, fp.value.byteOffset, 4).getUint32(0)
    if (expected !== got) return null
  }
  const { method, cls } = splitType(type)
  return {
    type,
    method,
    cls,
    transactionId: raw.subarray(8, 20),
    attributes,
    raw,
  }
}

export function getAttr(msg: StunMessage, type: number): Uint8Array | undefined {
  for (const a of msg.attributes) if (a.type === type) return a.value
  return undefined
}

export function getAttrs(msg: StunMessage, type: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const a of msg.attributes) if (a.type === type) out.push(a.value)
  return out
}

// ------------------------------------------------------------------ encoder

export interface EncodeOptions {
  /** Long-term or short-term key; adds MESSAGE-INTEGRITY (HMAC-SHA1). */
  integrityKey?: Uint8Array
  /** Use MESSAGE-INTEGRITY-SHA256 instead of (or in addition to) MESSAGE-INTEGRITY. */
  integrity?: 'sha1' | 'sha256' | 'both'
  fingerprint?: boolean
}

export type AttrList = [type: number, value: Uint8Array][]

/** Build a STUN message. Attributes are written in order; integrity and fingerprint are appended. */
export function encodeStun(
  method: number,
  cls: StunClass,
  transactionId: Uint8Array,
  attrs: AttrList,
  opts: EncodeOptions = {},
): Uint8Array {
  let size = HEADER_SIZE
  for (const [, v] of attrs) size += 4 + pad4(v.length)
  const mode = opts.integrityKey ? (opts.integrity ?? 'sha1') : null
  if (mode === 'sha1' || mode === 'both') size += 24
  if (mode === 'sha256' || mode === 'both') size += 36
  if (opts.fingerprint) size += 8
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint16(0, messageType(method, cls))
  view.setUint32(4, MAGIC_COOKIE)
  out.set(transactionId.subarray(0, 12), 8)
  let off = HEADER_SIZE
  for (const [t, v] of attrs) {
    view.setUint16(off, t)
    view.setUint16(off + 2, v.length)
    out.set(v, off + 4)
    off += 4 + pad4(v.length)
  }
  if (opts.integrityKey && (mode === 'sha1' || mode === 'both')) {
    view.setUint16(2, off + 24 - HEADER_SIZE)
    const mac = hmac('sha1', opts.integrityKey, out.subarray(0, off))
    view.setUint16(off, Attr.MessageIntegrity)
    view.setUint16(off + 2, 20)
    out.set(mac, off + 4)
    off += 24
  }
  if (opts.integrityKey && (mode === 'sha256' || mode === 'both')) {
    view.setUint16(2, off + 36 - HEADER_SIZE)
    const mac = hmac('sha256', opts.integrityKey, out.subarray(0, off))
    view.setUint16(off, Attr.MessageIntegritySha256)
    view.setUint16(off + 2, 32)
    out.set(mac, off + 4)
    off += 36
  }
  view.setUint16(2, size - HEADER_SIZE)
  if (opts.fingerprint) {
    view.setUint16(off, Attr.Fingerprint)
    view.setUint16(off + 2, 4)
    view.setUint32(off + 4, fingerprintOf(out, off))
  }
  return out
}

// ------------------------------------------------------------------ integrity and fingerprint

export type IntegrityResult = 'ok' | 'missing' | 'bad'

/**
 * Verify MESSAGE-INTEGRITY-SHA256 (preferred when present) or MESSAGE-INTEGRITY with `key`.
 * Returns which algorithm matched so a response can use the same one.
 */
export function verifyIntegrity(
  msg: StunMessage,
  key: Uint8Array,
): { result: IntegrityResult; algorithm?: 'sha1' | 'sha256' } {
  const mi = msg.attributes.find((a) => a.type === Attr.MessageIntegrity)
  const mi256 = msg.attributes.find((a) => a.type === Attr.MessageIntegritySha256)
  if (!mi && !mi256) return { result: 'missing' }
  if (mi256) {
    // 16..32 bytes, multiple of 4 (truncation allowed by RFC 8489 §14.6)
    const n = mi256.value.length
    if (n < 16 || n > 32 || n % 4 !== 0) return { result: 'bad' }
    const mac = hmac('sha256', key, signedPortion(msg.raw, mi256.offset, 4 + n))
    return {
      result: timingSafeEqual(mac.subarray(0, n), mi256.value) ? 'ok' : 'bad',
      algorithm: 'sha256',
    }
  }
  const m = mi as StunAttribute
  if (m.value.length !== 20) return { result: 'bad' }
  const mac = hmac('sha1', key, signedPortion(msg.raw, m.offset, 24))
  return { result: timingSafeEqual(mac, m.value) ? 'ok' : 'bad', algorithm: 'sha1' }
}

/** Bytes up to the integrity attribute, with the header length rewritten to end after it. */
function signedPortion(raw: Uint8Array, attrOffset: number, attrSize: number): Uint8Array {
  const part = raw.slice(0, attrOffset)
  new DataView(part.buffer).setUint16(2, attrOffset + attrSize - HEADER_SIZE)
  return part
}

function fingerprintOf(raw: Uint8Array, fpOffset: number): number {
  // The header length already covers the FINGERPRINT attribute at this point.
  const part = raw.slice(0, fpOffset)
  new DataView(part.buffer).setUint16(2, fpOffset + 8 - HEADER_SIZE)
  return (crc32(part) ^ FINGERPRINT_XOR) >>> 0
}

let crcTable: Uint32Array | null = null
export function crc32(data: Uint8Array): number {
  if (typeof Bun !== 'undefined') return Bun.hash.crc32(data) >>> 0
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++)
    crc = (crcTable[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function hmac(alg: 'sha1' | 'sha256', key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac(alg, key).update(data).digest())
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number)
  return d === 0
}

/**
 * Minimal SASLprep/OpaqueString: drop "mapped to nothing" code points, map non-ASCII spaces to
 * U+0020 and apply NFKC. Identity for ASCII passwords (including TURN REST base64 credentials).
 */
export function saslprep(s: string): string {
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: explicit RFC 3454 B.1 code points
  const nothing = /[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g
  const spaces = /[   -   　]/g
  return s.replace(nothing, '').replace(spaces, ' ').normalize('NFKC')
}

/** Long-term credential key: MD5(username ":" realm ":" SASLprep(password)). */
export function longTermKey(username: string, realm: string, password: string): Uint8Array {
  return new Uint8Array(
    createHash('md5')
      .update(`${username}:${realm}:${saslprep(password)}`, 'utf8')
      .digest(),
  )
}

// ------------------------------------------------------------------ attribute value helpers

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: false })

export function str(s: string): Uint8Array {
  return te.encode(s)
}

export function decodeStr(v: Uint8Array | undefined): string | undefined {
  return v === undefined ? undefined : td.decode(v)
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}

export function readU32(v: Uint8Array | undefined): number | undefined {
  if (!v || v.length !== 4) return undefined
  return new DataView(v.buffer, v.byteOffset, 4).getUint32(0)
}

export interface Address {
  family: 4 | 6
  address: string
  port: number
}

/** XOR-MAPPED-ADDRESS / XOR-PEER-ADDRESS / XOR-RELAYED-ADDRESS value. */
export function encodeXorAddress(addr: Address, transactionId: Uint8Array): Uint8Array {
  const ip = parseIp(addr.address)
  if (!ip) throw new Error(`invalid IP address: ${addr.address}`)
  const out = new Uint8Array(4 + ip.length)
  out[1] = ip.length === 4 ? 0x01 : 0x02
  const xport = (addr.port ^ (MAGIC_COOKIE >>> 16)) & 0xffff
  out[2] = xport >> 8
  out[3] = xport & 0xff
  const mask = xorMask(transactionId)
  for (let i = 0; i < ip.length; i++) out[4 + i] = (ip[i] as number) ^ (mask[i] as number)
  return out
}

export function decodeXorAddress(
  v: Uint8Array | undefined,
  transactionId: Uint8Array,
): Address | null {
  if (!v || v.length < 4) return null
  const fam = v[1]
  const len = fam === 0x01 ? 4 : fam === 0x02 ? 16 : 0
  if (!len || v.length !== 4 + len) return null
  const port = (((v[2] as number) << 8) | (v[3] as number)) ^ (MAGIC_COOKIE >>> 16)
  const mask = xorMask(transactionId)
  const ip = new Uint8Array(len)
  for (let i = 0; i < len; i++) ip[i] = (v[4 + i] as number) ^ (mask[i] as number)
  return { family: len === 4 ? 4 : 6, address: formatIp(ip), port }
}

/** Plain MAPPED-ADDRESS (RFC 5389 legacy) decode. */
export function decodeAddress(v: Uint8Array | undefined): Address | null {
  if (!v || v.length < 4) return null
  const len = v[1] === 0x01 ? 4 : v[1] === 0x02 ? 16 : 0
  if (!len || v.length !== 4 + len) return null
  return {
    family: len === 4 ? 4 : 6,
    address: formatIp(v.subarray(4)),
    port: ((v[2] as number) << 8) | (v[3] as number),
  }
}

function xorMask(transactionId: Uint8Array): Uint8Array {
  const m = new Uint8Array(16)
  new DataView(m.buffer).setUint32(0, MAGIC_COOKIE)
  m.set(transactionId.subarray(0, 12), 4)
  return m
}

export function encodeErrorCode(code: number, reason = ErrorReason[code] ?? ''): Uint8Array {
  const r = te.encode(reason)
  const out = new Uint8Array(4 + r.length)
  out[2] = Math.floor(code / 100) & 0x07
  out[3] = code % 100
  out.set(r, 4)
  return out
}

export function decodeErrorCode(
  v: Uint8Array | undefined,
): { code: number; reason: string } | null {
  if (!v || v.length < 4) return null
  const cls = (v[2] as number) & 0x07
  const num = v[3] as number
  if (cls < 3 || cls > 6 || num > 99) return null
  return { code: cls * 100 + num, reason: td.decode(v.subarray(4)) }
}

export function encodeUnknownAttributes(types: number[]): Uint8Array {
  const out = new Uint8Array(types.length * 2)
  const view = new DataView(out.buffer)
  for (const [i, t] of types.entries()) view.setUint16(i * 2, t)
  return out
}

export function decodeUnknownAttributes(v: Uint8Array | undefined): number[] | null {
  if (!v || v.length % 2 !== 0) return null
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  const out: number[] = []
  for (let i = 0; i < v.length; i += 2) out.push(view.getUint16(i))
  return out
}

export function randomTransactionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12))
}

export function pad4(n: number): number {
  return (n + 3) & ~3
}

// ------------------------------------------------------------------ IP helpers

/** Parse dotted IPv4 or RFC 4291 IPv6 text (incl. "::" and embedded IPv4); null on failure. */
export function parseIp(s: string): Uint8Array | null {
  if (s.includes(':')) return parseIp6(s)
  return parseIp4(s)
}

function parseIp4(s: string): Uint8Array | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const p = parts[i] as string
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseIp6(input: string): Uint8Array | null {
  let s = input
  const pct = s.indexOf('%')
  if (pct >= 0) s = s.slice(0, pct)
  let tail: Uint8Array | null = null
  const lastColon = s.lastIndexOf(':')
  if (s.slice(lastColon + 1).includes('.')) {
    tail = parseIp4(s.slice(lastColon + 1))
    if (!tail) return null
    s = `${s.slice(0, lastColon + 1)}0:0`
  }
  const dbl = s.split('::')
  if (dbl.length > 2) return null
  const head = dbl[0] ? (dbl[0] as string).split(':') : []
  const rest = dbl.length === 2 && dbl[1] ? (dbl[1] as string).split(':') : []
  const groups = dbl.length === 2 ? 8 - head.length - rest.length : 0
  if (dbl.length === 1 && head.length !== 8) return null
  if (dbl.length === 2 && groups < 1) return null
  const all = [...head, ...Array<string>(groups).fill('0'), ...rest]
  if (all.length !== 8) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = all[i] as string
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    const n = Number.parseInt(g, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  if (tail) out.set(tail, 12)
  return out
}

export function formatIp(ip: Uint8Array): string {
  if (ip.length === 4) return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((ip[i] as number) << 8) | (ip[i + 1] as number))
  // RFC 5952: compress the longest run (>= 2) of zero groups.
  let best = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen && j - i >= 2) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (best < 0) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`
}

/** Canonical form of an IP string; IPv4-mapped IPv6 collapses to IPv4. Returns input on failure. */
export function normalizeIp(s: string): string {
  const ip = parseIp(s)
  if (!ip) return s
  if (ip.length === 16 && isV4Mapped(ip)) return formatIp(ip.subarray(12))
  return formatIp(ip)
}

function isV4Mapped(ip: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (ip[i] !== 0) return false
  return ip[10] === 0xff && ip[11] === 0xff
}

export function ipFamily(s: string): 4 | 6 {
  return normalizeIp(s).includes(':') ? 6 : 4
}
