import type { Policy, PolicyProvider, RateLimit } from './types'

/** Allow-all provider. */
export const allowAll: PolicyProvider = { get: () => ({}) }

/** Provider over fixed data: `global` for the public relay, `realms[id]` per realm (falls back to `realmDefault`). */
export function staticPolicy(opts: {
  global?: Policy
  realms?: Record<string, Policy>
  realmDefault?: Policy
}): PolicyProvider {
  return {
    get: (realm) =>
      realm === null ? (opts.global ?? {}) : (opts.realms?.[realm] ?? opts.realmDefault ?? {}),
  }
}

/** Mutable provider for hot-swapping policies at runtime (e.g. when an admin saves a rule). */
export function createPolicyStore(initial?: {
  global?: Policy
  realms?: Record<string, Policy>
  realmDefault?: Policy
}): PolicyProvider & {
  set(realm: string | null, policy: Policy): void
  delete(realm: string): void
  setRealmDefault(policy: Policy): void
} {
  let global = initial?.global ?? {}
  let realmDefault = initial?.realmDefault ?? {}
  const realms = new Map(Object.entries(initial?.realms ?? {}))
  return {
    get: (realm) => (realm === null ? global : (realms.get(realm) ?? realmDefault)),
    set(realm, policy) {
      if (realm === null) global = policy
      else realms.set(realm, policy)
    },
    delete(realm) {
      realms.delete(realm)
    },
    setRealmDefault(policy) {
      realmDefault = policy
    },
  }
}

/** Token buckets keyed by string, with lazy refill and periodic pruning. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()

  /** Takes one token; returns false when the bucket is empty. */
  take(key: string, limit: RateLimit, now = performance.now()): boolean {
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: limit.burst, at: now }
      this.buckets.set(key, b)
    } else {
      b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / 1000) * limit.rate)
      b.at = now
    }
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  /** Drop buckets idle long enough to be full again. */
  prune(now = performance.now(), idleMs = 60_000) {
    for (const [k, b] of this.buckets) if (now - b.at > idleMs) this.buckets.delete(k)
  }

  get size() {
    return this.buckets.size
  }
}
