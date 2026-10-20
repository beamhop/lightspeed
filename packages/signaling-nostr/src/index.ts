// @beamhop/signaling-nostr: SignalingAdapter over ephemeral Nostr events.
import type {
  Hex,
  Identity,
  Signal,
  SignalingAdapter,
  SignalingFactory,
  SignalingStatus,
  Unsubscribe,
} from '@beamhop/p2p/types'
import { ANNOUNCE_TTL_S, KIND_ANNOUNCE, KIND_SIGNAL } from '@beamhop/p2p/wire'
import { getTag, isExpired, leadingZeroBits, type NostrEvent, nowSeconds, signEvent } from './event'
import { type Filter, RelayPool, type WebSocketCtor } from './pool'

export * from './event'
export type { WebSocketCtor, WebSocketLike } from './pool'
export { type Filter, type PublishResult, RelayPool, type RelayPoolOptions } from './pool'

/** Directed signals (offer/answer/ICE) live a little longer than announces. */
export const SIGNAL_TTL_S = 60
/** Allowed clock skew for events stamped in the future. */
export const MAX_FUTURE_SKEW_S = 30

export interface NostrSignalingOptions {
  /** Relay URLs (wss://...). Every event goes to all of them; receipt is deduped. */
  relays: string[]
  /** NIP-13 proof of work to attach to outgoing events (leading zero bits). Default 0. */
  powBits?: number
  /** Answer NIP-42 AUTH challenges with the room identity. Default true. */
  auth?: boolean
  /** Drop incoming events with less PoW than this. Default 0. */
  minPowBits?: number
  /** WebSocket constructor override (defaults to globalThis.WebSocket). */
  WebSocket?: WebSocketCtor
  /** Reconnect backoff bounds in ms. Defaults 500 / 30000. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Per-relay OK timeout in ms. Default 10000. */
  publishTimeoutMs?: number
}

export function nostrSignaling(options: NostrSignalingOptions): SignalingFactory {
  if (!options.relays?.length) throw new Error('nostrSignaling: at least one relay is required')
  return ({ identity }) => new NostrSignalingAdapter(identity, options)
}

export class NostrSignalingAdapter implements SignalingAdapter {
  readonly pool: RelayPool
  private readonly powBits: number
  private readonly minPowBits: number

  constructor(
    private readonly identity: Identity,
    options: NostrSignalingOptions,
  ) {
    this.powBits = options.powBits ?? 0
    this.minPowBits = options.minPowBits ?? 0
    const poolOpts: ConstructorParameters<typeof RelayPool>[1] = {}
    if (options.auth !== false) poolOpts.auth = identity
    if (options.WebSocket) poolOpts.WebSocket = options.WebSocket
    if (options.minBackoffMs !== undefined) poolOpts.minBackoffMs = options.minBackoffMs
    if (options.maxBackoffMs !== undefined) poolOpts.maxBackoffMs = options.maxBackoffMs
    if (options.publishTimeoutMs !== undefined) poolOpts.publishTimeoutMs = options.publishTimeoutMs
    this.pool = new RelayPool(options.relays, poolOpts)
  }

  async announce(topic: Hex, content: string): Promise<void> {
    const now = nowSeconds()
    const event = await signEvent(
      {
        kind: KIND_ANNOUNCE,
        created_at: now,
        tags: [
          ['t', topic],
          ['expiration', String(now + ANNOUNCE_TTL_S)],
        ],
        content,
      },
      this.identity,
      this.powBits,
    )
    await this.pool.publishAny(event)
  }

  async send(topic: Hex, to: Hex, content: string): Promise<void> {
    const now = nowSeconds()
    const event = await signEvent(
      {
        kind: KIND_SIGNAL,
        created_at: now,
        tags: [
          ['t', topic],
          ['p', to],
          ['expiration', String(now + SIGNAL_TTL_S)],
        ],
        content,
      },
      this.identity,
      this.powBits,
    )
    await this.pool.publishAny(event)
  }

  subscribe(topic: Hex, onSignal: (signal: Signal) => void): Unsubscribe {
    const me = this.identity.pubkey
    const filters = (): Filter[] => {
      const now = nowSeconds()
      return [
        { kinds: [KIND_ANNOUNCE], '#t': [topic], since: now - ANNOUNCE_TTL_S },
        { kinds: [KIND_SIGNAL], '#t': [topic], '#p': [me], since: now - SIGNAL_TTL_S },
      ]
    }
    return this.pool.subscribe(filters, (event) => {
      const signal = this.accept(event, topic)
      if (signal) onSignal(signal)
    })
  }

  /** Relay-independent checks: kind, tags, freshness, expiry, PoW, own echo. */
  private accept(event: NostrEvent, topic: Hex): Signal | null {
    if (event.pubkey === this.identity.pubkey) return null
    if (getTag(event, 't') !== topic) return null
    const now = nowSeconds()
    if (event.created_at > now + MAX_FUTURE_SKEW_S) return null
    if (isExpired(event, now)) return null
    if (this.minPowBits > 0 && leadingZeroBits(event.id) < this.minPowBits) return null
    if (event.kind === KIND_ANNOUNCE) {
      if (event.created_at < now - ANNOUNCE_TTL_S) return null
      return {
        kind: 'announce',
        from: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
      }
    }
    if (event.kind === KIND_SIGNAL) {
      if (!event.tags.some((t) => t[0] === 'p' && t[1] === this.identity.pubkey)) return null
      if (event.created_at < now - SIGNAL_TTL_S) return null
      return {
        kind: 'direct',
        from: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
      }
    }
    return null
  }

  status(): SignalingStatus[] {
    return this.pool.status()
  }

  async close(): Promise<void> {
    this.pool.close()
  }
}
