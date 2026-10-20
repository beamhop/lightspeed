// NIP-44 v2 encryption (https://github.com/nostr-protocol/nips/blob/master/44.md).
import { chacha20 } from '@noble/ciphers/chacha'
import { secp256k1 } from '@noble/curves/secp256k1'
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import {
  bytesToUtf8,
  concatBytes,
  equalBytes,
  fromBase64,
  hexToBytes,
  randomBytes,
  toBase64,
  utf8ToBytes,
} from '../util/bytes'

const SALT = utf8ToBytes('nip44-v2')
const MIN_PLAINTEXT = 1
const MAX_PLAINTEXT = 65535

function toBytes(k: Uint8Array | string): Uint8Array {
  return typeof k === 'string' ? hexToBytes(k) : k
}

/** Conversation key = HKDF-extract(sha256, ECDH x-coordinate, salt 'nip44-v2'). Symmetric between the pair. */
export function getConversationKey(privateKey: Uint8Array | string, publicKey: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(toBytes(privateKey), `02${publicKey}`)
  return hkdfExtract(sha256, shared.subarray(1, 33), SALT)
}

export function getMessageKeys(
  conversationKey: Uint8Array,
  nonce: Uint8Array,
): { chachaKey: Uint8Array; chachaNonce: Uint8Array; hmacKey: Uint8Array } {
  if (conversationKey.length !== 32) throw new Error('nip44: invalid conversation key length')
  if (nonce.length !== 32) throw new Error('nip44: invalid nonce length')
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76)
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  }
}

export function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new Error('nip44: expected positive integer')
  if (len <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((len - 1) / chunk) + 1)
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8ToBytes(plaintext)
  const len = unpadded.length
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) {
    throw new Error('nip44: invalid plaintext size: must be between 1 and 65535 bytes')
  }
  const prefix = new Uint8Array(2)
  new DataView(prefix.buffer).setUint16(0, len)
  const suffix = new Uint8Array(calcPaddedLen(len) - len)
  return concatBytes(prefix, unpadded, suffix)
}

function unpad(padded: Uint8Array): string {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0)
  const unpadded = padded.subarray(2, 2 + len)
  if (
    len < MIN_PLAINTEXT ||
    len > MAX_PLAINTEXT ||
    unpadded.length !== len ||
    padded.length !== 2 + calcPaddedLen(len)
  ) {
    throw new Error('nip44: invalid padding')
  }
  return bytesToUtf8(unpadded)
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Error('nip44: AAD associated data must be 32 bytes')
  return hmac(sha256, key, concatBytes(aad, message))
}

function decodePayload(payload: string): { nonce: Uint8Array; ciphertext: Uint8Array; mac: Uint8Array } {
  if (typeof payload !== 'string') throw new Error('nip44: payload must be a string')
  const plen = payload.length
  if (plen < 132 || plen > 87472) throw new Error(`nip44: invalid payload length: ${plen}`)
  if (payload[0] === '#') throw new Error('nip44: unknown encryption version')
  let data: Uint8Array
  try {
    data = fromBase64(payload)
  } catch (err) {
    throw new Error(`nip44: invalid base64: ${(err as Error).message}`)
  }
  const dlen = data.length
  if (dlen < 99 || dlen > 65603) throw new Error(`nip44: invalid data length: ${dlen}`)
  const vers = data[0]
  if (vers !== 2) throw new Error(`nip44: unknown encryption version ${vers}`)
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, -32),
    mac: data.subarray(-32),
  }
}

export function encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce)
  const padded = pad(plaintext)
  const ciphertext = chacha20(chachaKey, chachaNonce, padded)
  const mac = hmacAad(hmacKey, ciphertext, nonce)
  return toBase64(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac))
}

export function decrypt(payload: string, conversationKey: Uint8Array): string {
  const { nonce, ciphertext, mac } = decodePayload(payload)
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce)
  const calculated = hmacAad(hmacKey, ciphertext, nonce)
  if (!equalBytes(calculated, mac)) throw new Error('nip44: invalid MAC')
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext))
}

export const v2 = {
  utils: { getConversationKey, calcPaddedLen, getMessageKeys },
  encrypt,
  decrypt,
}
