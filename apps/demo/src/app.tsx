import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { type DemoConfig, readConfig, roomLink } from './config'
import { loadStored, saveStored } from './hooks'
import { Bunny } from './mascot'
import { type DemoRoom, joinDemoRoom } from './p2p'
import { Call } from './screens/Call'
import { Cursors } from './screens/Cursors'
import { DebugDrawer } from './screens/DebugDrawer'
import { Files } from './screens/Files'
import { Lobby } from './screens/Lobby'
import { Room } from './screens/Room'
import { ShareBox } from './screens/Share'

type Tab = 'room' | 'cursors' | 'files' | 'call'
const TABS: { id: Tab; label: string }[] = [
  { id: 'room', label: 'Room' },
  { id: 'cursors', label: 'Cursors' },
  { id: 'files', label: 'Files' },
  { id: 'call', label: 'Call' },
]

export function App() {
  const [cfg, setCfg] = useState<DemoConfig>(() =>
    readConfig(location.search, loadStored<DemoConfig>()),
  )
  const [room, setRoom] = useState<DemoRoom | null>(null)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('room')
  const [debugOpen, setDebugOpen] = useState(false)

  async function join(next: DemoConfig) {
    setCfg(next)
    saveStored<DemoConfig>({ name: next.name, identity: next.identity, ownRelay: next.ownRelay })
    setJoining(true)
    setError(null)
    try {
      const r = await joinDemoRoom(next)
      setRoom(r)
      history.replaceState(null, '', roomLink(location.href, next))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setJoining(false)
    }
  }

  async function leave() {
    await room?.leave()
    setRoom(null)
    history.replaceState(null, '', location.pathname + (cfg.local ? '?local=1' : ''))
  }

  async function rejoinWith(patch: Partial<DemoConfig>) {
    await room?.leave()
    setRoom(null)
    await join({ ...cfg, ...patch })
  }

  useEffect(() => {
    // Opening a shared link joins straight away.
    if (cfg.roomId && !room) void join(cfg)
  }, [])

  useEffect(() => {
    if (!room) return
    const onUnload = () => void room.leave()
    addEventListener('beforeunload', onUnload)
    return () => removeEventListener('beforeunload', onUnload)
  }, [room])

  if (!room) {
    return (
      <main class="shell">
        <Header />
        <Lobby cfg={cfg} joining={joining} error={error} onJoin={join} />
      </main>
    )
  }

  return (
    <main class="shell">
      <Header>
        <span class={`badge badge-${room.mode}`} data-testid="mode">
          {room.mode === 'local' ? 'local tabs' : 'nostr + webrtc'}
        </span>
        <button type="button" class="ghost" onClick={() => setDebugOpen((o) => !o)}>
          Debug
        </button>
        <button type="button" class="ghost danger" onClick={leave}>
          Leave
        </button>
      </Header>
      {room.notice && <p class="notice">{room.notice}</p>}
      <ShareBox link={roomLink(location.href, cfg)} roomId={room.roomId} />
      <nav class="tabs" aria-label="Demo screens">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            class={tab === t.id ? 'tab active' : 'tab'}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <section class="screen">
        {tab === 'room' && <Room room={room} />}
        {tab === 'cursors' && <Cursors room={room} />}
        {tab === 'files' && <Files room={room} />}
        {tab === 'call' && <Call room={room} />}
      </section>
      {debugOpen && (
        <DebugDrawer
          room={room}
          cfg={cfg}
          onClose={() => setDebugOpen(false)}
          onOwnRelay={(ownRelay) => rejoinWith({ ownRelay, local: false })}
        />
      )}
    </main>
  )
}

function Header({ children }: { children?: ComponentChildren }) {
  return (
    <header class="top">
      <a class="brand" href={import.meta.env.BASE_URL}>
        <Bunny size={32} state="smile" />
        <span>
          beamhop <strong>lightspeed</strong>
        </span>
      </a>
      <div class="top-actions">{children}</div>
    </header>
  )
}
