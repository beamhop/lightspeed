import { schnorr } from '@noble/curves/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { NostrEvent } from '../engines'

export { bytesToHex, hexToBytes }

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function randomHex(n = 32): string {
  return bytesToHex(randomBytes(n))
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export const isHex64 = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

// ---------------------------------------------------------------- Nostr events

export function eventHash(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))
}

/** Shape check + id + BIP-340 signature verification. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false
  const ev = e as NostrEvent
  if (!isHex64(ev.id) || !isHex64(ev.pubkey) || typeof ev.sig !== 'string') return false
  if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind)) return false
  if (typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return false
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false
  if (eventHash(ev) !== ev.id) return false
  try {
    return schnorr.verify(ev.sig, ev.id, ev.pubkey)
  } catch {
    return false
  }
}

export function getPublicKey(secretHex: string): string {
  return bytesToHex(schnorr.getPublicKey(secretHex))
}

export function signEvent(
  secretHex: string,
  e: { kind: number; content: string; tags: string[][]; created_at?: number },
): NostrEvent {
  const base = {
    pubkey: getPublicKey(secretHex),
    created_at: e.created_at ?? Math.floor(Date.now() / 1000),
    kind: e.kind,
    tags: e.tags,
    content: e.content,
  }
  const id = eventHash(base)
  return { ...base, id, sig: bytesToHex(schnorr.sign(id, secretHex)) }
}

export function verifySchnorr(sigHex: string, msg: Uint8Array, pubkey: string): boolean {
  try {
    return schnorr.verify(sigHex, msg, pubkey)
  } catch {
    return false
  }
}

export function tagValue(e: NostrEvent, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1]
}

export function tagValues(e: NostrEvent, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1] as string)
}

// ---------------------------------------------------------------- base32 + TOTP (RFC 4648, RFC 6238)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** HOTP (RFC 4226) with HMAC-SHA1. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = new Uint8Array(8)
  const view = new DataView(msg.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  const mac = hmac(sha1, key, msg)
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number)
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function totpStep(nowMs = Date.now(), period = 30): number {
  return Math.floor(nowMs / 1000 / period)
}

/** TOTP code for a base32 secret at a time (RFC 6238, SHA-1, 30 s, 6 digits). */
export function totp(secretB32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs))
}

/**
 * Verify a TOTP code within ±window steps. Returns the matching step (so callers can refuse
 * replays of an already-used step) or null.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  nowMs = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secretB32)
  const step = totpStep(nowMs)
  for (let d = -window; d <= window; d++) {
    if (safeEqual(hotp(key, step + d), code)) return step + d
  }
  return null
}

export function totpUri(secretB32: string, account: string, issuer = 'Beamhop Relay'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

// ---------------------------------------------------------------- bech32 (npub decoding for /pay)

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i] as number
  }
  return chk
}

/** Decode a bech32 string (NIP-19 npub etc.) to { prefix, bytes }. */
export function bech32Decode(str: string): { prefix: string; bytes: Uint8Array } | null {
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) return null
  const prefix = s.slice(0, pos)
  const data: number[] = []
  for (const c of s.slice(pos + 1)) {
    const v = BECH32.indexOf(c)
    if (v < 0) return null
    data.push(v)
  }
  const hrp = [...prefix].map((c) => c.charCodeAt(0))
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)]
  if (polymod([...expanded, ...data]) !== 1) return null
  const words = data.slice(0, -6)
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return { prefix, bytes: new Uint8Array(out) }
}

/** Accept a hex pubkey or an npub; returns lowercase hex or null. */
export function normalizePubkey(input: string): string | null {
  const s = input.trim()
  if (isHex64(s.toLowerCase())) return s.toLowerCase()
  if (s.toLowerCase().startsWith('npub1')) {
    const d = bech32Decode(s)
    if (d && d.prefix === 'npub' && d.bytes.length === 32) return bytesToHex(d.bytes)
  }
  return null
}
