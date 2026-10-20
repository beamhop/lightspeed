// Demo defaults: public Nostr relays for signaling and public STUN for ICE. No TURN, no data relay,
// so a symmetric-NAT pair can fail here; the debug drawer explains why and offers "use your own relay".

export const APP_ID = 'beamhop-demo'

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

export interface DemoConfig {
  roomId: string
  password: string
  name: string
  /** Force the BroadcastChannel fallback (`?local=1`). */
  local: boolean
  identity: 'anonymous' | 'nostr'
  relays: string[]
  iceServers: RTCIceServer[]
  /** "Use your own relay": base https/wss URL of a Beamhop relay, plus the app id on it. */
  ownRelay?: { url: string; appId: string; apiKey?: string } | undefined
}

const ADJECTIVES = ['swift', 'quiet', 'bright', 'lucky', 'brave', 'cosmic', 'gentle', 'nimble']
const ANIMALS = ['bunny', 'otter', 'lynx', 'heron', 'fox', 'panda', 'koala', 'gecko']

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T
}

export function randomName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`
}

export function randomRoomId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 10)
}

/** Stable per-peer color derived from its id. */
export function colorFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 80% 70%)`
}

/** Normalize "relay.example.com", "https://..." or "wss://..." to a wss:// base without trailing slash. */
export function normalizeRelayUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `wss://${s}`)
    if (u.protocol === 'https:') u.protocol = 'wss:'
    if (u.protocol === 'http:') u.protocol = 'ws:'
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function readConfig(search: string, stored: Partial<DemoConfig> = {}): DemoConfig {
  const q = new URLSearchParams(search)
  const relayParam = q.get('relays')
  const relays = relayParam
    ? relayParam
        .split(',')
        .map(normalizeRelayUrl)
        .filter((r): r is string => !!r)
    : (stored.relays ?? DEFAULT_RELAYS)
  return {
    roomId: q.get('room') ?? '',
    password: q.get('pw') ?? '',
    name: q.get('name') ?? stored.name ?? randomName(),
    local: q.get('local') === '1',
    identity: q.get('id') === 'nostr' ? 'nostr' : (stored.identity ?? 'anonymous'),
    relays: relays.length ? relays : DEFAULT_RELAYS,
    iceServers: DEFAULT_ICE_SERVERS,
    ownRelay: stored.ownRelay,
  }
}

/** Parses a pasted room link (or bare id) into room/password. */
export function parseRoomInput(input: string): { roomId: string; password?: string } | null {
  const s = input.trim()
  if (!s) return null
  if (/^[a-z]+:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      const roomId = u.searchParams.get('room')
      if (!roomId) return null
      const pw = u.searchParams.get('pw')
      return pw ? { roomId, password: pw } : { roomId }
    } catch {
      return null
    }
  }
  return /^[\w-]{1,64}$/.test(s) ? { roomId: s } : null
}

/** Shareable link for a room; keeps `local=1` so tab-local demos stay local. */
export function roomLink(
  base: string,
  cfg: Pick<DemoConfig, 'roomId' | 'password' | 'local'>,
): string {
  const u = new URL(base)
  u.search = ''
  u.hash = ''
  u.searchParams.set('room', cfg.roomId)
  if (cfg.password) u.searchParams.set('pw', cfg.password)
  if (cfg.local) u.searchParams.set('local', '1')
  return u.toString()
}
