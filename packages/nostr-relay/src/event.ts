import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import type { NostrEvent } from './types'

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const encoder = new TextEncoder()

export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s)

export function serializeForId(e: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>) {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
}

export function computeId(e: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>) {
  return bytesToHex(sha256(encoder.encode(serializeForId(e))))
}

/** Checks id == hash and the BIP-340 signature. Never throws. */
export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (computeId(e) !== e.id) return false
    return schnorr.verify(e.sig, e.id, e.pubkey)
  } catch {
    return false
  }
}

/** Structural validation. Returns an error message (without prefix) or null. */
export function validateShape(e: unknown): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'event must be an object'
  const ev = e as Record<string, unknown>
  if (!isHex64(ev.id)) return 'id must be 64 lowercase hex chars'
  if (!isHex64(ev.pubkey)) return 'pubkey must be 64 lowercase hex chars'
  if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return 'sig must be 128 lowercase hex chars'
  if (typeof ev.created_at !== 'number' || !Number.isInteger(ev.created_at) || ev.created_at < 0)
    return 'created_at must be a non-negative integer'
  if (typeof ev.kind !== 'number' || !Number.isInteger(ev.kind) || ev.kind < 0 || ev.kind > 65535)
    return 'kind must be an integer 0-65535'
  if (typeof ev.content !== 'string') return 'content must be a string'
  if (!Array.isArray(ev.tags)) return 'tags must be an array'
  for (const t of ev.tags) {
    if (!Array.isArray(t)) return 'each tag must be an array'
    for (const v of t) if (typeof v !== 'string') return 'tag values must be strings'
  }
  return null
}

/** Strips unknown fields so stored JSON is canonical. */
export function canonical(e: NostrEvent): NostrEvent {
  return {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  }
}

export const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000)
export const isEphemeral = (k: number) => k >= 20000 && k < 30000
export const isAddressable = (k: number) => k >= 30000 && k < 40000

export function tagValue(e: NostrEvent, name: string): string | undefined {
  for (const t of e.tags) if (t[0] === name) return t[1]
  return undefined
}

/** d tag value for addressable events ('' when missing). */
export const dTag = (e: NostrEvent) => tagValue(e, 'd') ?? ''

/** NIP-40 expiration timestamp or null. */
export function expiration(e: NostrEvent): number | null {
  const v = tagValue(e, 'expiration')
  if (v === undefined) return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

/** NIP-70: has a `["-"]` tag. */
export const isProtected = (e: NostrEvent) => e.tags.some((t) => t.length >= 1 && t[0] === '-')

/** NIP-13 difficulty: number of leading zero bits of the id. */
export function powDifficulty(id: string): number {
  let count = 0
  for (let i = 0; i < id.length; i++) {
    const nibble = Number.parseInt(id[i] as string, 16)
    if (nibble === 0) {
      count += 4
      continue
    }
    count += Math.clz32(nibble) - 28
    break
  }
  return count
}

/** NIP-13 committed target difficulty from the nonce tag, if any. */
export function powTarget(e: NostrEvent): number | null {
  for (const t of e.tags) {
    if (t[0] === 'nonce' && t[2] !== undefined) {
      const n = Number.parseInt(t[2], 10)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

export const nowSec = () => Math.floor(Date.now() / 1000)
