import { encrypt as nip44Encrypt, decrypt as nip44Decrypt, getConversationKey } from '../crypto/nip44'
import {
  type NostrEvent,
  type UnsignedEvent,
  decodeNsec,
  eventHash,
  finalizeEvent,
  schnorrVerify,
} from '../crypto/nostr'
import type { Attestation, Hex, IdentityProvider, Unsubscribe } from '../types'
import { hexToBytes, randomId } from '../util/bytes'
import { KIND_NIP46, KIND_SESSION_ATTESTATION } from '../wire'
import { type LocalIdentity, generateSecretKey, getPublicKey, keyIdentity } from './key'

/** Anything that can sign Nostr events for a user key: a NIP-07 extension, an nsec, or a NIP-46 bunker. */
export interface NostrSigner {
  getPublicKey(): Promise<Hex>
  signEvent(event: UnsignedEvent): Promise<NostrEvent>
}

export const SESSION_ATTESTATION_CONTENT = 'beamhop-session'

/** The event a Nostr key signs to vouch for a session pubkey. Its id is the attestation message. */
export function sessionAttestationEvent(sessionPubkey: Hex, createdAt: number): UnsignedEvent {
  return {
    kind: KIND_SESSION_ATTESTATION,
    created_at: createdAt,
    tags: [['p', sessionPubkey]],
    content: SESSION_ATTESTATION_CONTENT,
  }
}

export async function createNostrAttestation(
  signer: NostrSigner,
  sessionPubkey: Hex,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<Extract<Attestation, { type: 'nostr' }>> {
  const signed = await signer.signEvent(sessionAttestationEvent(sessionPubkey, createdAt))
  return { type: 'nostr', pubkey: signed.pubkey, sig: signed.sig, created_at: signed.created_at }
}

export function verifyNostrAttestation(
  att: Extract<Attestation, { type: 'nostr' }>,
  sessionPubkey: Hex,
): boolean {
  const ev = sessionAttestationEvent(sessionPubkey, att.created_at ?? 0)
  const id = eventHash({ ...ev, pubkey: att.pubkey })
  return schnorrVerify(att.sig, hexToBytes(id), att.pubkey)
}

export function secretKeySigner(secretKey: Uint8Array): NostrSigner {
  const pubkey = getPublicKey(secretKey)
  return {
    async getPublicKey() {
      return pubkey
    },
    async signEvent(event) {
      return finalizeEvent(event, secretKey)
    },
  }
}

// ---------------------------------------------------------------- NIP-46


/** How NIP-46 requests reach the bunker. Wire it to any relay client (e.g. @beamhop/signaling-nostr's pool). */
export interface Nip46Transport {
  publish(event: NostrEvent): Promise<void>
  subscribe(filter: { kinds: number[]; '#p': Hex[] }, onEvent: (event: NostrEvent) => void): Unsubscribe
}

export interface Nip46Options {
  transport: Nip46Transport
  /** The bunker's (remote signer's) pubkey. */
  remotePubkey: Hex
  /** Optional connect secret from a bunker:// URL. */
  secret?: string
  /** Client keypair used to talk to the bunker; generated when omitted. */
  clientSecretKey?: Uint8Array
  timeoutMs?: number
}

export function parseBunkerUrl(url: string): { remotePubkey: Hex; relays: string[]; secret?: string } {
  const u = new URL(url)
  if (u.protocol !== 'bunker:') throw new Error('not a bunker:// url')
  const remotePubkey = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) throw new Error('invalid bunker pubkey')
  const secret = u.searchParams.get('secret') ?? undefined
  return { remotePubkey, relays: u.searchParams.getAll('relay'), ...(secret ? { secret } : {}) }
}

/** NIP-46 remote signer client speaking NIP-44-encrypted kind 24133 events over `transport`. */
export function nip46Signer(opts: Nip46Options): NostrSigner & { connect(): Promise<void>; close(): void } {
  const sk = opts.clientSecretKey ?? generateSecretKey()
  const clientPubkey = getPublicKey(sk)
  const ck = getConversationKey(sk, opts.remotePubkey)
  const pending = new Map<string, { resolve(v: string): void; reject(e: Error): void }>()
  const timeoutMs = opts.timeoutMs ?? 30_000
  let connected: Promise<void> | null = null
  let userPubkey: Hex | null = null

  const unsub = opts.transport.subscribe({ kinds: [KIND_NIP46], '#p': [clientPubkey] }, (ev) => {
    if (ev.pubkey !== opts.remotePubkey) return
    let msg: { id?: string; result?: string; error?: string }
    try {
      msg = JSON.parse(nip44Decrypt(ev.content, ck))
    } catch {
      return
    }
    const p = msg.id ? pending.get(msg.id) : undefined
    if (!p || !msg.id) return
    if (msg.result === 'auth_url') return // keep waiting; the user approves out of band
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(`nip46: ${msg.error}`))
    else p.resolve(msg.result ?? '')
  })

  const rpc = (method: string, params: string[]): Promise<string> => {
    const id = randomId(8)
    const content = nip44Encrypt(JSON.stringify({ id, method, params }), ck)
    const ev = finalizeEvent(
      {
        kind: KIND_NIP46,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', opts.remotePubkey]],
        content,
      },
      sk,
    )
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`nip46: ${method} timed out`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      opts.transport.publish(ev).catch((e) => {
        pending.delete(id)
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  const connect = () => {
    if (!connected) {
      const params = [opts.remotePubkey, ...(opts.secret ? [opts.secret] : [])]
      connected = rpc('connect', params).then(() => undefined)
    }
    return connected
  }

  return {
    connect,
    async getPublicKey() {
      await connect()
      if (!userPubkey) userPubkey = await rpc('get_public_key', [])
      return userPubkey
    },
    async signEvent(event) {
      await connect()
      const signed = JSON.parse(await rpc('sign_event', [JSON.stringify(event)])) as NostrEvent
      return signed
    },
    close() {
      unsub()
      for (const p of pending.values()) p.reject(new Error('nip46: closed'))
      pending.clear()
    },
  }
}

// ---------------------------------------------------------------- provider

interface Nip07 {
  getPublicKey(): Promise<Hex>
  signEvent(event: UnsignedEvent): Promise<NostrEvent>
}

export type NostrOptions =
  | { nsec: string | Uint8Array }
  | { extension?: Nip07 }
  | { bunker: NostrSigner }
  | { signer: NostrSigner }

/**
 * Nostr identity: a fresh session key vouched for by the user's Nostr key (NIP-07 extension, nsec or
 * NIP-46 bunker). Peers see the session pubkey plus a `nostr` attestation naming the user pubkey.
 */
export function nostr(opts: NostrOptions = {}): IdentityProvider & {
  load(): Promise<LocalIdentity & { nostrPubkey: Hex }>
} {
  const signer = (): NostrSigner => {
    if ('nsec' in opts) {
      const sk = typeof opts.nsec === 'string' ? (opts.nsec.startsWith('nsec') ? decodeNsec(opts.nsec) : hexToBytes(opts.nsec)) : opts.nsec
      return secretKeySigner(sk)
    }
    if ('bunker' in opts) return opts.bunker
    if ('signer' in opts) return opts.signer
    const ext = opts.extension ?? (globalThis as { nostr?: Nip07 }).nostr
    if (!ext) throw new Error('nostr(): no NIP-07 extension (window.nostr) found')
    return ext
  }
  return {
    kind: 'nostr',
    async load() {
      const s = signer()
      const sk = generateSecretKey()
      const session = getPublicKey(sk)
      const att = await createNostrAttestation(s, session)
      if (!verifyNostrAttestation(att, session)) throw new Error('nostr(): signer returned an invalid signature')
      const id = keyIdentity(sk, [att])
      return Object.assign(id, { nostrPubkey: att.pubkey })
    },
  }
}
