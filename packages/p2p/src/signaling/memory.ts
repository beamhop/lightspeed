import type { Hex, Signal, SignalingAdapter, SignalingFactory, SignalingStatus, Unsubscribe } from '../types'
import { type Clock, realClock } from '../util/clock'

interface Sub {
  pubkey: Hex
  cb: (s: Signal) => void
}

export interface SignalingHubOptions {
  clock?: Clock
  /** One-way delivery delay in ms (default 0, still asynchronous). */
  latencyMs?: number
}

/** In-process stand-in for a Nostr relay: topic fan-out plus pubkey-addressed delivery. */
export class SignalingHub {
  readonly clock: Clock
  latencyMs: number
  private topics = new Map<Hex, Set<Sub>>()
  private down = new Set<Hex>()
  /** Total signals routed, for tests and Studio. */
  counts = { announce: 0, direct: 0 }

  constructor(opts: SignalingHubOptions = {}) {
    this.clock = opts.clock ?? realClock
    this.latencyMs = opts.latencyMs ?? 0
  }

  /** Take a peer's signaling offline (it neither sends nor receives) until `restore`. */
  disconnect(pubkey: Hex): void {
    this.down.add(pubkey)
  }

  restore(pubkey: Hex): void {
    this.down.delete(pubkey)
  }

  isDown(pubkey: Hex): boolean {
    return this.down.has(pubkey)
  }

  subscribe(topic: Hex, sub: Sub): Unsubscribe {
    let set = this.topics.get(topic)
    if (!set) {
      set = new Set()
      this.topics.set(topic, set)
    }
    set.add(sub)
    return () => {
      set.delete(sub)
      if (set.size === 0) this.topics.delete(topic)
    }
  }

  publish(topic: Hex, from: Hex, kind: Signal['kind'], content: string, to?: Hex): void {
    if (this.down.has(from)) return
    this.counts[kind]++
    const signal: Signal = { kind, from, content, createdAt: Math.floor(this.clock.now() / 1000) }
    for (const sub of [...(this.topics.get(topic) ?? [])]) {
      if (sub.pubkey === from) continue
      if (to && sub.pubkey !== to) continue
      this.clock.setTimeout(() => {
        if (this.down.has(sub.pubkey)) return
        if (!this.topics.get(topic)?.has(sub)) return
        sub.cb(signal)
      }, this.latencyMs)
    }
  }
}

export function createSignalingHub(opts?: SignalingHubOptions): SignalingHub {
  return new SignalingHub(opts)
}

/** Signaling over an in-process hub (tests, simulator, Studio sandboxes). */
export function memorySignaling(hub: SignalingHub): SignalingFactory {
  return ({ identity }) => {
    const unsubs = new Set<Unsubscribe>()
    let closed = false
    const adapter: SignalingAdapter = {
      async announce(topic, content) {
        if (!closed) hub.publish(topic, identity.pubkey, 'announce', content)
      },
      async send(topic, to, content) {
        if (!closed) hub.publish(topic, identity.pubkey, 'direct', content, to)
      },
      subscribe(topic, onSignal) {
        const u = hub.subscribe(topic, { pubkey: identity.pubkey, cb: onSignal })
        unsubs.add(u)
        return () => {
          u()
          unsubs.delete(u)
        }
      },
      status(): SignalingStatus[] {
        return [{ url: 'memory://hub', state: closed ? 'closed' : hub.isDown(identity.pubkey) ? 'error' : 'open' }]
      },
      async close() {
        closed = true
        for (const u of unsubs) u()
        unsubs.clear()
      },
    }
    return adapter
  }
}
