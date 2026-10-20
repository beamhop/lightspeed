import type { StudioEvent } from '../room-adapter'
import { isSorted, sortEvents } from './events'
import { emptyTopology, reduceTopology, type Topology } from './topology'

/** Everything Studio shows for a point in time, derived purely from the event log. */
export interface RoomSnapshot {
  t: number
  topology: Topology
  /** Events folded so far. */
  eventCount: number
  messages: { in: number; out: number; bytes: number }
  signals: { in: number; out: number }
  /** Sessions resumed after an `away` (count of `back` transitions). */
  resumes: number
  /** Timestamp of the latest event folded in (≤ t). */
  lastEventAt: number
}

export const emptySnapshot = (): RoomSnapshot => ({
  t: 0,
  topology: emptyTopology(),
  eventCount: 0,
  messages: { in: 0, out: 0, bytes: 0 },
  signals: { in: 0, out: 0 },
  resumes: 0,
  lastEventAt: 0,
})

/** Pure reducer over the event log. */
export function reduceSnapshot(s: RoomSnapshot, e: StudioEvent): RoomSnapshot {
  const ev = e.event
  const next: RoomSnapshot = {
    ...s,
    topology: reduceTopology(s.topology, e),
    eventCount: s.eventCount + 1,
    lastEventAt: Math.max(s.lastEventAt, ev.at),
    t: Math.max(s.t, ev.at),
  }
  if (ev.type === 'message') {
    next.messages = {
      in: s.messages.in + (ev.direction === 'in' ? 1 : 0),
      out: s.messages.out + (ev.direction === 'out' ? 1 : 0),
      bytes: s.messages.bytes + ev.size,
    }
  } else if (ev.type === 'signal') {
    next.signals = {
      in: s.signals.in + (ev.direction === 'in' ? 1 : 0),
      out: s.signals.out + (ev.direction === 'out' ? 1 : 0),
    }
  } else if (ev.type === 'connection' && ev.state === 'back') {
    next.resumes = s.resumes + 1
  }
  return next
}

/**
 * Replay the log up to and including time `t`: what the room looked like at that instant.
 * Input order does not matter; events are folded in (at, seq) order.
 */
export function replayAt(events: readonly StudioEvent[], t: number): RoomSnapshot {
  const sorted = isSorted(events) ? events : sortEvents(events)
  let s = emptySnapshot()
  for (const e of sorted) {
    if (e.event.at > t) break
    s = reduceSnapshot(s, e)
  }
  s.t = t
  return s
}

// ------------------------------------------------------------------ tracks

export type Lane = 'signal' | 'connection' | 'message'

export interface TimelineItem {
  seq: number
  at: number
  lane: Lane
  source: string
  peer?: string
  label: string
  tone: 'teal' | 'violet' | 'warning' | 'danger' | 'muted' | 'success'
}

/** Map events onto the three timeline lanes; rtt/bytes/progress samples are not drawn. */
export function toTimelineItem(e: StudioEvent): TimelineItem | null {
  const ev = e.event
  const base = { seq: e.seq, at: ev.at, source: e.source }
  switch (ev.type) {
    case 'signal':
      return {
        ...base,
        lane: 'signal',
        peer: ev.peer,
        label: `${ev.direction === 'out' ? '→' : '←'} ${ev.kind}`,
        tone: 'muted',
      }
    case 'peer':
      return {
        ...base,
        lane: 'connection',
        peer: ev.peer,
        label: `peer ${ev.event}`,
        tone: ev.event === 'join' ? 'success' : 'danger',
      }
    case 'connection': {
      const tone =
        ev.state === 'connected' || ev.state === 'back'
          ? 'success'
          : ev.state === 'connecting'
            ? 'muted'
            : ev.state === 'away'
              ? 'warning'
              : 'danger'
      return { ...base, lane: 'connection', peer: ev.peer, label: ev.state, tone }
    }
    case 'path':
      return {
        ...base,
        lane: 'connection',
        peer: ev.peer,
        label: `path → ${ev.path}`,
        tone: ev.path === 'direct' ? 'teal' : ev.path === 'turn' ? 'violet' : 'warning',
      }
    case 'message':
      return {
        ...base,
        lane: 'message',
        peer: ev.peer,
        label: `${ev.direction === 'out' ? '→' : '←'} ${ev.action}`,
        tone: ev.direction === 'out' ? 'teal' : 'violet',
      }
    default:
      return null
  }
}

export interface TrackOptions {
  /** Only events reported by or about this peer. */
  peer?: string
  from?: number
  to?: number
}

export function buildTracks(
  events: readonly StudioEvent[],
  opts: TrackOptions = {},
): Record<Lane, TimelineItem[]> {
  const out: Record<Lane, TimelineItem[]> = { signal: [], connection: [], message: [] }
  for (const e of events) {
    if (opts.from !== undefined && e.event.at < opts.from) continue
    if (opts.to !== undefined && e.event.at > opts.to) continue
    const item = toTimelineItem(e)
    if (!item) continue
    if (opts.peer && item.source !== opts.peer && item.peer !== opts.peer) continue
    out[item.lane].push(item)
  }
  for (const lane of Object.keys(out) as Lane[])
    out[lane].sort((a, b) => a.at - b.at || a.seq - b.seq)
  return out
}

/** Bucket counts for a minimap/histogram of event density. */
export function histogram(
  events: readonly StudioEvent[],
  start: number,
  end: number,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0)
  const span = Math.max(1, end - start)
  for (const e of events) {
    if (e.event.at < start || e.event.at > end) continue
    const i = Math.min(buckets - 1, Math.floor(((e.event.at - start) / span) * buckets))
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}
