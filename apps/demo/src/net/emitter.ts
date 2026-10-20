import type { Unsubscribe } from '../p2p'

/** Minimal typed event emitter shared by both room implementations. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>()

  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(value: T): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(value)
      } catch (err) {
        console.error(err)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

export function messageId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** Ring buffer push for the signaling log. */
export function pushCapped<T>(list: T[], item: T, max = 50): void {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
}
