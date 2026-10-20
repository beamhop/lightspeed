import { useEffect, useState } from 'preact/hooks'
import { type DemoConfig, parseRoomInput, randomRoomId } from '../config'
import { Bunny } from '../mascot'
import type { RelayStatus } from '../p2p'

/** Opens a WebSocket to each relay and reports whether it answers; closes right away. */
function useRelayProbe(relays: string[], enabled: boolean): RelayStatus[] {
  const [status, setStatus] = useState<RelayStatus[]>(() =>
    relays.map((url) => ({ url, state: 'connecting' })),
  )
  useEffect(() => {
    if (!enabled) return
    setStatus(relays.map((url) => ({ url, state: 'connecting' })))
    const sockets: WebSocket[] = []
    const set = (url: string, state: RelayStatus['state'], error?: string) =>
      setStatus((prev) =>
        prev.map((s) => (s.url === url ? { url, state, ...(error ? { error } : {}) } : s)),
      )
    for (const url of relays) {
      try {
        const ws = new WebSocket(url)
        sockets.push(ws)
        const timeout = setTimeout(() => {
          set(url, 'error', 'timeout')
          ws.close()
        }, 6000)
        ws.onopen = () => {
          clearTimeout(timeout)
          set(url, 'open')
          ws.close()
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          set(url, 'error', 'unreachable')
        }
      } catch (err) {
        set(url, 'error', String(err))
      }
    }
    return () => {
      for (const ws of sockets) ws.close()
    }
  }, [relays.join(','), enabled])
  return status
}

export function RelayList({ relays }: { relays: RelayStatus[] }) {
  return (
    <ul class="relays" data-testid="relays">
      {relays.map((r) => (
        <li key={r.url}>
          <span class={`dot dot-${r.state}`} aria-hidden="true" />
          <code>{r.url}</code>
          <span class="muted">{r.error ?? r.state}</span>
        </li>
      ))}
    </ul>
  )
}

export function Lobby(props: {
  cfg: DemoConfig
  joining: boolean
  error: string | null
  onJoin: (cfg: DemoConfig) => void
}) {
  const { cfg } = props
  const [name, setName] = useState(cfg.name)
  const [roomInput, setRoomInput] = useState(cfg.roomId)
  const [password, setPassword] = useState(cfg.password)
  const [local, setLocal] = useState(cfg.local)
  const [identity, setIdentity] = useState(cfg.identity)
  const hasNip07 = typeof window !== 'undefined' && 'nostr' in window
  const probe = useRelayProbe(cfg.relays, !local)

  const submit = (roomId: string, pw = password) =>
    props.onJoin({ ...cfg, name: name.trim() || cfg.name, roomId, password: pw, local, identity })

  const parsed = parseRoomInput(roomInput)

  return (
    <div class="lobby">
      <div class="hero">
        <Bunny size={96} state={props.joining ? 'spinner' : props.error ? 'angry' : 'idle'} />
        <div>
          <h1>Peer-to-peer rooms, no server in the middle</h1>
          <p class="muted">
            Signaling runs over public Nostr relays, media and data go straight between browsers
            with WebRTC. Open a room, share the link or QR code, and everything below happens
            peer-to-peer.
          </p>
        </div>
      </div>

      <form
        class="card"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed) submit(parsed.roomId, parsed.password ?? password)
        }}
      >
        <label>
          Your name
          <input
            name="name"
            value={name}
            maxLength={32}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <label>
          Room link or id
          <input
            name="room"
            placeholder="paste a link or type a room id"
            value={roomInput}
            onInput={(e) => setRoomInput(e.currentTarget.value)}
          />
        </label>
        <label>
          Password <span class="muted">(optional, changes the room topic)</span>
          <input
            name="password"
            type="password"
            autoComplete="off"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        <fieldset class="row">
          <legend>Identity</legend>
          <label class="inline">
            <input
              type="radio"
              name="identity"
              checked={identity === 'anonymous'}
              onChange={() => setIdentity('anonymous')}
            />
            Anonymous key
          </label>
          <label class="inline" title={hasNip07 ? '' : 'Needs a NIP-07 browser extension'}>
            <input
              type="radio"
              name="identity"
              disabled={!hasNip07}
              checked={identity === 'nostr'}
              onChange={() => setIdentity('nostr')}
            />
            Sign in with Nostr
          </label>
        </fieldset>
        <label class="inline">
          <input
            type="checkbox"
            name="local"
            checked={local}
            onChange={(e) => setLocal(e.currentTarget.checked)}
          />
          Local mode (tabs of this browser only, no network)
        </label>
        <div class="row">
          <button
            type="button"
            class="primary"
            disabled={props.joining}
            data-testid="create"
            onClick={() => submit(randomRoomId())}
          >
            Create room
          </button>
          <button type="submit" disabled={props.joining || !parsed} data-testid="join">
            Join
          </button>
        </div>
        {props.error && (
          <p class="error" role="alert">
            {props.error}
          </p>
        )}
      </form>

      <section class="card">
        <h2>Signaling relays</h2>
        {local ? (
          <RelayList relays={[{ url: 'BroadcastChannel (this browser)', state: 'open' }]} />
        ) : (
          <RelayList relays={probe} />
        )}
        <p class="muted small">
          ICE: stun.l.google.com:19302 and stun.cloudflare.com:3478. No TURN, so two peers behind
          symmetric NATs cannot connect here; point the demo at your own relay from the Debug drawer
          to add TURN and the data relay.
        </p>
      </section>
    </div>
  )
}
