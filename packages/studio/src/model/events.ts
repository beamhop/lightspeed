import type { StudioEvent } from '../room-adapter'

/** Sort by telemetry time, then by sequence (stable for equal timestamps). Returns a new array. */
export function sortEvents(events: readonly StudioEvent[]): StudioEvent[] {
  return [...events].sort((a, b) => a.event.at - b.event.at || a.seq - b.seq)
}

/** True when the events are already in (at, seq) order. */
export function isSorted(events: readonly StudioEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1] as StudioEvent
    const b = events[i] as StudioEvent
    if (a.event.at > b.event.at || (a.event.at === b.event.at && a.seq > b.seq)) return false
  }
  return true
}

/** Events with `at <= t`, assuming sorted input (binary search). */
export function eventsUntil(sorted: readonly StudioEvent[], t: number): readonly StudioEvent[] {
  return sorted.slice(0, upperBound(sorted, t))
}

/** Index of the first event with `at > t`. */
export function upperBound(sorted: readonly StudioEvent[], t: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((sorted[mid] as StudioEvent).event.at <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function timeRange(events: readonly StudioEvent[]): { start: number; end: number } | null {
  if (events.length === 0) return null
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const e of events) {
    if (e.event.at < start) start = e.event.at
    if (e.event.at > end) end = e.event.at
  }
  return { start, end }
}

/** The remote peer an event is about, if any. */
export function eventPeer(e: StudioEvent): string | undefined {
  return 'peer' in e.event ? e.event.peer : undefined
}

/** Canonical undirected link key for two pubkeys. */
export function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
