import { LogIn, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { type DemoConfig, parseRoomInput, randomRoomId } from '../config'
import { Bunny } from '../mascot'
import type { RelayStatus } from '../p2p'

/** Opens a WebSocket to each relay and reports whether it answers; closes right away. */
function useRelayProbe(relays: string[], enabled: boolean): RelayStatus[] {
  const [status, setStatus] = useState<RelayStatus[]>(() =>
    relays.map((url) => ({ url, state: 'connecting' })),
  )
  // keyed on the relay list's contents
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

const DOT: Record<RelayStatus['state'], string> = {
  open: 'bg-success shadow-[0_0_8px] shadow-success/60',
  connecting: 'bg-warning animate-pulse',
  error: 'bg-destructive',
  closed: 'bg-muted-foreground',
}

export function RelayList({ relays }: { relays: RelayStatus[] }) {
  return (
    <ul className="grid gap-1.5" data-testid="relays">
      {relays.map((r) => (
        <li
          key={r.url}
          className="flex items-center gap-2.5 rounded-md bg-muted/50 px-3 py-2 text-sm"
        >
          <span
            className={cn('size-2 shrink-0 rounded-full', DOT[r.state] ?? DOT.closed)}
            aria-hidden="true"
          />
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{r.url}</code>
          <span className="text-xs text-muted-foreground">{r.error ?? r.state}</span>
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
    <div className="grid gap-6">
      <div className="flex flex-col items-start gap-5 py-4 sm:flex-row sm:items-center">
        <Bunny size={96} state={props.joining ? 'spinner' : props.error ? 'angry' : 'idle'} />
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Peer-to-peer rooms,{' '}
            <span className="bg-gradient-to-r from-primary to-violet bg-clip-text text-transparent">
              no server in the middle
            </span>
          </h1>
          <p className="mt-3 text-muted-foreground text-pretty">
            Signaling runs over public Nostr relays, media and data go straight between browsers
            with WebRTC. Open a room, share the link or QR code, and everything below happens
            peer-to-peer.
          </p>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault()
              if (parsed) submit(parsed.roomId, parsed.password ?? password)
            }}
          >
            <CardHeader>
              <CardTitle>Open a room</CardTitle>
              <CardDescription>Create a fresh room or paste a link someone shared.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  name="name"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="room">Room link or id</Label>
                <Input
                  id="room"
                  name="room"
                  placeholder="paste a link or type a room id"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.currentTarget.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">
                  Password{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional, changes the room topic)
                  </span>
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </div>
              <fieldset className="grid gap-3">
                <legend className="mb-3 text-sm font-medium">Identity</legend>
                <RadioGroup
                  value={identity}
                  onValueChange={(v) => setIdentity(v as DemoConfig['identity'])}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <Label
                    htmlFor="id-anon"
                    className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-primary/5"
                  >
                    <RadioGroupItem id="id-anon" value="anonymous" />
                    Anonymous key
                  </Label>
                  <Label
                    htmlFor="id-nostr"
                    title={hasNip07 ? '' : 'Needs a NIP-07 browser extension'}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[[data-state=checked]]:border-primary/60 has-[[data-state=checked]]:bg-primary/5"
                  >
                    <RadioGroupItem id="id-nostr" value="nostr" disabled={!hasNip07} />
                    Sign in with Nostr
                  </Label>
                </RadioGroup>
              </fieldset>
              <Label htmlFor="local" className="flex items-center gap-3 font-normal">
                <Checkbox
                  id="local"
                  name="local"
                  checked={local}
                  onCheckedChange={(v) => setLocal(v === true)}
                />
                Local mode (tabs of this browser only, no network)
              </Label>
              {props.error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{props.error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={props.joining}
                data-testid="create"
                onClick={() => submit(randomRoomId())}
              >
                <Plus />
                Create room
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={props.joining || !parsed}
                data-testid="join"
              >
                <LogIn />
                Join
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signaling relays</CardTitle>
            <CardDescription>Probed live from your browser.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {local ? (
              <RelayList relays={[{ url: 'BroadcastChannel (this browser)', state: 'open' }]} />
            ) : (
              <RelayList relays={probe} />
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              ICE: stun.l.google.com:19302 and stun.cloudflare.com:3478. No TURN, so two peers
              behind symmetric NATs cannot connect here; point the demo at your own relay from the
              Debug drawer to add TURN and the data relay.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
