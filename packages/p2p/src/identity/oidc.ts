import { ed25519 } from '@noble/curves/ed25519'
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import type { Attestation, Hex, IdentityProvider } from '../types'
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
} from '../util/bytes'
import type { LocalIdentityProvider } from './anonymous'
import { generateSecretKey, getPublicKey, keyIdentity, type LocalIdentity } from './key'
import { verifyNostrAttestation } from './nostr'

/** Payload of an attestation certificate minted by the app backend. */
export interface AttestationCert {
  v: 1
  iss: string
  sub: string
  pubkey: Hex
  iat: number
  exp: number
}

export interface Jwk {
  kty: string
  kid?: string
  alg?: string
  crv?: string
  x?: string
  y?: string
  n?: string
  e?: string
  [k: string]: unknown
}

export type JwksResolver = (iss: string) => Promise<{ keys: Jwk[] }>

/** Fetches `<iss>/.well-known/openid-configuration` → `jwks_uri`, cached for `ttlMs`. */
export function fetchJwks(opts: { ttlMs?: number; fetch?: typeof fetch } = {}): JwksResolver {
  const cache = new Map<string, { at: number; value: Promise<{ keys: Jwk[] }> }>()
  const ttl = opts.ttlMs ?? 10 * 60_000
  const f = opts.fetch ?? fetch
  return (iss) => {
    const hit = cache.get(iss)
    if (hit && Date.now() - hit.at < ttl) return hit.value
    const value = (async () => {
      const conf = (await (
        await f(`${iss.replace(/\/$/, '')}/.well-known/openid-configuration`)
      ).json()) as { jwks_uri?: string }
      const uri = conf.jwks_uri ?? `${iss.replace(/\/$/, '')}/.well-known/jwks.json`
      return (await (await f(uri)).json()) as { keys: Jwk[] }
    })()
    value.catch(() => cache.delete(iss))
    cache.set(iss, { at: Date.now(), value })
    return value
  }
}

/** Static JWKS per issuer (tests, offline deployments). */
export function staticJwks(map: Record<string, { keys: Jwk[] }>): JwksResolver {
  return async (iss) => {
    const v = map[iss]
    if (!v) throw new Error(`no JWKS for issuer ${iss}`)
    return v
  }
}

function decodeJws(jws: string): {
  header: { alg?: string; kid?: string }
  payload: unknown
  signingInput: Uint8Array
  sig: Uint8Array
} {
  const parts = jws.split('.')
  if (parts.length !== 3) throw new Error('jws: expected compact serialization')
  const [h, p, s] = parts as [string, string, string]
  return {
    header: JSON.parse(bytesToUtf8(base64UrlDecode(h))),
    payload: JSON.parse(bytesToUtf8(base64UrlDecode(p))),
    signingInput: utf8ToBytes(`${h}.${p}`),
    sig: base64UrlDecode(s),
  }
}

async function verifySig(
  alg: string,
  jwk: Jwk,
  input: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  try {
    if (alg === 'ES256') {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return false
      const pub = concatBytes(new Uint8Array([4]), base64UrlDecode(jwk.x), base64UrlDecode(jwk.y))
      return p256.verify(sig, sha256(input), pub, { lowS: false })
    }
    if (alg === 'EdDSA') {
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) return false
      return ed25519.verify(sig, input, base64UrlDecode(jwk.x))
    }
    if (alg === 'RS256') {
      if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return false
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      return crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        sig as BufferSource,
        input as BufferSource,
      )
    }
  } catch {
    return false
  }
  return false
}

export type AttestationResult =
  | { ok: true; type: Attestation['type']; subject?: string; issuer?: string; nostrPubkey?: Hex }
  | { ok: false; type: Attestation['type'] | 'unknown'; reason: string }

export interface VerifyAttestationOptions {
  jwks?: JwksResolver
  /** Seconds since epoch; defaults to now. */
  now?: number
  /** Accept only these OIDC issuers (checked before fetching keys). */
  issuers?: string[]
  /** Clock skew tolerance in seconds (default 60). */
  skewS?: number
}

/** Verify an attestation certificate (JWS) binds `sessionPubkey`; returns the decoded cert. */
export async function verifyAttestationCert(
  jws: string,
  sessionPubkey: Hex,
  opts: VerifyAttestationOptions = {},
): Promise<AttestationCert> {
  const { header, payload, signingInput, sig } = decodeJws(jws)
  const cert = payload as Partial<AttestationCert>
  if (cert.v !== 1) throw new Error('cert: unsupported version')
  if (typeof cert.iss !== 'string' || typeof cert.sub !== 'string')
    throw new Error('cert: missing iss/sub')
  if (cert.pubkey !== sessionPubkey) throw new Error('cert: pubkey mismatch')
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const skew = opts.skewS ?? 60
  if (typeof cert.exp !== 'number' || cert.exp + skew < now) throw new Error('cert: expired')
  if (typeof cert.iat === 'number' && cert.iat - skew > now)
    throw new Error('cert: issued in the future')
  if (opts.issuers && !opts.issuers.includes(cert.iss)) throw new Error('cert: issuer not allowed')
  const alg = header.alg
  if (alg !== 'ES256' && alg !== 'EdDSA' && alg !== 'RS256')
    throw new Error(`cert: unsupported alg ${alg}`)
  const resolver = opts.jwks ?? defaultJwks()
  const { keys } = await resolver(cert.iss)
  const candidates = keys.filter((k) => (header.kid ? k.kid === header.kid : true))
  for (const k of candidates) {
    if (await verifySig(alg, k, signingInput, sig)) return cert as AttestationCert
  }
  throw new Error('cert: bad signature')
}

let sharedJwks: JwksResolver | null = null
const defaultJwks = () => {
  if (!sharedJwks) sharedJwks = fetchJwks()
  return sharedJwks
}

/** Verify any attestation against a session pubkey. */
export async function verifyAttestation(
  att: Attestation,
  sessionPubkey: Hex,
  opts: VerifyAttestationOptions = {},
): Promise<AttestationResult> {
  switch (att.type) {
    case 'anonymous':
      return { ok: true, type: 'anonymous' }
    case 'nostr':
      return verifyNostrAttestation(att, sessionPubkey)
        ? { ok: true, type: 'nostr', nostrPubkey: att.pubkey }
        : { ok: false, type: 'nostr', reason: 'bad nostr attestation signature' }
    case 'oidc':
      try {
        const cert = await verifyAttestationCert(att.jws, sessionPubkey, opts)
        return { ok: true, type: 'oidc', subject: cert.sub, issuer: cert.iss }
      } catch (err) {
        return { ok: false, type: 'oidc', reason: (err as Error).message }
      }
    default:
      return { ok: false, type: 'unknown', reason: 'unknown attestation type' }
  }
}

// ---------------------------------------------------------------- backend helper

export interface SignCertOptions {
  alg: 'ES256' | 'EdDSA'
  /** Raw private key: 32 bytes for both P-256 and Ed25519. */
  privateKey: Uint8Array
  kid?: string
  iss: string
  sub: string
  pubkey: Hex
  ttlS?: number
  now?: number
}

/** Mint an attestation certificate. Runs on the app backend after it authenticated the user's JWT. */
export function signAttestationCert(o: SignCertOptions): string {
  const iat = o.now ?? Math.floor(Date.now() / 1000)
  const header = { alg: o.alg, typ: 'JWT', ...(o.kid ? { kid: o.kid } : {}) }
  const payload: AttestationCert = {
    v: 1,
    iss: o.iss,
    sub: o.sub,
    pubkey: o.pubkey,
    iat,
    exp: iat + (o.ttlS ?? 3600),
  }
  const input = `${base64UrlEncode(utf8ToBytes(JSON.stringify(header)))}.${base64UrlEncode(utf8ToBytes(JSON.stringify(payload)))}`
  const bytes = utf8ToBytes(input)
  const sig =
    o.alg === 'ES256'
      ? p256.sign(sha256(bytes), o.privateKey, { lowS: false }).toCompactRawBytes()
      : ed25519.sign(bytes, o.privateKey)
  return `${input}.${base64UrlEncode(sig)}`
}

/** Public JWK for a raw private key, for publishing in the backend's JWKS. */
export function publicJwk(alg: 'ES256' | 'EdDSA', privateKey: Uint8Array, kid?: string): Jwk {
  if (alg === 'ES256') {
    const pub = p256.getPublicKey(privateKey, false)
    return {
      kty: 'EC',
      crv: 'P-256',
      alg,
      x: base64UrlEncode(pub.subarray(1, 33)),
      y: base64UrlEncode(pub.subarray(33, 65)),
      ...(kid ? { kid } : {}),
    }
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    alg,
    x: base64UrlEncode(ed25519.getPublicKey(privateKey)),
    ...(kid ? { kid } : {}),
  }
}

// ---------------------------------------------------------------- provider

export interface OidcOptions {
  /**
   * Ask your backend for a cert binding the user's JWT `sub` to this session pubkey. The backend verifies
   * the user's OIDC token, then returns signAttestationCert({ iss, sub, pubkey }).
   */
  getCert(sessionPubkey: Hex): Promise<string> | string
  secretKey?: Uint8Array
}

export function oidc(opts: OidcOptions): LocalIdentityProvider {
  return {
    kind: 'oidc',
    async load() {
      const sk = opts.secretKey ?? generateSecretKey()
      const pubkey = getPublicKey(sk)
      const jws = await opts.getCert(pubkey)
      return keyIdentity(sk, [{ type: 'oidc', jws }])
    },
  }
}
