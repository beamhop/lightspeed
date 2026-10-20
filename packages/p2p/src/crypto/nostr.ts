// Minimal Nostr helpers: event ids, signing/verification and bech32 (nsec/npub).
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '../util/bytes'

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
  pubkey?: string
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export function eventHash(e: UnsignedEvent & { pubkey: string }): string {
  const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
  return bytesToHex(sha256(utf8ToBytes(ser)))
}

export function finalizeEvent(e: UnsignedEvent, secretKey: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const full = { ...e, pubkey }
  const id = eventHash(full)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, randomBytes(32)))
  return { id, pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig }
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (eventHash(e) !== e.id) return false
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))
  } catch {
    return false
  }
}

export function schnorrVerify(sig: string | Uint8Array, hash: Uint8Array, pubkey: string): boolean {
  try {
    return schnorr.verify(typeof sig === 'string' ? hexToBytes(sig) : sig, hash, hexToBytes(pubkey))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- bech32 (BIP-173)

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i] as number
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (let i = 0; i < data.length; i++) {
    acc = (acc << from) | (data[i] as number)
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & max)
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max)
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    throw new Error('bech32: invalid padding')
  }
  return out
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const words = convertBits(data, 8, 5, true)
  const values = [...hrpExpand(hrp), ...words]
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`
}

export function bech32Decode(str: string): { hrp: string; data: Uint8Array } {
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) throw new Error('bech32: invalid string')
  const hrp = s.slice(0, pos)
  const words: number[] = []
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c)
    if (v < 0) throw new Error('bech32: invalid character')
    words.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error('bech32: invalid checksum')
  return { hrp, data: new Uint8Array(convertBits(words.slice(0, -6), 5, 8, false)) }
}

export function decodeNsec(nsec: string): Uint8Array {
  const { hrp, data } = bech32Decode(nsec)
  if (hrp !== 'nsec' || data.length !== 32) throw new Error('not an nsec')
  return data
}

export function encodeNsec(secretKey: Uint8Array): string {
  return bech32Encode('nsec', secretKey)
}

export function npubEncode(pubkey: string): string {
  return bech32Encode('npub', hexToBytes(pubkey))
}

export function npubDecode(npub: string): string {
  const { hrp, data } = bech32Decode(npub)
  if (hrp !== 'npub' || data.length !== 32) throw new Error('not an npub')
  return bytesToHex(data)
}
