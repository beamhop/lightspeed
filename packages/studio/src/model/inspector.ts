import type { TelemetryEvent } from '@beamhop/p2p'
import type { StudioEvent } from '../room-adapter'

export type MessageEvent = Extract<TelemetryEvent, { type: 'message' }>
export type MessageRecord = StudioEvent & { event: MessageEvent }

export interface MessageFilter {
  /** Matches when the peer is either the reporting side or the remote side. */
  peer?: string
  action?: string
  direction?: 'in' | 'out'
  /** Case-insensitive substring over action and the JSON payload. */
  text?: string
  /** Inclusive upper time bound (replay cursor). */
  until?: number
}

export function isMessage(e: StudioEvent): e is MessageRecord {
  return e.event.type === 'message'
}

export function filterMessages(
  events: readonly StudioEvent[],
  filter: MessageFilter = {},
): MessageRecord[] {
  const text = filter.text?.trim().toLowerCase()
  const out: MessageRecord[] = []
  for (const e of events) {
    if (!isMessage(e)) continue
    const m = e.event
    if (filter.until !== undefined && m.at > filter.until) continue
    if (filter.peer && e.source !== filter.peer && m.peer !== filter.peer) continue
    if (filter.action && m.action !== filter.action) continue
    if (filter.direction && m.direction !== filter.direction) continue
    if (text) {
      const hay = `${m.action} ${safeStringify(m.payload)}`.toLowerCase()
      if (!hay.includes(text)) continue
    }
    out.push(e)
  }
  return out
}

/** Distinct actions seen, sorted, with counts. */
export function actionCounts(events: readonly StudioEvent[]): { action: string; count: number }[] {
  const m = new Map<string, number>()
  for (const e of events) if (isMessage(e)) m.set(e.event.action, (m.get(e.event.action) ?? 0) + 1)
  return [...m.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => a.action.localeCompare(b.action))
}

function toHex(bytes: Uint8Array, max = 64): string {
  let s = ''
  for (let i = 0; i < Math.min(bytes.length, max); i++)
    s += (bytes[i] as number).toString(16).padStart(2, '0')
  return bytes.length > max ? `${s}…` : s
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Uint8Array) return { $bytes: value.length, hex: toHex(value) }
  if (value instanceof ArrayBuffer)
    return { $bytes: value.byteLength, hex: toHex(new Uint8Array(value)) }
  if (value instanceof Map) return { $map: Object.fromEntries(value) }
  if (value instanceof Set) return { $set: [...value] }
  if (value instanceof Error) return { $error: value.message }
  return value
}

/** JSON for display: handles bytes, bigint, maps, sets and cycles; never throws. */
export function safeStringify(value: unknown, indent?: number): string {
  if (value === undefined) return ''
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (k, v) => {
        const r = replacer(k, v)
        if (r && typeof r === 'object') {
          if (seen.has(r)) return '[Circular]'
          seen.add(r)
        }
        return r
      },
      indent,
    )
  } catch {
    return String(value)
  }
}

/** Pretty-printed payload for the inspector's detail pane. */
export function decodePayload(payload: unknown): string {
  if (payload === undefined) return '(no payload captured)'
  return safeStringify(payload, 2)
}
