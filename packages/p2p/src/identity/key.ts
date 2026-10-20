import { schnorr } from '@noble/curves/secp256k1'
import * as nip44 from '../crypto/nip44'
import type { Attestation, Hex, Identity } from '../types'
import { bytesToHex, hexToBytes, randomBytes } from '../util/bytes'

export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomPrivateKey()
}

export function getPublicKey(secretKey: Uint8Array | Hex): Hex {
  return bytesToHex(
    schnorr.getPublicKey(typeof secretKey === 'string' ? hexToBytes(secretKey) : secretKey),
  )
}

/** An identity backed by an in-memory secp256k1 secret key (the session key). */
export interface LocalIdentity extends Identity {
  /** Raw secret key; never sent anywhere. Exposed for persistence and Bun server peers. */
  readonly secretKey: Uint8Array
}

export function keyIdentity(
  secretKey: Uint8Array | Hex,
  attestations: readonly Attestation[] = [{ type: 'anonymous' }],
): LocalIdentity {
  const sk = typeof secretKey === 'string' ? hexToBytes(secretKey) : secretKey
  const pubkey = bytesToHex(schnorr.getPublicKey(sk))
  const keys = new Map<Hex, Uint8Array>()
  const ck = (peer: Hex): Uint8Array => {
    let k = keys.get(peer)
    if (!k) {
      k = nip44.getConversationKey(sk, peer)
      keys.set(peer, k)
    }
    return k
  }
  return {
    pubkey,
    attestations,
    secretKey: sk,
    async sign(hash32) {
      return schnorr.sign(hash32, sk, randomBytes(32))
    },
    async encrypt(to, plaintext) {
      return nip44.encrypt(plaintext, ck(to))
    },
    async decrypt(from, payload) {
      return nip44.decrypt(payload, ck(from))
    },
    async conversationKey(peer) {
      return ck(peer)
    },
  }
}
