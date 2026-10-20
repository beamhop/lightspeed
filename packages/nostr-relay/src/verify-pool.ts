import { verifyEvent } from './event'
import type { NostrEvent } from './types'

export interface Verifier {
  verify(e: NostrEvent): Promise<boolean>
  close(): void
}

/** Inline verification on the main thread. */
export const inlineVerifier: Verifier = {
  verify: (e) => Promise.resolve(verifyEvent(e)),
  close() {},
}

/** Round-robin pool of Bun Workers running `verify-worker.ts`. */
export function createVerifyPool(size: number): Verifier {
  if (size <= 0) return inlineVerifier
  const pending = new Map<number, (ok: boolean) => void>()
  let seq = 0
  let next = 0
  const workers: Worker[] = []
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./verify-worker.ts', import.meta.url).href)
    w.onmessage = (msg: MessageEvent<{ n: number; ok: boolean }>) => {
      const cb = pending.get(msg.data.n)
      if (cb) {
        pending.delete(msg.data.n)
        cb(msg.data.ok)
      }
    }
    ;(w as unknown as { unref?: () => void }).unref?.()
    workers.push(w)
  }
  return {
    verify(e) {
      const n = ++seq
      const w = workers[next++ % workers.length] as Worker
      return new Promise((resolve) => {
        pending.set(n, resolve)
        w.postMessage({ n, event: e })
      })
    },
    close() {
      for (const w of workers) w.terminate()
      for (const cb of pending.values()) cb(false)
      pending.clear()
    },
  }
}
