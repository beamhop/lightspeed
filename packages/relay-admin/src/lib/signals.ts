// React binding for the DOM-free signals in store.ts, router.ts and stats.ts.

import type { ReadonlySignal } from '@preact/signals-core'
import { useSyncExternalStore } from 'react'

/** Read a signal in render and re-render when it changes. */
export function useValue<T>(s: ReadonlySignal<T>): T {
  return useSyncExternalStore(
    (cb) => s.subscribe(() => cb()),
    () => s.peek(),
    () => s.peek(),
  )
}
