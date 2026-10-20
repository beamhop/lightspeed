import { describe, expect, test } from 'bun:test'
import {
  type Attestation,
  createNostrAttestation,
  verifyNostrAttestation as libVerify,
  secretKeySigner,
} from '@beamhop/p2p'
import { hexToBytes } from '@noble/hashes/utils'
import {
  anonymousIdentity,
  bech32Decode,
  decodeOidcAttestation,
  nostrIdentity,
  oidcIdentity,
  parsePubkey,
  sessionSecretKey,
  verifyNostrAttestation,
} from './identity'

// NIP-19 test vector
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jws = (claims: unknown) => `${b64url({ alg: 'ES256' })}.${b64url(claims)}.c2ln`

describe('identity switcher', () => {
  test('anonymous identity has a fresh x-only pubkey', () => {
    const a = anonymousIdentity()
    const b = anonymousIdentity()
    expect(a.identity.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.identity.pubkey).not.toBe(b.identity.pubkey)
    expect(a.identity.attestation).toEqual({ type: 'anonymous' })
  })

  test('npub / hex parsing', () => {
    expect(parsePubkey(NPUB)).toBe(NPUB_HEX)
    expect(parsePubkey(NPUB_HEX.toUpperCase())).toBe(NPUB_HEX)
    expect(() => parsePubkey('npub1qqqq')).toThrow()
    expect(() => bech32Decode(`${NPUB.slice(0, -1)}q`)).toThrow('checksum')
  })

  test('nostr identity with a secret key carries a verifiable attestation', () => {
    const sk = '0000000000000000000000000000000000000000000000000000000000000003'
    const { identity } = nostrIdentity({ secretKey: sk })
    expect(identity.kind).toBe('nostr')
    expect(identity.attestation.type).toBe('nostr')
    expect(verifyNostrAttestation(identity)).toBe(true)
    // tampering with the session key breaks it
    expect(
      verifyNostrAttestation({ ...identity, pubkey: anonymousIdentity().identity.pubkey }),
    ).toBe(false)
  })

  test('nostr attestation matches the library format (kind 28100)', async () => {
    const skHex = '0000000000000000000000000000000000000000000000000000000000000003'
    const { identity, secretKey } = nostrIdentity({ secretKey: skHex, createdAt: 1_700_000_000 })
    const att = identity.attestation as Extract<Attestation, { type: 'nostr' }>
    // The library verifies Studio's attestation...
    expect(libVerify(att, identity.pubkey)).toBe(true)
    expect(att.created_at).toBe(1_700_000_000)
    // ...and produces the same signed message for the same inputs.
    const lib = await createNostrAttestation(
      secretKeySigner(hexToBytes(skHex)),
      identity.pubkey,
      1_700_000_000,
    )
    expect(lib.pubkey).toBe(att.pubkey)
    expect(verifyNostrAttestation({ ...identity, attestation: lib })).toBe(true)
    // The session secret key is remembered for the observer, never put on the identity.
    expect(sessionSecretKey(identity)).toBe(secretKey)
    expect(JSON.stringify(identity)).not.toContain(secretKey)
  })

  test('nostr identity from pubkey only is unsigned', () => {
    const { identity } = nostrIdentity({ pubkey: NPUB })
    expect(identity.attestation).toMatchObject({ type: 'nostr', pubkey: NPUB_HEX, sig: '' })
    expect(identity.label).toContain('unsigned')
    expect(verifyNostrAttestation(identity)).toBe(false)
  })

  test('oidc attestation decoding and expiry', () => {
    const claims = {
      v: 1 as const,
      iss: 'https://id.example',
      sub: 'alice',
      pubkey: NPUB_HEX,
      iat: 1,
      exp: 2_000_000_000,
    }
    expect(decodeOidcAttestation(jws(claims))).toEqual(claims)
    const id = oidcIdentity(jws(claims), 1_000_000)
    expect(id.pubkey).toBe(NPUB_HEX)
    expect(id.label).toBe('alice @ https://id.example')
    expect(() => oidcIdentity(jws({ ...claims, exp: 10 }), Date.now())).toThrow('expired')
    expect(() => decodeOidcAttestation('a.b')).toThrow('compact JWS')
    expect(() => decodeOidcAttestation(jws({ ...claims, v: 2 }))).toThrow('version')
    expect(() => decodeOidcAttestation(jws({ ...claims, sub: '' }))).toThrow('sub')
  })
})
