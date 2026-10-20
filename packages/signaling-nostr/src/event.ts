// NIP-01 event hashing, signing (via the room Identity) and verification, plus NIP-13 PoW.
import type { Identity } from '@beamhop/p2p/types'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type EventTemplate = Pick<NostrEvent, 'kind' | 'tags' | 'content'> & { created_at?: number }

export type UnsignedEvent = Omit<NostrEvent, 'id' | 'sig'>

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** NIP-01 canonical serialization. */
export function serializeEvent(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
}

export function getEventHash(e: UnsignedEvent): Uint8Array {
  return sha256(utf8ToBytes(serializeEvent(e)))
}

/** Number of leading zero bits of a hex id (NIP-13 difficulty). */
export function leadingZeroBits(hex: string): number {
  let bits = 0
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i] as string, 16)
    if (nibble === 0) {
      bits += 4
      continue
    }
    bits += Math.clz32(nibble) - 28
    break
  }
  return bits
}

/** Adds a NIP-13 nonce tag until the id has at least `bits` leading zero bits. Yields periodically. */
export async function minePow(e: UnsignedEvent, bits: number): Promise<UnsignedEvent> {
  if (bits <= 0) return e
  const base = e.tags.filter((t) => t[0] !== 'nonce')
  const nonceTag = ['nonce', '0', String(bits)]
  const candidate: UnsignedEvent = { ...e, tags: [...base, nonceTag] }
  for (let n = 0; ; n++) {
    nonceTag[1] = String(n)
    if (leadingZeroBits(bytesToHex(getEventHash(candidate))) >= bits) return candidate
    if (n % 20000 === 19999) await new Promise((r) => setTimeout(r, 0))
  }
}

/** Builds, optionally mines and signs an event with the room identity. */
export async function signEvent(
  template: EventTemplate,
  identity: Pick<Identity, 'pubkey' | 'sign'>,
  powBits = 0,
): Promise<NostrEvent> {
  let unsigned: UnsignedEvent = {
    pubkey: identity.pubkey,
    created_at: template.created_at ?? nowSeconds(),
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  }
  if (powBits > 0) unsigned = await minePow(unsigned, powBits)
  const hash = getEventHash(unsigned)
  const sig = await identity.sign(hash)
  return { ...unsigned, id: bytesToHex(hash), sig: bytesToHex(sig) }
}

/** Shape check + id check + BIP-340 signature check. Never throws. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false
  const ev = e as Record<string, unknown>
  if (
    typeof ev.id !== 'string' ||
    typeof ev.pubkey !== 'string' ||
    typeof ev.sig !== 'string' ||
    typeof ev.content !== 'string' ||
    typeof ev.kind !== 'number' ||
    typeof ev.created_at !== 'number' ||
    !Array.isArray(ev.tags) ||
    !ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  ) {
    return false
  }
  if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !HEX128.test(ev.sig)) return false
  try {
    const hash = getEventHash(ev as unknown as UnsignedEvent)
    if (bytesToHex(hash) !== ev.id) return false
    return schnorr.verify(hexToBytes(ev.sig), hash, hexToBytes(ev.pubkey))
  } catch {
    return false
  }
}

export function getTag(e: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1]
}

/** NIP-40: true when the event carries an expiration tag in the past. */
export function isExpired(e: Pick<NostrEvent, 'tags'>, now = nowSeconds()): boolean {
  const exp = getTag(e, 'expiration')
  if (exp === undefined) return false
  const n = Number(exp)
  return Number.isFinite(n) && n <= now
}
