import { describe, expect, test } from 'bun:test'
import { utf8ToBytes } from '@noble/hashes/utils'
import {
  base32Decode,
  base32Encode,
  hotp,
  normalizePubkey,
  randomHex,
  signEvent,
  totp,
  verifyEvent,
  verifyTotp,
} from './crypto'

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const secret = base32Encode(utf8ToBytes('12345678901234567890'))

  test('base32 round-trip', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(new TextDecoder().decode(base32Decode(secret))).toBe('12345678901234567890')
  })

  test('RFC 4226 HOTP vectors', () => {
    const key = utf8ToBytes('12345678901234567890')
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489'])
  })

  test('RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    expect(totp(secret, 59_000)).toBe('287082')
    expect(totp(secret, 1111111109_000)).toBe('081804')
    expect(totp(secret, 1234567890_000)).toBe('005924')
    expect(totp(secret, 20000000000_000)).toBe('353130')
  })

  test('verify accepts ±1 step and rejects others', () => {
    const now = 1234567890_000
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(Math.floor(now / 30_000) - 1)
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull()
    expect(verifyTotp(secret, 'abc', now)).toBeNull()
  })
})

describe('nostr helpers', () => {
  test('sign + verify, tamper detection', () => {
    const sk = randomHex(32)
    const e = signEvent(sk, { kind: 1, content: 'hi', tags: [['t', 'x']] })
    expect(verifyEvent(e)).toBe(true)
    expect(verifyEvent({ ...e, content: 'other' })).toBe(false)
    expect(verifyEvent(null)).toBe(false)
  })

  test('npub decoding (NIP-19 vector)', () => {
    expect(normalizePubkey('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')).toBe(
      '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e',
    )
    expect(
      normalizePubkey('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptX'),
    ).toBeNull()
    expect(normalizePubkey('A'.repeat(64))).toBe('a'.repeat(64))
  })
})
