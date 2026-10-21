import type { ChatMessage, Unsubscribe } from '../p2p'

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

/** How many chat messages a room keeps and hands to late joiners. */
export const CHAT_HISTORY = 200

/**
 * Chat history shared by both room implementations: dedups by id (live messages and history from
 * several peers overlap) and keeps messages ordered by send time.
 */
export class ChatLog {
  private list: ChatMessage[] = []
  private ids = new Set<string>()

  constructor(private readonly max = CHAT_HISTORY) {}

  /** Returns false for a message already in the log. */
  add(m: ChatMessage): boolean {
    if (this.ids.has(m.id)) return false
    this.ids.add(m.id)
    let i = this.list.length
    while (i > 0 && (this.list[i - 1]?.at ?? 0) > m.at) i--
    this.list.splice(i, 0, m)
    while (this.list.length > this.max) {
      const old = this.list.shift()
      if (old) this.ids.delete(old.id)
    }
    return true
  }

  all(): ChatMessage[] {
    return [...this.list]
  }
}
