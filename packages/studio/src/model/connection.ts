import type { Hex, PathType, StudioEvent } from '../room-adapter'
import type { LinkState } from './topology'

export interface StateTransition {
  at: number
  from: LinkState | 'new'
  to: LinkState
  /** Raw telemetry state ('away'/'back' are kept distinct here). */
  raw: string
  path?: PathType
}

export interface PathChange {
  at: number
  path: PathType
  candidatePair?: string
}

export interface ResumeEntry {
  awayAt: number
  backAt?: number
  gapMs?: number
}

export interface ConnectionHistory {
  source: Hex
  peer: Hex
  transitions: StateTransition[]
  paths: PathChange[]
  resumes: ResumeEntry[]
  channels: Record<string, { sent: number; received: number; at: number }>
  rtt: { at: number; ms: number }[]
  messages: { in: number; out: number }
  current: LinkState | 'new'
}

/**
 * The state machine history of one side of a connection (`source` looking at `peer`),
 * folded from telemetry up to `until`.
 */
export function connectionHistory(
  events: readonly StudioEvent[],
  source: Hex,
  peer: Hex,
  until = Number.POSITIVE_INFINITY,
): ConnectionHistory {
  const h: ConnectionHistory = {
    source,
    peer,
    transitions: [],
    paths: [],
    resumes: [],
    channels: {},
    rtt: [],
    messages: { in: 0, out: 0 },
    current: 'new',
  }
  for (const se of events) {
    if (se.source !== source) continue
    const e = se.event
    if (e.at > until) continue
    if (!('peer' in e) || e.peer !== peer) continue
    switch (e.type) {
      case 'connection': {
        const to: LinkState =
          e.state === 'away' ? 'away' : e.state === 'back' ? 'connected' : e.state
        h.transitions.push({ at: e.at, from: h.current, to, raw: e.state, path: e.path })
        h.current = to
        if (e.path) h.paths.push({ at: e.at, path: e.path })
        if (e.state === 'away') h.resumes.push({ awayAt: e.at })
        if (e.state === 'back') {
          const open = [...h.resumes].reverse().find((r) => r.backAt === undefined)
          if (open) {
            open.backAt = e.at
            open.gapMs = e.at - open.awayAt
          }
        }
        break
      }
      case 'path':
        h.paths.push({ at: e.at, path: e.path, candidatePair: e.candidatePair })
        break
      case 'bytes':
        h.channels[e.channel] = { sent: e.sent, received: e.received, at: e.at }
        break
      case 'rtt':
        h.rtt.push({ at: e.at, ms: e.ms })
        break
      case 'message':
        h.messages[e.direction]++
        break
      case 'peer':
        if (e.event === 'leave') {
          h.transitions.push({ at: e.at, from: h.current, to: 'closed', raw: 'leave' })
          h.current = 'closed'
        }
        break
      default:
        break
    }
  }
  return h
}

/** Distinct (source, peer) pairs that have connection telemetry. */
export function connectionPairs(events: readonly StudioEvent[]): { source: Hex; peer: Hex }[] {
  const seen = new Set<string>()
  const out: { source: Hex; peer: Hex }[] = []
  for (const se of events) {
    const e = se.event
    if (e.type !== 'connection' && e.type !== 'path') continue
    const k = `${se.source}>${e.peer}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ source: se.source, peer: e.peer })
  }
  return out
}
