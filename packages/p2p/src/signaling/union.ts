import type { Signal, SignalingAdapter, SignalingFactory, SignalingStatus } from '../types'

/**
 * Fan out to several signaling adapters for redundancy. Sends succeed if any adapter succeeds; received
 * signals are de-duplicated (same sender, kind and content) so the room sees each signal once.
 */
export function unionSignaling(...factories: (SignalingFactory | SignalingFactory[])[]): SignalingFactory {
  const flat = factories.flat()
  return (ctx) => {
    const adapters = flat.map((f) => f(ctx))
    return unionAdapters(adapters)
  }
}

export function unionAdapters(adapters: SignalingAdapter[], dedupeWindow = 2048): SignalingAdapter {
  const any = async (fn: (a: SignalingAdapter) => Promise<void>) => {
    if (adapters.length === 0) throw new Error('unionSignaling: no adapters')
    const results = await Promise.allSettled(adapters.map(fn))
    if (results.every((r) => r.status === 'rejected')) {
      throw new AggregateError(
        results.map((r) => (r as PromiseRejectedResult).reason),
        'all signaling adapters failed',
      )
    }
  }
  return {
    announce: (topic, content) => any((a) => a.announce(topic, content)),
    send: (topic, to, content) => any((a) => a.send(topic, to, content)),
    subscribe(topic, onSignal) {
      const seen = new Set<string>()
      const order: string[] = []
      const handle = (s: Signal) => {
        const key = `${s.kind}|${s.from}|${s.content}`
        if (seen.has(key)) return
        seen.add(key)
        order.push(key)
        if (order.length > dedupeWindow) seen.delete(order.shift() as string)
        onSignal(s)
      }
      const unsubs = adapters.map((a) => a.subscribe(topic, handle))
      return () => {
        for (const u of unsubs) u()
      }
    },
    status(): SignalingStatus[] {
      return adapters.flatMap((a) => a.status?.() ?? [])
    },
    async close() {
      await Promise.allSettled(adapters.map((a) => a.close()))
    },
  }
}
