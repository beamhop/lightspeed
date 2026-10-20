// Minimal in-process Nostr relay for tests (Bun.serve on port 0). Not shipped.
import type { Identity } from '@beamhop/p2p/types'
import { schnorr } from '@noble/curves/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import type { ServerWebSocket } from 'bun'
import { getTag, type NostrEvent, verifyEvent } from './event'
import type { Filter } from './pool'

interface Sock {
  subs: Map<string, Filter[]>
  challenge: string
  authed: string | null
}

export interface FakeRelayOptions {
  port?: number
  /** Send an AUTH challenge on connect and require AUTH for EVENT/REQ. */
  requireAuth?: boolean
  /** Reject the first N events with `rate-limited:`. */
  rateLimitFirst?: number
}

export function matches(f: Filter, e: NostrEvent): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.since !== undefined && e.created_at < f.since) return false
  if (f.until !== undefined && e.created_at > f.until) return false
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue
    const name = k.slice(1)
    if (!e.tags.some((t) => t[0] === name && v.includes(t[1] as string))) return false
  }
  return true
}

export class FakeRelay {
  server: ReturnType<typeof Bun.serve> | undefined
  port = 0
  readonly sockets = new Set<ServerWebSocket<Sock>>()
  readonly received: NostrEvent[] = []
  readonly authedPubkeys: string[] = []
  private rateLimitLeft: number

  constructor(private readonly opts: FakeRelayOptions = {}) {
    this.rateLimitLeft = opts.rateLimitFirst ?? 0
    this.start(opts.port ?? 0)
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  start(port = this.port): void {
    const self = this
    this.server = Bun.serve<Sock>({
      port,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const data: Sock = {
          subs: new Map(),
          challenge: crypto.randomUUID(),
          authed: null,
        }
        if (server.upgrade(req, { data })) return undefined
        return new Response('nostr relay', { status: 200 })
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws)
          if (self.opts.requireAuth) ws.send(JSON.stringify(['AUTH', ws.data.challenge]))
        },
        close(ws) {
          self.sockets.delete(ws)
        },
        message(ws, raw) {
          self.onMessage(ws, String(raw))
        },
      },
    })
    this.port = this.server.port as number
  }

  stop(): void {
    for (const ws of this.sockets) ws.close(1001, 'restart')
    this.sockets.clear()
    this.server?.stop(true)
    this.server = undefined
  }

  /** Push an arbitrary (possibly invalid) event to every matching subscription. */
  inject(event: NostrEvent): void {
    for (const ws of this.sockets) {
      for (const [id, filters] of ws.data.subs) {
        if (filters.some((f) => matches(f, event))) ws.send(JSON.stringify(['EVENT', id, event]))
      }
    }
  }

  private onMessage(ws: ServerWebSocket<Sock>, raw: string): void {
    const msg = JSON.parse(raw) as unknown[]
    const send = (m: unknown[]) => ws.send(JSON.stringify(m))
    switch (msg[0]) {
      case 'AUTH': {
        const e = msg[1] as NostrEvent
        const ok =
          verifyEvent(e) &&
          e.kind === 22242 &&
          getTag(e, 'challenge') === ws.data.challenge &&
          getTag(e, 'relay') !== undefined
        if (ok) {
          ws.data.authed = e.pubkey
          this.authedPubkeys.push(e.pubkey)
        }
        send(['OK', e.id, ok, ok ? '' : 'invalid: bad auth'])
        return
      }
      case 'REQ': {
        const id = msg[1] as string
        if (this.opts.requireAuth && !ws.data.authed) {
          send(['CLOSED', id, 'auth-required: please authenticate'])
          return
        }
        ws.data.subs.set(id, msg.slice(2) as Filter[])
        send(['EOSE', id])
        return
      }
      case 'CLOSE': {
        ws.data.subs.delete(msg[1] as string)
        return
      }
      case 'EVENT': {
        const e = msg[1] as NostrEvent
        if (this.opts.requireAuth && !ws.data.authed) {
          send(['OK', e.id, false, 'auth-required: please authenticate'])
          return
        }
        if (this.rateLimitLeft > 0) {
          this.rateLimitLeft--
          send(['OK', e.id, false, 'rate-limited: slow down'])
          return
        }
        if (!verifyEvent(e as unknown)) {
          send(['OK', e.id, false, 'invalid: bad signature'])
          return
        }
        this.received.push(e)
        send(['OK', e.id, true, ''])
        this.inject(e)
        return
      }
    }
  }
}

export function testIdentity(): Identity & { secret: Uint8Array } {
  const secret = schnorr.utils.randomPrivateKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(secret))
  const no = async (): Promise<never> => {
    throw new Error('not implemented in test identity')
  }
  return {
    secret,
    pubkey,
    attestations: [{ type: 'anonymous' }],
    sign: async (hash) => schnorr.sign(hash, secret),
    encrypt: no,
    decrypt: no,
    conversationKey: no,
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, label = 'condition') {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
