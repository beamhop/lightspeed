// The single live stats stream: WebSocket /api/admin/stats -> signals, with reconnect + backoff.

import { computed, type ReadonlySignal, signal } from '@preact/signals-core'
import type { StatsMessage } from './types'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Minimal WebSocket surface so tests and the mock can inject a fake. */
export interface WsLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(code?: number, reason?: string): void
}

export type WsFactory = (url: string) => WsLike

export interface StatsStreamOptions {
  url: string
  createSocket?: WsFactory
  historySize?: number
  minBackoffMs?: number
  maxBackoffMs?: number
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  /** Pre-filled history (the mock uses it so charts are not empty on first paint). */
  initialHistory?: StatsMessage[]
}

/** Exponential backoff with +-20% jitter, capped. attempt starts at 1. */
export function backoffDelay(
  attempt: number,
  min = 500,
  max = 15000,
  random = Math.random,
): number {
  const base = Math.min(max, min * 2 ** Math.max(0, attempt - 1))
  const jitter = base * 0.2 * (random() * 2 - 1)
  return Math.round(Math.min(max, Math.max(min, base + jitter)))
}

export function normalizeStats(raw: unknown): StatsMessage | null {
  if (!raw || typeof raw !== 'object') return null
  // biome-ignore lint/suspicious/noExplicitAny: untrusted wire frame, every field is checked below
  const m = raw as Record<string, any>
  if (m.type !== 'stats') return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const msg: StatsMessage = {
    type: 'stats',
    ts: n(m.ts) || Date.now(),
    nostr: {
      events: n(m.nostr?.events),
      subscriptions: n(m.nostr?.subscriptions),
      clients: n(m.nostr?.clients),
      eventsPerSec: n(m.nostr?.eventsPerSec),
    },
    turn: {
      allocations: n(m.turn?.allocations),
      bytesIn: n(m.turn?.bytesIn),
      bytesOut: n(m.turn?.bytesOut),
      bps: n(m.turn?.bps),
    },
  }
  if (m.disk) msg.disk = { usedBytes: n(m.disk.usedBytes), totalBytes: n(m.disk.totalBytes) }
  if (m.uptimeSec != null) msg.uptimeSec = n(m.uptimeSec)
  if (m.alerts != null) msg.alerts = n(m.alerts)
  return msg
}

export interface StatsStream {
  status: ReadonlySignal<StreamStatus>
  latest: ReadonlySignal<StatsMessage | null>
  history: ReadonlySignal<StatsMessage[]>
  attempts: ReadonlySignal<number>
  /** Column-major series for uPlot: [ts(s), eventsPerSec, Mbps, allocations, clients]. */
  series: ReadonlySignal<[number[], number[], number[], number[], number[]]>
  start(): void
  stop(): void
}

export function createStatsStream(opts: StatsStreamOptions): StatsStream {
  const status = signal<StreamStatus>('idle')
  const latest = signal<StatsMessage | null>(null)
  const history = signal<StatsMessage[]>(opts.initialHistory ?? [])
  const attempts = signal(0)
  const size = opts.historySize ?? 300
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const factory: WsFactory = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WsLike)
  let ws: WsLike | null = null
  let timer: unknown = null
  let wanted = false

  const connect = () => {
    if (!wanted) return
    status.value = attempts.value === 0 ? 'connecting' : 'reconnecting'
    let sock: WsLike
    try {
      sock = factory(opts.url)
    } catch {
      schedule()
      return
    }
    ws = sock
    sock.onopen = () => {
      if (ws !== sock) return
      attempts.value = 0
      status.value = 'open'
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      let parsed: unknown
      try {
        parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
      } catch {
        return
      }
      const msg = normalizeStats(parsed)
      if (!msg) return
      latest.value = msg
      const h = history.value
      history.value = h.length >= size ? [...h.slice(h.length - size + 1), msg] : [...h, msg]
    }
    sock.onerror = () => {}
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      if (wanted) schedule()
      else status.value = 'closed'
    }
  }

  const schedule = () => {
    attempts.value += 1
    status.value = 'reconnecting'
    const delay = backoffDelay(attempts.value, opts.minBackoffMs, opts.maxBackoffMs, opts.random)
    timer = setTimer(() => {
      timer = null
      connect()
    }, delay)
  }

  const series = computed(() => {
    const h = history.value
    return [
      h.map((m) => m.ts / 1000),
      h.map((m) => m.nostr.eventsPerSec),
      h.map((m) => m.turn.bps / 1e6),
      h.map((m) => m.turn.allocations),
      h.map((m) => m.nostr.clients),
    ] as [number[], number[], number[], number[], number[]]
  })

  return {
    status,
    latest,
    history,
    attempts,
    series,
    start() {
      if (wanted) return
      wanted = true
      attempts.value = 0
      connect()
    },
    stop() {
      wanted = false
      if (timer) clearTimer(timer)
      timer = null
      const s = ws
      ws = null
      s?.close(1000, 'stop')
      status.value = 'closed'
    },
  }
}

/** ws(s)://host/api/admin/stats derived from the page location. */
export function statsUrl(
  loc: { protocol: string; host: string },
  path = '/api/admin/stats',
): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`
}
