/** Time source used by rooms, the memory hub and signaling. Swappable for a virtual clock in simulations. */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // Never keep a Bun/Node process alive just for library housekeeping timers.
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

interface VTimer {
  id: number
  at: number
  seq: number
  fn: () => void
}

const flush = () => new Promise<void>((r) => setImmediate(r))

/**
 * Deterministic virtual clock. Timers only fire when the test advances time; between timers all pending
 * microtasks are flushed, so async code that does no real I/O runs in a reproducible order.
 */
export class VirtualClock implements Clock {
  private t: number
  private seq = 0
  private timers: VTimer[] = []

  constructor(start = 1_700_000_000_000) {
    this.t = start
  }

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: VTimer = { id: ++this.seq, at: this.t + Math.max(0, ms), seq: this.seq, fn }
    // Keep sorted by (at, seq); insertion from the back is cheap for the common near-future case.
    let i = this.timers.length
    while (i > 0) {
      const prev = this.timers[i - 1] as VTimer
      if (prev.at < timer.at || (prev.at === timer.at && prev.seq < timer.seq)) break
      i--
    }
    this.timers.splice(i, 0, timer)
    return timer.id
  }

  clearTimeout(handle: unknown): void {
    const i = this.timers.findIndex((t) => t.id === handle)
    if (i >= 0) this.timers.splice(i, 1)
  }

  get pending(): number {
    return this.timers.length
  }

  /** Advance virtual time by `ms`, firing every timer due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms
    await flush()
    for (;;) {
      const next = this.timers[0]
      if (!next || next.at > target) break
      this.timers.shift()
      this.t = Math.max(this.t, next.at)
      try {
        next.fn()
      } catch (err) {
        console.error(err)
      }
      await flush()
    }
    this.t = target
    await flush()
  }

  /** Advance in steps until `pred()` holds; throws after `maxMs` of virtual time. */
  async until(pred: () => boolean, maxMs = 60_000, stepMs = 10): Promise<number> {
    const start = this.t
    while (!pred()) {
      if (this.t - start > maxMs) throw new Error(`condition not met within ${maxMs} virtual ms`)
      await this.advance(stepMs)
    }
    return this.t - start
  }
}

/** Seeded PRNG (mulberry32). Deterministic across runtimes. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((r) => clock.setTimeout(r, ms))
}
