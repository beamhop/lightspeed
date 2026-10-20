// Nostr sign-in helpers: event hashing, NIP-07 (browser extension), NIP-44 v2 and a NIP-46 bunker client.

import { chacha20 } from '@noble/ciphers/chacha'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1'
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils'
import type { WsLike } from './stats'
import type { NostrEvent, UnsignedEvent } from './types'

export const KIND_ADMIN_AUTH = 27235
export const KIND_NIP46 = 24133

export function eventHash(e: UnsignedEvent & { pubkey: string }): string {
  return bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))),
  )
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (eventHash(e) !== e.id) return false
    return schnorr.verify(e.sig, e.id, e.pubkey)
  } catch {
    return false
  }
}

export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(e: UnsignedEvent): Promise<NostrEvent>
  close?(): void
}

export function localSigner(secretHex?: string): Signer & { secret: string } {
  const secret = secretHex ?? bytesToHex(secp256k1.utils.randomPrivateKey())
  const pub = bytesToHex(schnorr.getPublicKey(secret))
  return {
    secret,
    async getPublicKey() {
      return pub
    },
    async signEvent(e) {
      const base = { ...e, pubkey: pub }
      const id = eventHash(base)
      const sig = bytesToHex(schnorr.sign(id, secret))
      return {
        id,
        pubkey: pub,
        created_at: e.created_at,
        kind: e.kind,
        tags: e.tags,
        content: e.content,
        sig,
      }
    },
  }
}

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(e: UnsignedEvent): Promise<NostrEvent>
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { nostr?: Nip07 }).nostr
}

export function nip07Signer(): Signer {
  const n = (globalThis as unknown as { nostr?: Nip07 }).nostr
  if (!n) throw new Error('No NIP-07 extension found (install Alby, nos2x or similar)')
  return { getPublicKey: () => n.getPublicKey(), signEvent: (e) => n.signEvent(e) }
}

/** The kind 27235 event the relay verifies in POST /auth/nostr. */
export function authEventTemplate(challenge: string, url: string, now = Date.now()): UnsignedEvent {
  return {
    kind: KIND_ADMIN_AUTH,
    created_at: Math.floor(now / 1000),
    tags: [
      ['challenge', challenge],
      ['u', url],
      ['method', 'POST'],
    ],
    content: '',
  }
}

// ---- NIP-44 v2 ----
const b64 = {
  enc(b: Uint8Array): string {
    let s = ''
    for (const x of b) s += String.fromCharCode(x)
    return btoa(s)
  },
  dec(s: string): Uint8Array {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  },
}

export function nip44ConversationKey(privHex: string, pubHex: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(privHex, `02${pubHex}`).subarray(1, 33)
  return hkdfExtract(sha256, shared, utf8ToBytes('nip44-v2'))
}

export function nip44PaddedLen(len: number): number {
  if (len <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((len - 1) / chunk) + 1)
}

function messageKeys(ck: Uint8Array, nonce: Uint8Array) {
  const k = hkdfExpand(sha256, ck, nonce, 76)
  return { key: k.subarray(0, 32), nonce: k.subarray(32, 44), hmacKey: k.subarray(44, 76) }
}

export function nip44Encrypt(
  plaintext: string,
  ck: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const pt = utf8ToBytes(plaintext)
  if (pt.length < 1 || pt.length > 65535) throw new Error('nip44: invalid plaintext length')
  const padded = new Uint8Array(2 + nip44PaddedLen(pt.length))
  new DataView(padded.buffer).setUint16(0, pt.length)
  padded.set(pt, 2)
  const keys = messageKeys(ck, nonce)
  const ct = chacha20(keys.key, keys.nonce, padded)
  const mac = hmac(sha256, keys.hmacKey, concatBytes(nonce, ct))
  return b64.enc(concatBytes(new Uint8Array([2]), nonce, ct, mac))
}

export function nip44Decrypt(payload: string, ck: Uint8Array): string {
  const data = b64.dec(payload)
  if (data[0] !== 2) throw new Error('nip44: unknown version')
  const nonce = data.subarray(1, 33)
  const ct = data.subarray(33, data.length - 32)
  const mac = data.subarray(data.length - 32)
  const keys = messageKeys(ck, nonce)
  const expected = hmac(sha256, keys.hmacKey, concatBytes(nonce, ct))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (expected[i] as number) ^ (mac[i] as number)
  if (diff !== 0 || mac.length !== 32) throw new Error('nip44: invalid MAC')
  const padded = chacha20(keys.key, keys.nonce, ct)
  const len = new DataView(padded.buffer, padded.byteOffset).getUint16(0)
  if (len < 1 || 2 + len > padded.length || padded.length !== 2 + nip44PaddedLen(len)) {
    throw new Error('nip44: invalid padding')
  }
  return new TextDecoder().decode(padded.subarray(2, 2 + len))
}

// ---- NIP-46 ----
export interface BunkerPointer {
  remotePubkey: string
  relays: string[]
  secret?: string
}

export function parseBunkerUri(uri: string): BunkerPointer {
  const m = /^bunker:\/\/([0-9a-f]{64})\??(.*)$/i.exec(uri.trim())
  if (!m) throw new Error('Expected bunker://<64-hex pubkey>?relay=wss://…')
  const params = new URLSearchParams(m[2])
  const relays = params.getAll('relay').filter((r) => /^wss?:\/\//.test(r))
  if (!relays.length) throw new Error('Bunker URI needs at least one relay= parameter')
  const secret = params.get('secret') ?? undefined
  return { remotePubkey: (m[1] as string).toLowerCase(), relays, ...(secret ? { secret } : {}) }
}

export interface Nip46Options {
  createSocket?: (url: string) => WsLike & { send(data: string): void }
  timeoutMs?: number
  /** Called when the bunker asks the user to approve at a URL. */
  onAuthUrl?: (url: string) => void
  clientSecret?: string
}

/** Connect to a remote signer. Resolves once `connect` succeeded. */
export async function nip46Signer(uri: string, opts: Nip46Options = {}): Promise<Signer> {
  const ptr = parseBunkerUri(uri)
  const client = localSigner(opts.clientSecret)
  const clientPub = await client.getPublicKey()
  const ck = nip44ConversationKey(client.secret, ptr.remotePubkey)
  const timeoutMs = opts.timeoutMs ?? 90_000
  const factory =
    opts.createSocket ??
    ((url: string) => new WebSocket(url) as unknown as WsLike & { send(d: string): void })
  const ws = factory(ptr.relays[0] as string)
  const pending = new Map<
    string,
    {
      resolve: (v: string) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const subId = `bh-admin-${bytesToHex(randomBytes(4))}`

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Bunker relay did not open')), 10_000)
    ws.onopen = () => {
      clearTimeout(t)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(t)
      reject(new Error(`Could not reach ${ptr.relays[0]}`))
    }
  })
  ws.send(
    JSON.stringify([
      'REQ',
      subId,
      { kinds: [KIND_NIP46], '#p': [clientPub], since: Math.floor(Date.now() / 1000) - 10 },
    ]),
  )
  ws.onmessage = (ev) => {
    let msg: unknown
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg[1] !== subId) return
    const e = msg[2] as NostrEvent
    if (e?.kind !== KIND_NIP46 || e.pubkey !== ptr.remotePubkey) return
    let body: { id: string; result?: string; error?: string }
    try {
      body = JSON.parse(nip44Decrypt(e.content, ck))
    } catch {
      return
    }
    const p = pending.get(body.id)
    if (!p) return
    if (body.result === 'auth_url' && body.error) {
      opts.onAuthUrl?.(body.error)
      return // keep waiting for the real answer
    }
    clearTimeout(p.timer)
    pending.delete(body.id)
    if (body.error) p.reject(new Error(`Bunker: ${body.error}`))
    else p.resolve(body.result ?? '')
  }
  ws.onclose = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Bunker connection closed'))
    }
    pending.clear()
  }

  const call = async (method: string, params: string[]): Promise<string> => {
    const id = bytesToHex(randomBytes(8))
    const content = nip44Encrypt(JSON.stringify({ id, method, params }), ck)
    const ev = await client.signEvent({
      kind: KIND_NIP46,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', ptr.remotePubkey]],
      content,
    })
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Bunker did not answer ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify(['EVENT', ev]))
    })
  }

  const connectParams = [ptr.remotePubkey, ...(ptr.secret ? [ptr.secret] : [])]
  try {
    await call('connect', connectParams)
  } catch (e) {
    ws.close()
    throw e
  }
  let userPub: string | null = null
  const getPublicKey = async () => {
    userPub ??= await call('get_public_key', [])
    return userPub
  }
  return {
    getPublicKey,
    async signEvent(e) {
      const pubkey = await getPublicKey()
      const signed = JSON.parse(
        await call('sign_event', [JSON.stringify({ ...e, pubkey })]),
      ) as NostrEvent
      if (!verifyEvent(signed)) throw new Error('Bunker returned an invalid signature')
      return signed
    },
    close() {
      try {
        ws.send(JSON.stringify(['CLOSE', subId]))
      } catch {}
      ws.close()
    },
  }
}

export { bytesToHex, hexToBytes }
