import { describe, expect, test } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '../util/bytes'
import { calcPaddedLen, decrypt, encrypt, getConversationKey, getMessageKeys } from './nip44'
import { vectors } from './nip44.vectors'

const v = vectors

describe('nip44 v2 (official vectors)', () => {
  test('get_conversation_key', () => {
    for (const t of v.valid.get_conversation_key) {
      expect(bytesToHex(getConversationKey(t.sec1, t.pub2))).toBe(t.conversation_key)
    }
  })

  test('get_message_keys', () => {
    const ck = hexToBytes(v.valid.get_message_keys.conversation_key)
    for (const t of v.valid.get_message_keys.keys) {
      const k = getMessageKeys(ck, hexToBytes(t.nonce))
      expect(bytesToHex(k.chachaKey)).toBe(t.chacha_key)
      expect(bytesToHex(k.chachaNonce)).toBe(t.chacha_nonce)
      expect(bytesToHex(k.hmacKey)).toBe(t.hmac_key)
    }
  })

  test('calc_padded_len', () => {
    for (const [len, padded] of v.valid.calc_padded_len) expect(calcPaddedLen(len)).toBe(padded)
  })

  test('encrypt_decrypt', () => {
    for (const t of v.valid.encrypt_decrypt) {
      const pub2 = bytesToHex(schnorr.getPublicKey(t.sec2))
      const ck = getConversationKey(t.sec1, pub2)
      expect(bytesToHex(ck)).toBe(t.conversation_key)
      const payload = encrypt(t.plaintext, ck, hexToBytes(t.nonce))
      expect(payload).toBe(t.payload)
      expect(decrypt(t.payload, ck)).toBe(t.plaintext)
      // Symmetric: the other side derives the same key.
      const pub1 = bytesToHex(schnorr.getPublicKey(t.sec1))
      expect(decrypt(payload, getConversationKey(t.sec2, pub1))).toBe(t.plaintext)
    }
  })

  test('encrypt_decrypt_long_msg', () => {
    for (const t of v.valid.encrypt_decrypt_long_msg) {
      const plaintext = t.pattern.repeat(t.repeat)
      expect(bytesToHex(sha256(new TextEncoder().encode(plaintext)))).toBe(t.plaintext_sha256)
      const ck = hexToBytes(t.conversation_key)
      const payload = encrypt(plaintext, ck, hexToBytes(t.nonce))
      expect(bytesToHex(sha256(new TextEncoder().encode(payload)))).toBe(t.payload_sha256)
      expect(decrypt(payload, ck)).toBe(plaintext)
    }
  })

  test('invalid get_conversation_key', () => {
    for (const t of v.invalid.get_conversation_key) {
      expect(() => getConversationKey(t.sec1, t.pub2)).toThrow()
    }
  })

  test('invalid decrypt', () => {
    for (const t of v.invalid.decrypt) {
      expect(() => decrypt(t.payload, hexToBytes(t.conversation_key))).toThrow()
    }
  })

  test('invalid message lengths', () => {
    const ck = new Uint8Array(32).fill(1)
    for (const len of v.invalid.encrypt_msg_lengths) {
      expect(() => encrypt('a'.repeat(len), ck)).toThrow()
    }
  })
})
