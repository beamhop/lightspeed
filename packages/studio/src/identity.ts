// Identity switcher helpers: build anonymous, Nostr and OIDC identities for the observer so
// admission policies can be tested.
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { Hex, StudioIdentity } from './room-adapter'

export interface IdentityWithKey {
  identity: StudioIdentity
  /** Session secret key (hex). Kept in memory only. */
  secretKey: Hex
}

function newSessionKey(): { sk: Uint8Array; pk: Hex } {
  const sk = schnorr.utils.randomPrivateKey()
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

export function anonymousIdentity(): IdentityWithKey {
  const { sk, pk } = newSessionKey()
  return {
    identity: {
      kind: 'anonymous',
      pubkey: pk,
      label: 'anonymous',
      attestation: { type: 'anonymous' },
    },
    secretKey: bytesToHex(sk),
  }
}

// ------------------------------------------------------------------ bech32 (NIP-19 npub/nsec)

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

/** Decode a bech32 string into its prefix and bytes. Throws on bad checksum. */
export function bech32Decode(str: string): { prefix: string; bytes: Uint8Array } {
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) throw new Error('invalid bech32 string')
  const prefix = s.slice(0, pos)
  const data: number[] = []
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c)
    if (v === -1) throw new Error('invalid bech32 character')
    data.push(v)
  }
  if (polymod([...hrpExpand(prefix), ...data]) !== 1) throw new Error('invalid bech32 checksum')
  const words = data.slice(0, -6)
  // 5-bit → 8-bit
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 0xff)
    }
  }
  return { prefix, bytes: new Uint8Array(out) }
}

/** Accepts 64-char hex or an npub; returns the hex pubkey. */
export function parsePubkey(input: string): Hex {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  if (v.startsWith('npub1')) {
    const { prefix, bytes } = bech32Decode(v)
    if (prefix !== 'npub' || bytes.length !== 32) throw new Error('not an npub')
    return bytesToHex(bytes)
  }
  throw new Error('expected a 64-char hex pubkey or an npub')
}

/** Accepts 64-char hex or an nsec; returns the secret key bytes. */
export function parseSecretKey(input: string): Uint8Array {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return hexToBytes(v.toLowerCase())
  if (v.startsWith('nsec1')) {
    const { prefix, bytes } = bech32Decode(v)
    if (prefix !== 'nsec' || bytes.length !== 32) throw new Error('not an nsec')
    return bytes
  }
  throw new Error('expected a 64-char hex secret key or an nsec')
}

/**
 * Message a Nostr key signs to vouch for a session key.
 * TODO(@beamhop/p2p): align with the library's attestation transcript once it is published.
 */
export function attestationHash(sessionPubkey: Hex): Uint8Array {
  return sha256(utf8ToBytes(`beamhop/v1/attest:${sessionPubkey}`))
}

/**
 * Nostr identity. With a secret key the attestation is signed locally; with only a pubkey
 * (e.g. from NIP-07 getPublicKey) the signature is left empty and the room will reject it if
 * it verifies attestations — which is itself a useful admission test.
 */
export function nostrIdentity(opts: { secretKey?: string; pubkey?: string }): IdentityWithKey {
  const session = newSessionKey()
  let nostrPub: Hex
  let sig = ''
  if (opts.secretKey) {
    const nsk = parseSecretKey(opts.secretKey)
    nostrPub = bytesToHex(schnorr.getPublicKey(nsk))
    sig = bytesToHex(schnorr.sign(attestationHash(session.pk), nsk))
  } else if (opts.pubkey) {
    nostrPub = parsePubkey(opts.pubkey)
  } else {
    throw new Error('nostr identity needs a secret key or a pubkey')
  }
  return {
    identity: {
      kind: 'nostr',
      pubkey: session.pk,
      label: `nostr ${nostrPub.slice(0, 8)}…${sig ? '' : ' (unsigned)'}`,
      attestation: { type: 'nostr', pubkey: nostrPub, sig },
    },
    secretKey: bytesToHex(session.sk),
  }
}

export function verifyNostrAttestation(identity: StudioIdentity): boolean {
  const a = identity.attestation
  if (a.type !== 'nostr' || !a.sig) return false
  try {
    return schnorr.verify(hexToBytes(a.sig), attestationHash(identity.pubkey), hexToBytes(a.pubkey))
  } catch {
    return false
  }
}

export interface OidcClaims {
  v: 1
  iss: string
  sub: string
  pubkey: Hex
  iat: number
  exp: number
}

function b64urlDecode(s: string): string {
  const b64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** Decode (not verify — the room verifies against the issuer JWKS) an attestation JWS. */
export function decodeOidcAttestation(jws: string): OidcClaims {
  const parts = jws.trim().split('.')
  if (parts.length !== 3) throw new Error('expected a compact JWS (header.payload.signature)')
  let claims: Partial<OidcClaims>
  try {
    claims = JSON.parse(b64urlDecode(parts[1] as string))
  } catch {
    throw new Error('JWS payload is not JSON')
  }
  if (claims.v !== 1) throw new Error('attestation version must be 1')
  for (const k of ['iss', 'sub', 'pubkey'] as const) {
    if (typeof claims[k] !== 'string' || !claims[k]) throw new Error(`missing claim: ${k}`)
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number')
    throw new Error('missing iat/exp')
  return claims as OidcClaims
}

export function oidcIdentity(jws: string, now = Date.now()): StudioIdentity {
  const c = decodeOidcAttestation(jws)
  if (c.exp * 1000 < now)
    throw new Error(`attestation expired at ${new Date(c.exp * 1000).toISOString()}`)
  return {
    kind: 'oidc',
    pubkey: c.pubkey,
    label: `${c.sub} @ ${c.iss}`,
    attestation: { type: 'oidc', jws: jws.trim() },
  }
}
