import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { schnorrVerify } from '../crypto/nostr'
import type { Hex, Identity } from '../types'
import { bytesToHex, randomBytes, utf8ToBytes } from '../util/bytes'

export type Capability = 'join' | 'debug' | (string & {})

/** { room, pubkey, caps, exp } signed (BIP-340) by the room host or the app key. */
export interface CapabilityToken {
  v: 1
  /** Room topic (hex) the token is valid for, or '*' for any room of the app. */
  room: Hex | '*'
  pubkey: Hex
  caps: Capability[]
  /** Expiry, seconds since epoch. */
  exp: number
  /** Issuer pubkey. */
  iss: Hex
  sig: Hex
}

export function capabilityHash(
  t: Pick<CapabilityToken, 'room' | 'pubkey' | 'caps' | 'exp' | 'iss'>,
): Uint8Array {
  return sha256(
    utf8ToBytes(JSON.stringify(['beamhop-cap/v1', t.room, t.pubkey, t.caps, t.exp, t.iss])),
  )
}

export interface IssueCapabilityOptions {
  room: Hex | '*'
  pubkey: Hex
  caps: Capability[]
  /** Lifetime in seconds (default 1 hour) or an absolute `exp`. */
  ttlS?: number
  exp?: number
}

/** Issue a token with a raw issuer secret key (app key on a backend) or an Identity (room host). */
export async function issueCapability(
  issuer: Uint8Array | Identity,
  o: IssueCapabilityOptions,
): Promise<CapabilityToken> {
  const iss =
    issuer instanceof Uint8Array ? bytesToHex(schnorr.getPublicKey(issuer)) : issuer.pubkey
  const exp = o.exp ?? Math.floor(Date.now() / 1000) + (o.ttlS ?? 3600)
  const body = { room: o.room, pubkey: o.pubkey, caps: [...o.caps], exp, iss }
  const hash = capabilityHash(body)
  const sig =
    issuer instanceof Uint8Array
      ? schnorr.sign(hash, issuer, randomBytes(32))
      : await issuer.sign(hash)
  return { v: 1, ...body, sig: bytesToHex(sig) }
}

export interface VerifyCapabilityOptions {
  room: Hex
  pubkey: Hex
  /** Accepted issuers. Ignored when `dev` is true. */
  issuers?: readonly Hex[]
  /** Dev mode: any validly signed token is accepted regardless of issuer. */
  dev?: boolean
  now?: number
}

export function verifyCapability(
  t: unknown,
  o: VerifyCapabilityOptions,
): { ok: true; caps: Capability[] } | { ok: false; reason: string } {
  const tok = t as Partial<CapabilityToken> | null
  if (
    !tok ||
    tok.v !== 1 ||
    !Array.isArray(tok.caps) ||
    typeof tok.iss !== 'string' ||
    typeof tok.sig !== 'string'
  ) {
    return { ok: false, reason: 'malformed token' }
  }
  if (tok.pubkey !== o.pubkey) return { ok: false, reason: 'token is for another pubkey' }
  if (tok.room !== '*' && tok.room !== o.room)
    return { ok: false, reason: 'token is for another room' }
  const now = o.now ?? Math.floor(Date.now() / 1000)
  if (typeof tok.exp !== 'number' || tok.exp < now) return { ok: false, reason: 'token expired' }
  if (!o.dev && !(o.issuers ?? []).includes(tok.iss))
    return { ok: false, reason: 'untrusted issuer' }
  const hash = capabilityHash(tok as CapabilityToken)
  if (!schnorrVerify(tok.sig, hash, tok.iss)) return { ok: false, reason: 'bad signature' }
  return { ok: true, caps: tok.caps.filter((c): c is Capability => typeof c === 'string') }
}
