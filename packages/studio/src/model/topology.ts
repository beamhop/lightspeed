import type { Connection } from '@beamhop/p2p'
import type { Hex, PathType, StudioEvent } from '../room-adapter'
import { linkKey } from './events'

export type LinkState = Connection['state'] | 'away'

export interface TopoNode {
  id: Hex
  present: boolean
  firstSeen: number
  lastSeen: number
  leftAt?: number
}

export interface LinkSide {
  state: LinkState
  path?: PathType
  rttMs?: number
  /** Cumulative counters per channel as reported by this side. */
  channels: Record<string, { sent: number; received: number }>
}

export interface TopoLink {
  key: string
  a: Hex
  b: Hex
  /** Merged view: latest reported state/path/rtt from either side. */
  state: LinkState
  path?: PathType
  rttMs?: number
  candidatePair?: string
  updatedAt: number
  /** Per reporting side (keyed by source pubkey). */
  sides: Record<Hex, LinkSide>
}

export interface Topology {
  nodes: Record<Hex, TopoNode>
  links: Record<string, TopoLink>
  /** Last event time folded in. */
  at: number
}

export const emptyTopology = (): Topology => ({ nodes: {}, links: {}, at: 0 })

function touchNode(nodes: Record<Hex, TopoNode>, id: Hex, at: number): Record<Hex, TopoNode> {
  const prev = nodes[id]
  if (prev?.present && prev.lastSeen >= at) return nodes
  const node: TopoNode = prev
    ? { ...prev, present: true, lastSeen: Math.max(prev.lastSeen, at), leftAt: undefined }
    : { id, present: true, firstSeen: at, lastSeen: at }
  return { ...nodes, [id]: node }
}

function updateLink(
  links: Record<string, TopoLink>,
  source: Hex,
  peer: Hex,
  at: number,
  fn: (link: TopoLink, side: LinkSide) => void,
): Record<string, TopoLink> {
  const key = linkKey(source, peer)
  const prev = links[key]
  const [a, b] = source < peer ? [source, peer] : [peer, source]
  const link: TopoLink = prev
    ? { ...prev, sides: { ...prev.sides } }
    : { key, a, b, state: 'connecting', updatedAt: at, sides: {} }
  const prevSide = link.sides[source]
  const side: LinkSide = prevSide
    ? { ...prevSide, channels: { ...prevSide.channels } }
    : { state: 'connecting', channels: {} }
  fn(link, side)
  link.sides[source] = side
  link.updatedAt = Math.max(link.updatedAt, at)
  return { ...links, [key]: link }
}

/**
 * Pure reducer: fold one telemetry event into the topology. Returns a new object when anything
 * changed (structural sharing for untouched nodes/links).
 */
export function reduceTopology(t: Topology, se: StudioEvent): Topology {
  const e = se.event
  const src = se.source
  let nodes = touchNode(t.nodes, src, e.at)
  let links = t.links
  switch (e.type) {
    case 'peer': {
      if (e.event === 'join') {
        nodes = touchNode(nodes, e.peer, e.at)
      } else {
        const prev = nodes[e.peer]
        nodes = {
          ...nodes,
          [e.peer]: prev
            ? { ...prev, present: false, leftAt: e.at, lastSeen: e.at }
            : { id: e.peer, present: false, firstSeen: e.at, lastSeen: e.at, leftAt: e.at },
        }
        // every link touching a departed peer is closed
        for (const [k, l] of Object.entries(links)) {
          if ((l.a === e.peer || l.b === e.peer) && l.state !== 'closed') {
            links = { ...links, [k]: { ...l, state: 'closed', updatedAt: e.at } }
          }
        }
      }
      break
    }
    case 'connection': {
      nodes = touchNode(nodes, e.peer, e.at)
      const state: LinkState =
        e.state === 'away' ? 'away' : e.state === 'back' ? 'connected' : e.state
      links = updateLink(links, src, e.peer, e.at, (link, side) => {
        side.state = state
        link.state = state
        if (e.path) {
          side.path = e.path
          link.path = e.path
        }
      })
      break
    }
    case 'path':
      nodes = touchNode(nodes, e.peer, e.at)
      links = updateLink(links, src, e.peer, e.at, (link, side) => {
        side.path = e.path
        link.path = e.path
        if (e.candidatePair) link.candidatePair = e.candidatePair
      })
      break
    case 'rtt':
      links = updateLink(links, src, e.peer, e.at, (link, side) => {
        side.rttMs = e.ms
        link.rttMs = e.ms
      })
      break
    case 'bytes':
      links = updateLink(links, src, e.peer, e.at, (_link, side) => {
        side.channels[e.channel] = { sent: e.sent, received: e.received }
      })
      break
    default:
      break
  }
  if (nodes === t.nodes && links === t.links && e.at <= t.at) return t
  return { nodes, links, at: Math.max(t.at, e.at) }
}

/** Fold a whole event log (assumed sorted) into a topology. */
export function buildTopology(events: readonly StudioEvent[]): Topology {
  let t = emptyTopology()
  for (const e of events) t = reduceTopology(t, e)
  return t
}

/** Total bytes moved over a link: the larger of the two sides' (sent + received) sums. */
export function linkBytes(link: TopoLink): { sent: number; received: number; total: number } {
  let best = { sent: 0, received: 0, total: 0 }
  for (const side of Object.values(link.sides)) {
    let sent = 0
    let received = 0
    for (const c of Object.values(side.channels)) {
      sent += c.sent
      received += c.received
    }
    if (sent + received > best.total) best = { sent, received, total: sent + received }
  }
  return best
}

/** Links that are not closed, i.e. drawn on the graph. */
export function activeLinks(t: Topology): TopoLink[] {
  return Object.values(t.links).filter(
    (l) => l.state !== 'closed' && t.nodes[l.a]?.present && t.nodes[l.b]?.present,
  )
}

export function presentNodes(t: Topology): TopoNode[] {
  return Object.values(t.nodes).filter((n) => n.present)
}

/** Count of active links by path type. */
export function pathCounts(t: Topology): Record<PathType | 'unknown', number> {
  const out: Record<PathType | 'unknown', number> = {
    direct: 0,
    turn: 0,
    relay: 0,
    memory: 0,
    unknown: 0,
  }
  for (const l of activeLinks(t)) out[l.path ?? 'unknown']++
  return out
}
