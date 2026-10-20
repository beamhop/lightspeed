import { useState } from 'preact/hooks'
import { type DemoConfig, normalizeRelayUrl } from '../config'
import { formatBytes, shortId, usePeers, useTelemetry } from '../hooks'
import type { DemoRoom } from '../p2p'
import { RelayList } from './Lobby'

export function DebugDrawer(props: {
  room: DemoRoom
  cfg: DemoConfig
  onClose: () => void
  onOwnRelay: (own: DemoConfig['ownRelay']) => void
}) {
  const { room } = props
  const t = useTelemetry(room)
  const peers = usePeers(room)
  const [url, setUrl] = useState(props.cfg.ownRelay?.url ?? '')
  const [appId, setAppId] = useState(props.cfg.ownRelay?.appId ?? '')
  const [apiKey, setApiKey] = useState(props.cfg.ownRelay?.apiKey ?? '')
  const [formError, setFormError] = useState<string | null>(null)

  const nameOf = (id: string) => peers.find((p) => p.id === id)?.name ?? shortId(id)
  const failing = Object.values(t.peers).some(
    (p) => p.state === 'failed' || p.state === 'disconnected',
  )

  return (
    <aside class="drawer" aria-label="Debug drawer" data-testid="debug">
      <div class="row between">
        <h2>Debug</h2>
        <button type="button" class="ghost" onClick={props.onClose}>
          Close
        </button>
      </div>

      <h3>Signaling</h3>
      <RelayList relays={t.relays} />

      <h3>Peers</h3>
      <table>
        <thead>
          <tr>
            <th>Peer</th>
            <th>Path</th>
            <th>State</th>
            <th>RTT</th>
            <th>Bytes (sent / received)</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(t.peers).map(([id, p]) => (
            <tr key={id}>
              <td title={id}>{nameOf(id)}</td>
              <td>
                <span class={`path path-${p.path}`}>{p.path}</span>
                {p.candidatePair && <div class="muted small">{p.candidatePair}</div>}
              </td>
              <td>{p.state}</td>
              <td>{p.rttMs !== undefined ? `${p.rttMs} ms` : '–'}</td>
              <td>
                {Object.entries(p.bytes).map(([ch, b]) => (
                  <div key={ch} class="small">
                    <code>{ch}</code> {formatBytes(b.sent)} / {formatBytes(b.received)}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {failing && (
        <p class="notice small">
          A peer could not connect directly. On public STUN only, two symmetric NATs cannot reach
          each other; add your own relay below for TURN and the data relay.
        </p>
      )}

      <h3>Last signaling events</h3>
      <ol class="log">
        {t.signaling
          .slice(-20)
          .reverse()
          .map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <time>{new Date(e.at).toLocaleTimeString()}</time> {e.direction === 'in' ? '←' : '→'}{' '}
              <code>{e.kind}</code> {e.peer ? nameOf(e.peer) : ''}
            </li>
          ))}
      </ol>

      <h3>Use your own relay</h3>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault()
          const norm = normalizeRelayUrl(url)
          if (!url.trim()) {
            props.onOwnRelay(undefined)
            return
          }
          if (!norm || !appId.trim()) {
            setFormError('Enter a relay URL (wss://relay.example) and an app id')
            return
          }
          setFormError(null)
          props.onOwnRelay({
            url: norm,
            appId: appId.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        }}
      >
        <input
          placeholder="wss://relay.example"
          value={url}
          onInput={(e) => setUrl(e.currentTarget.value)}
          aria-label="Relay URL"
        />
        <input
          placeholder="app id"
          value={appId}
          onInput={(e) => setAppId(e.currentTarget.value)}
          aria-label="App id"
        />
        <input
          placeholder="API key for TURN credentials (optional)"
          value={apiKey}
          type="password"
          autoComplete="off"
          onInput={(e) => setApiKey(e.currentTarget.value)}
          aria-label="API key"
        />
        <p class="muted small">
          Adds <code>wss://…/a/&lt;appId&gt;</code> for signaling, mints TURN credentials from{' '}
          <code>/a/&lt;appId&gt;/turn-credentials</code> and enables the data relay. Leave the URL
          empty to go back to public relays. Rejoins the room.
        </p>
        {formError && <p class="error">{formError}</p>}
        <button type="submit">Apply and rejoin</button>
      </form>
    </aside>
  )
}
