import type { Unsubscribe } from '../types'

/** Minimal typed listener set. Listener errors are isolated and reported via `onError`. */
export class Listeners<A extends unknown[]> {
  private set = new Set<(...args: A) => void>()

  add(cb: (...args: A) => void): Unsubscribe {
    this.set.add(cb)
    return () => {
      this.set.delete(cb)
    }
  }

  emit(...args: A): void {
    for (const cb of [...this.set]) {
      try {
        cb(...args)
      } catch (err) {
        console.error(err)
      }
    }
  }

  get size(): number {
    return this.set.size
  }

  clear(): void {
    this.set.clear()
  }
}
