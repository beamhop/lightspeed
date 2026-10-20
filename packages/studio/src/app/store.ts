// App state as signals. All derived views go through the pure reducers in ../model so the
// UI is a thin layer over testable code.
import { batch, computed, signal } from '@preact/signals'
import { BridgeRoom } from '../adapters/bridge'
import { ObserverRoom } from '../adapters/observer'
import { SimulatedRoom } from '../adapters/simulated'
import { isSorted, sortEvents, timeRange } from '../model/events'
import { emptySnapshot, type RoomSnapshot, reduceSnapshot, replayAt } from '../model/timeline'
import type {
  ActiveFault,
  AttachMode,
  Hex,
  IdentityKind,
  StudioEvent,
  StudioIdentity,
  StudioPeer,
  StudioRoom,
} from '../room-adapter'

export const MAX_EVENTS = 60_000
const FLUSH_MS = 250

export type Tab =
  | 'topology'
  | 'inspector'
  | 'timeline'
  | 'connection'
  | 'faults'
  | 'spawner'
  | 'health'
  | 'identity'

export interface SimSettings {
  seed: number
  peers: number
  topology: 'mesh' | 'star'
  speed: number
  relayFirst: boolean
  admission: 'open' | IdentityKind
}

export interface AttachSettings {
  mode: AttachMode
  sim: SimSettings
  bridgeRoom: string
  observer: { appId: string; roomId: string; relay: string }
}

const DEFAULT_SETTINGS: AttachSettings = {
  mode: 'simulated',
  sim: { seed: 7, peers: 6, topology: 'mesh', speed: 1, relayFirst: false, admission: 'open' },
  bridgeRoom: 'lobby',
  observer: { appId: 'demo', roomId: 'lobby', relay: 'ws://localhost:4848' },
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (private mode): settings just don't persist
  }
}

// ------------------------------------------------------------------ signals

export const settings = signal<AttachSettings>(load('bh-studio:attach', DEFAULT_SETTINGS))
export const room = signal<StudioRoom | null>(null)
export const attachError = signal<string | null>(null)
export const events = signal<readonly StudioEvent[]>([])
export const peers = signal<StudioPeer[]>([])
export const faults = signal<readonly ActiveFault[]>([])
export const identity = signal<StudioIdentity | null>(null)
export const tab = signal<Tab>('topology')
export const selectedPeer = signal<Hex | null>(null)
export const selectedLink = signal<{ source: Hex; peer: Hex } | null>(null)
export const serverAvailable = signal<boolean | null>(null)

/** Live = follow the newest event. Otherwise the view is frozen at `cursor`. */
export const live = signal(true)
export const cursor = signal(0)
/** Snapshot folded incrementally while live, so following the tail is O(new events). */
const liveSnapshot = signal<RoomSnapshot>(emptySnapshot())

export const sortedEvents = computed(() =>
  isSorted(events.value) ? events.value : sortEvents(events.value),
)
export const range = computed(() => timeRange(events.value))
export const viewTime = computed(() => (live.value ? (range.value?.end ?? 0) : cursor.value))
export const snapshot = computed<RoomSnapshot>(() =>
  live.value ? liveSnapshot.value : replayAt(sortedEvents.value, cursor.value),
)

export const peerNames = computed(() => {
  const m = new Map<Hex, string>()
  for (const p of peers.value) if (p.name) m.set(p.pubkey, p.name)
  return m
})

export function peerName(id: Hex | undefined): string {
  if (!id) return '—'
  return peerNames.value.get(id) ?? `${id.slice(0, 6)}…${id.slice(-4)}`
}

/** Every pubkey we know of: peer list plus anything seen in telemetry. */
export const knownPeers = computed(() => {
  const ids = new Set<Hex>(peers.value.map((p) => p.pubkey))
  for (const n of Object.keys(snapshot.value.topology.nodes)) ids.add(n)
  return [...ids].sort((a, b) => peerName(a).localeCompare(peerName(b)))
})

// ------------------------------------------------------------------ attach

let unsubscribe: (() => void) | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null
let buffer: StudioEvent[] = []

function flush(): void {
  const r = room.value
  if (!r) return
  const incoming = buffer
  buffer = []
  batch(() => {
    if (incoming.length) {
      let next = events.value.concat(incoming)
      if (next.length > MAX_EVENTS) next = next.slice(next.length - MAX_EVENTS)
      events.value = next
      let s = liveSnapshot.value
      if (isSorted(incoming) && (incoming[0]?.event.at ?? 0) >= s.lastEventAt) {
        for (const e of incoming) s = reduceSnapshot(s, e)
        liveSnapshot.value = s
      } else {
        liveSnapshot.value = replayAt(sortEvents(next), Number.POSITIVE_INFINITY)
      }
    }
    peers.value = r.peers()
    faults.value = r.faults()
  })
}

export function createRoom(s: AttachSettings): StudioRoom {
  switch (s.mode) {
    case 'bridge':
      return new BridgeRoom({ roomId: s.bridgeRoom })
    case 'observer':
      return new ObserverRoom(s.observer)
    default:
      return new SimulatedRoom({
        ...s.sim,
        roomId: `sim-${s.sim.seed}`,
        warmupMs: 8000,
      })
  }
}

export async function detach(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
  buffer = []
  const r = room.value
  room.value = null
  if (r) await r.leave().catch(() => {})
}

export async function attach(next: AttachSettings = settings.value): Promise<void> {
  await detach()
  settings.value = next
  save('bh-studio:attach', next)
  const r = createRoom(next)
  const history = [...r.history()]
  batch(() => {
    attachError.value = null
    room.value = r
    events.value = history
    liveSnapshot.value = replayAt(sortEvents(history), Number.POSITIVE_INFINITY)
    live.value = true
    cursor.value = 0
    selectedLink.value = null
    selectedPeer.value = null
    peers.value = r.peers()
    faults.value = r.faults()
  })
  unsubscribe = r.subscribe((e) => buffer.push(e))
  flushTimer = setInterval(flush, FLUSH_MS)
  try {
    await r.join()
    if (identity.value) await r.setIdentity(identity.value)
  } catch (e) {
    attachError.value = e instanceof Error ? e.message : String(e)
  }
}

/** Pin the view to a point in time (replay). */
export function scrubTo(t: number): void {
  batch(() => {
    live.value = false
    cursor.value = t
  })
}

export function goLive(): void {
  live.value = true
}

/** Force a flush now (after injecting a fault, spawning, …) so the UI updates promptly. */
export function refresh(): void {
  flush()
}

export async function checkServer(): Promise<void> {
  try {
    const res = await fetch('/api/info')
    serverAvailable.value = res.ok && (await res.json()).spawner === true
  } catch {
    serverAvailable.value = false
  }
}

export const STUDIO_HEADERS = { 'x-beamhop-studio': '1', 'Content-Type': 'application/json' }
