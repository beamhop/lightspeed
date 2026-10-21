import { type ReactNode, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { type DemoConfig, normalizeRelayUrl } from '../config'
import { formatBytes, shortId, usePeers, useTelemetry } from '../hooks'
import type { DemoRoom, PathKind } from '../p2p'
import { RelayList } from './Lobby'

const PATH_COLOR: Partial<Record<PathKind, string>> = {
  direct: 'text-primary',
  local: 'text-primary',
  turn: 'text-violet',
  relay: 'text-warning',
}

export function DebugDrawer(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: DemoRoom
  cfg: DemoConfig
  onOwnRelay: (own: DemoConfig['ownRelay']) => void
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        aria-label="Debug drawer"
        data-testid="debug"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Debug</SheetTitle>
          <SheetDescription>Paths, RTT and bytes per channel, live.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <DebugBody {...props} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function DebugBody(props: {
  room: DemoRoom
  cfg: DemoConfig
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
    <div className="grid gap-6 p-4">
      <Section title="Signaling">
        <RelayList relays={t.relays} />
      </Section>

      <Section title="Peers">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Peer</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>State</TableHead>
                <TableHead>RTT</TableHead>
                <TableHead>Sent / received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(t.peers).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No peers yet
                  </TableCell>
                </TableRow>
              )}
              {Object.entries(t.peers).map(([id, p]) => (
                <TableRow key={id}>
                  <TableCell title={id} className="font-medium">
                    {nameOf(id)}
                  </TableCell>
                  <TableCell>
                    <span className={cn('font-mono text-xs', PATH_COLOR[p.path])}>{p.path}</span>
                    {p.candidatePair && (
                      <div className="text-xs text-muted-foreground">{p.candidatePair}</div>
                    )}
                  </TableCell>
                  <TableCell>{p.state}</TableCell>
                  <TableCell className="tabular-nums">
                    {p.rttMs !== undefined ? `${p.rttMs} ms` : '–'}
                  </TableCell>
                  <TableCell>
                    {Object.entries(p.bytes).map(([ch, b]) => (
                      <div key={ch} className="text-xs tabular-nums">
                        <code className="font-mono text-muted-foreground">{ch}</code>{' '}
                        {formatBytes(b.sent)} / {formatBytes(b.received)}
                      </div>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {failing && (
          <Alert className="border-warning/40">
            <AlertDescription className="text-warning/90">
              A peer could not connect directly. On public STUN only, two symmetric NATs cannot
              reach each other; add your own relay below for TURN and the data relay.
            </AlertDescription>
          </Alert>
        )}
      </Section>

      <Section title="Last signaling events">
        <ol className="grid gap-0.5 rounded-lg border bg-muted/30 p-3 font-mono text-xs">
          {t.signaling.length === 0 && <li className="text-muted-foreground">Nothing yet</li>}
          {t.signaling
            .slice(-20)
            .reverse()
            .map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2">
                <time className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</time>
                <span className={e.direction === 'in' ? 'text-primary' : 'text-violet'}>
                  {e.direction === 'in' ? '←' : '→'}
                </span>
                <code>{e.kind}</code> {e.peer ? nameOf(e.peer) : ''}
              </li>
            ))}
        </ol>
      </Section>

      <Separator />

      <Section title="Use your own relay">
        <form
          className="grid gap-2.5"
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
          <Input
            placeholder="wss://relay.example"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            aria-label="Relay URL"
          />
          <Input
            placeholder="app id"
            value={appId}
            onChange={(e) => setAppId(e.currentTarget.value)}
            aria-label="App id"
          />
          <Input
            placeholder="API key for TURN credentials (optional)"
            value={apiKey}
            type="password"
            autoComplete="off"
            onChange={(e) => setApiKey(e.currentTarget.value)}
            aria-label="API key"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Adds <code className="font-mono">wss://…/a/&lt;appId&gt;</code> for signaling, mints
            TURN credentials from{' '}
            <code className="font-mono">/a/&lt;appId&gt;/turn-credentials</code> and enables the
            data relay. Leave the URL empty to go back to public relays. Rejoins the room.
          </p>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <Button type="submit" className="justify-self-start">
            Apply and rejoin
          </Button>
        </form>
      </Section>
    </div>
  )
}
