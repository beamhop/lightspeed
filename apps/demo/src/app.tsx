import { Bug, Files as FilesIcon, LogOut, MessagesSquare, MousePointer2, Phone } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Alert, AlertDescription } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { type DemoConfig, readConfig, roomLink } from './config'
import { loadStored, saveStored, useCallPeers, usePeers } from './hooks'
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
const TABS: { id: Tab; label: string; icon: typeof Phone }[] = [
  { id: 'room', label: 'Room', icon: MessagesSquare },
  { id: 'cursors', label: 'Cursors', icon: MousePointer2 },
  { id: 'files', label: 'Files', icon: FilesIcon },
  { id: 'call', label: 'Call', icon: Phone },
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
  const [inCall, setInCall] = useState(false)
  // Bumped by the incoming-call banner; the Call screen starts media when it changes.
  const [joinCall, setJoinCall] = useState(0)

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
    setInCall(false)
    history.replaceState(null, '', location.pathname + (cfg.local ? '?local=1' : ''))
  }

  async function rejoinWith(patch: Partial<DemoConfig>) {
    await room?.leave()
    setRoom(null)
    setInCall(false)
    await join({ ...cfg, ...patch })
  }

  // opening a shared link joins once, on mount
  useEffect(() => {
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
      <Shell>
        <Header />
        <Lobby cfg={cfg} joining={joining} error={error} onJoin={join} />
      </Shell>
    )
  }

  return (
    <Shell>
      <Header>
        <Badge
          variant="outline"
          className={
            room.mode === 'local'
              ? 'border-violet/50 text-violet'
              : 'border-primary/50 text-primary'
          }
          data-testid="mode"
        >
          {room.mode === 'local' ? 'local tabs' : 'nostr + webrtc'}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => setDebugOpen(true)}>
          <Bug />
          Debug
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={leave}
        >
          <LogOut />
          Leave
        </Button>
      </Header>
      {room.notice && (
        <Alert className="mb-4 border-warning/40 text-warning">
          <AlertDescription className="text-warning/90">{room.notice}</AlertDescription>
        </Alert>
      )}
      <ShareBox link={roomLink(location.href, cfg)} roomId={room.roomId} />
      {!inCall && (
        <IncomingCall
          room={room}
          onJoin={() => {
            setTab('call')
            setJoinCall((n) => n + 1)
          }}
        />
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList aria-label="Demo screens" className="w-full sm:w-fit">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="sm:px-4">
              <t.icon />
              {t.label}
              {t.id === 'call' && inCall && (
                <span className="size-2 rounded-full bg-success" aria-label="(in call)" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Screens stay mounted so chat, transfers and an ongoing call survive switching tabs. */}
        <TabsContent value="room" forceMount className="data-[state=inactive]:hidden">
          <Room room={room} />
        </TabsContent>
        <TabsContent value="cursors" forceMount className="data-[state=inactive]:hidden">
          <Cursors room={room} />
        </TabsContent>
        <TabsContent value="files" forceMount className="data-[state=inactive]:hidden">
          <Files room={room} />
        </TabsContent>
        <TabsContent value="call" forceMount className="data-[state=inactive]:hidden">
          <Call room={room} joinSignal={joinCall} onActiveChange={setInCall} />
        </TabsContent>
      </Tabs>
      <DebugDrawer
        open={debugOpen}
        onOpenChange={setDebugOpen}
        room={room}
        cfg={cfg}
        onOwnRelay={(ownRelay) => rejoinWith({ ownRelay, local: false })}
      />
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-6xl px-4 pb-12">{children}</main>
}

function IncomingCall({ room, onJoin }: { room: DemoRoom; onJoin: () => void }) {
  const ids = useCallPeers(room)
  const peers = usePeers(room)
  if (!ids.length) return null
  const names = ids.map((id) => peers.find((p) => p.id === id)?.name ?? id.slice(0, 8))
  return (
    <div
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm"
      role="status"
      data-testid="incoming-call"
    >
      <span className="flex items-center gap-2">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
        </span>
        <span>
          <strong>{names.join(', ')}</strong> {names.length === 1 ? 'is' : 'are'} in a call
        </span>
      </span>
      <Button size="sm" onClick={onJoin}>
        <Phone />
        Join call
      </Button>
    </div>
  )
}

function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="mb-6 flex items-center justify-between gap-3 border-b py-3.5">
      <a
        className="flex items-center gap-2.5 text-[1.05rem] text-foreground no-underline"
        href={import.meta.env.BASE_URL}
      >
        <Bunny size={32} state="smile" />
        <span className="tracking-tight">
          beamhop <strong className="text-primary">lightspeed</strong>
        </span>
      </a>
      <div className="flex flex-wrap items-center justify-end gap-1.5">{children}</div>
    </header>
  )
}
