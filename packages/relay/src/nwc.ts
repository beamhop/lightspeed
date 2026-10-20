// Minimal Nostr Wallet Connect (NIP-47) client: make_invoice + lookup_invoice over NIP-04.
import { secp256k1 } from '@noble/curves/secp256k1'
import type { NostrEvent } from './engines'
import { bytesToHex, getPublicKey, isHex64, signEvent, tagValue, verifyEvent } from './util/crypto'

export const NWC_REQUEST_KIND = 23194
export const NWC_RESPONSE_KIND = 23195

export interface MadeInvoice {
  invoice: string
  paymentHash: string
  /** Unix seconds, when the wallet reports it. */
  expiresAt?: number
}

export interface InvoiceStatus {
  paid: boolean
  preimage?: string
  settledAt?: number
  expired?: boolean
}

/** What the payments service needs from a wallet; injectable for tests. */
export interface NwcClient {
  makeInvoice(p: {
    amountMsat: number
    description: string
    expirySec: number
  }): Promise<MadeInvoice>
  lookupInvoice(p: { paymentHash: string }): Promise<InvoiceStatus>
  close(): void
}

export interface NwcUri {
  walletPubkey: string
  relays: string[]
  secret: string
  lud16?: string
}

export function parseNwcUrl(url: string): NwcUri {
  const m = /^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.*)$/i.exec(url.trim())
  if (!m)
    throw new Error('NWC URL must look like nostr+walletconnect://<pubkey>?relay=...&secret=...')
  const params = new URLSearchParams(m[2])
  const relays = params.getAll('relay')
  const secret = (params.get('secret') ?? '').toLowerCase()
  if (!relays.length) throw new Error('NWC URL needs a relay parameter')
  if (!isHex64(secret)) throw new Error('NWC URL needs a 32-byte hex secret')
  return {
    walletPubkey: (m[1] as string).toLowerCase(),
    relays,
    secret,
    lud16: params.get('lud16') ?? undefined,
  }
}

// ---------------------------------------------------------------- NIP-04

async function nip04Key(secret: string, pubkey: string): Promise<CryptoKey> {
  const shared = secp256k1.getSharedSecret(secret, `02${pubkey}`).slice(1, 33)
  return crypto.subtle.importKey('raw', shared, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function nip04Encrypt(secret: string, pubkey: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const key = await nip04Key(secret, pubkey)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(text)),
  )
  return `${b64(ct)}?iv=${b64(iv)}`
}

export async function nip04Decrypt(
  secret: string,
  pubkey: string,
  payload: string,
): Promise<string> {
  const [ct, iv] = payload.split('?iv=')
  if (!ct || !iv) throw new Error('malformed NIP-04 payload')
  const key = await nip04Key(secret, pubkey)
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: unb64(iv) }, key, unb64(ct))
  return new TextDecoder().decode(pt)
}

// ---------------------------------------------------------------- client

interface Pending {
  resolve(v: Record<string, unknown>): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class NwcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** NIP-47 client over a WebSocket to the wallet's relay. Connects lazily, reconnects on demand. */
export function createNwcClient(url: string, opts: { timeoutMs?: number } = {}): NwcClient {
  const uri = parseNwcUrl(url)
  const clientPubkey = getPublicKey(uri.secret)
  const pending = new Map<string, Pending>()
  const timeoutMs = opts.timeoutMs ?? 30_000
  let ws: WebSocket | null = null
  let ready: Promise<WebSocket> | null = null
  const subId = `nwc-${bytesToHex(crypto.getRandomValues(new Uint8Array(4)))}`

  function connect(): Promise<WebSocket> {
    if (ready && ws && ws.readyState <= WebSocket.OPEN) return ready
    ready = new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(uri.relays[0] as string)
      ws = sock
      sock.onopen = () => {
        sock.send(
          JSON.stringify([
            'REQ',
            subId,
            {
              kinds: [NWC_RESPONSE_KIND],
              authors: [uri.walletPubkey],
              '#p': [clientPubkey],
              since: Math.floor(Date.now() / 1000) - 60,
            },
          ]),
        )
        resolve(sock)
      }
      sock.onerror = () => reject(new NwcError('connection', 'could not connect to the NWC relay'))
      sock.onclose = () => {
        if (ws === sock) {
          ws = null
          ready = null
        }
      }
      sock.onmessage = (m) => void onMessage(String(m.data))
    })
    return ready
  }

  async function onMessage(text: string) {
    let msg: unknown[]
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg[0] === 'OK' && msg[2] === false) {
      const p = pending.get(String(msg[1]))
      if (p) {
        clearTimeout(p.timer)
        pending.delete(String(msg[1]))
        p.reject(new NwcError('rejected', `relay rejected request: ${String(msg[3] ?? '')}`))
      }
      return
    }
    if (msg[0] !== 'EVENT') return
    const ev = msg[2] as NostrEvent
    if (!verifyEvent(ev) || ev.kind !== NWC_RESPONSE_KIND || ev.pubkey !== uri.walletPubkey) return
    const reqId = tagValue(ev, 'e')
    const p = reqId ? pending.get(reqId) : undefined
    if (!p || !reqId) return
    pending.delete(reqId)
    clearTimeout(p.timer)
    try {
      p.resolve(JSON.parse(await nip04Decrypt(uri.secret, uri.walletPubkey, ev.content)))
    } catch (e) {
      p.reject(e as Error)
    }
  }

  async function request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sock = await connect()
    const content = await nip04Encrypt(
      uri.secret,
      uri.walletPubkey,
      JSON.stringify({ method, params }),
    )
    const ev = signEvent(uri.secret, {
      kind: NWC_REQUEST_KIND,
      content,
      tags: [['p', uri.walletPubkey]],
    })
    const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(ev.id)
        reject(new NwcError('timeout', `NWC ${method} timed out`))
      }, timeoutMs)
      pending.set(ev.id, { resolve, reject, timer })
      sock.send(JSON.stringify(['EVENT', ev]))
    })
    const err = res.error as { code?: string; message?: string } | null | undefined
    if (err) throw new NwcError(err.code ?? 'wallet', err.message ?? 'wallet error')
    return (res.result ?? {}) as Record<string, unknown>
  }

  return {
    async makeInvoice({ amountMsat, description, expirySec }) {
      const r = await request('make_invoice', {
        amount: amountMsat,
        description,
        expiry: expirySec,
      })
      const invoice = String(r.invoice ?? '')
      const paymentHash = String(r.payment_hash ?? '')
      if (!invoice || !paymentHash) throw new NwcError('wallet', 'wallet returned no invoice')
      return {
        invoice,
        paymentHash,
        expiresAt: typeof r.expires_at === 'number' ? r.expires_at : undefined,
      }
    },
    async lookupInvoice({ paymentHash }) {
      const r = await request('lookup_invoice', { payment_hash: paymentHash })
      const settledAt = typeof r.settled_at === 'number' ? r.settled_at : undefined
      const state = typeof r.state === 'string' ? r.state : undefined
      return {
        paid: !!settledAt || state === 'settled',
        preimage: typeof r.preimage === 'string' && r.preimage ? r.preimage : undefined,
        settledAt,
        expired: state === 'expired' || state === 'failed',
      }
    },
    close() {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new NwcError('closed', 'NWC client closed'))
      }
      pending.clear()
      ws?.close()
      ws = null
      ready = null
    },
  }
}
