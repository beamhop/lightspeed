// Worker thread entry for signature verification. Messages: { n, event } -> { n, ok }.
import { verifyEvent } from './event'
import type { NostrEvent } from './types'

declare const self: Worker

self.onmessage = (msg: MessageEvent<{ n: number; event: NostrEvent }>) => {
  self.postMessage({ n: msg.data.n, ok: verifyEvent(msg.data.event) })
}
