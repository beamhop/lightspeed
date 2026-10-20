// Identity switcher helpers: build anonymous, Nostr and OIDC identities for the observer so
// admission policies can be tested. Nostr attestations use the library's format (a kind 28100
// event signed by the Nostr key, see @beamhop/p2p README "Nostr session attestation").
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  bech32Decode as libBech32Decode,
  verifyNostrAttestation as libVerifyNostrAttestation,
  sessionAttestationEvent,
} from '@beamhop/p2p'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { Hex, StudioIdentity } from './room-adapter'

export interface IdentityWithKey {
  identity: StudioIdentity
  /** Session secret key (hex). Kept in memory only. */
  secretKey: Hex
}

/**
 * Session secret keys of identities Studio created, so the observer peer can join as them. Kept in
 * memory only and never posted anywhere (the identity objects themselves carry no secret).
 */
const sessionKeys = new WeakMap<StudioIdentity, Hex>()

/** The session secret key behind an identity created by this module, if any. */
export function sessionSecretKey(identity: StudioIdentity): Hex | undefined {
  return sessionKeys.get(identity)
}

function withKey(identity: StudioIdentity, sk: Uint8Array): IdentityWithKey {
  const secretKey = bytesToHex(sk)
  sessionKeys.set(identity, secretKey)
  return { identity, secretKey }
}

function newSessionKey(): { sk: Uint8Array; pk: Hex } {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export function anonymousIdentity(): IdentityWithKey {
  const { sk, pk } = newSessionKey()
  return withKey(
    {
      kind: 'anonymous',
      pubkey: pk,
      label: 'anonymous',
      attestation: { type: 'anonymous' },
    },
    sk,
  )
}

// ------------------------------------------------------------------ NIP-19 npub/nsec

/** Decode a bech32 string into its prefix and bytes. Throws on bad checksum. */
export function bech32Decode(str: string): { prefix: string; bytes: Uint8Array } {
  const { hrp, data } = libBech32Decode(str)
  return { prefix: hrp, bytes: data }
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
 * Nostr identity. With a secret key the session attestation (kind 28100 event, `p` tag = session
 * pubkey) is signed locally, exactly like `createNostrAttestation(secretKeySigner(sk), session)`;
 * with only a pubkey (e.g. from NIP-07 getPublicKey) the signature is left empty and the room will
 * reject it, which is itself a useful admission test.
 */
export function nostrIdentity(opts: {
  secretKey?: string
  pubkey?: string
  /** created_at of the attestation event (default now). */
  createdAt?: number
}): IdentityWithKey {
  const session = newSessionKey()
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
  let nostrPub: Hex
  let sig = ''
  if (opts.secretKey) {
    const nsk = parseSecretKey(opts.secretKey)
    const signed = finalizeEvent(sessionAttestationEvent(session.pk, createdAt), nsk)
    nostrPub = signed.pubkey
    sig = signed.sig
  } else if (opts.pubkey) {
    nostrPub = parsePubkey(opts.pubkey)
  } else {
    throw new Error('nostr identity needs a secret key or a pubkey')
  }
  return withKey(
    {
      kind: 'nostr',
      pubkey: session.pk,
      label: `nostr ${nostrPub.slice(0, 8)}…${sig ? '' : ' (unsigned)'}`,
      attestation: { type: 'nostr', pubkey: nostrPub, sig, created_at: createdAt },
    },
    session.sk,
  )
}

/** Verify a Nostr session attestation with @beamhop/p2p's `verifyNostrAttestation`. */
export function verifyNostrAttestation(identity: StudioIdentity): boolean {
  const a = identity.attestation
  if (a.type !== 'nostr' || !a.sig) return false
  try {
    return libVerifyNostrAttestation(a, identity.pubkey)
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

/** Decode (not verify; the room verifies against the issuer JWKS) an attestation JWS. */
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
