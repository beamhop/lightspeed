import {
  Boxes,
  Image,
  LayoutDashboard,
  type LucideIcon,
  MoreHorizontal,
  Radio,
  Repeat,
  Settings,
  Users,
  Zap,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useValue } from '@/lib/signals'
import { cn } from '@/lib/utils'
import { isMock, stats } from '../ctx'
import { shortNpub } from '../format'
import { currentPath, navigate } from '../router'
import { session } from '../store'
import { Mascot } from './Mascot'
import { Link } from './ui'
import { Separator } from './ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  nostr: Radio,
  turn: Repeat,
  apps: Boxes,
  media: Image,
  payments: Zap,
  admins: Users,
  settings: Settings,
  more: MoreHorizontal,
}

export function Icon({ name, className = 'size-4' }: { name: string; className?: string }) {
  const I = ICONS[name]
  return I ? <I className={className} aria-hidden="true" /> : null
}

export const NAV = [
  { to: '/', label: 'Overview', icon: 'overview', primary: true },
  { to: '/nostr', label: 'Nostr relay', short: 'Nostr', icon: 'nostr', primary: true },
  { to: '/turn', label: 'TURN', icon: 'turn', primary: true },
  { to: '/apps', label: 'Apps', icon: 'apps', primary: true },
  { to: '/media', label: 'Media', icon: 'media' },
  { to: '/payments', label: 'Payments', icon: 'payments' },
  { to: '/admins', label: 'Admins', icon: 'admins' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
] as const

export function isActive(to: string, path: string): boolean {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)
}

function LiveDot() {
  const s = useValue(stats.status)
  const attempts = useValue(stats.attempts)
  const tone =
    s === 'open'
      ? 'bg-success'
      : s === 'reconnecting' || s === 'connecting'
        ? 'bg-warning animate-pulse'
        : 'bg-destructive'
  const label =
    s === 'open'
      ? 'Live'
      : s === 'reconnecting'
        ? `Reconnecting (${attempts})`
        : s === 'connecting'
          ? 'Connecting'
          : 'Offline'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      title="Stats stream"
      data-live={s}
    >
      <span className={cn('size-2 rounded-full', tone)} />
      {label}
    </span>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const path = useValue(currentPath)
  const me = useValue(session)
  const [more, setMore] = useState(false)
  const who = me?.pubkey ? shortNpub(me.pubkey) : (me?.username ?? '')
  const moreActive = NAV.some((n) => !('primary' in n) && isActive(n.to, path))

  return (
    <div className="min-h-dvh md:flex">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-card/60 md:flex">
        <div className="flex h-16 items-center gap-2.5 px-4">
          <Mascot state="idle" size={32} />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Beamhop Relay</div>
            <div className="text-xs text-muted-foreground">Admin{isMock ? ' · mock' : ''}</div>
          </div>
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 p-2" aria-label="Main">
          {NAV.map((n) => {
            const active = isActive(n.to, path)
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Icon name={n.icon} className={cn('size-4', active && 'text-primary')} />
                {n.label}
              </Link>
            )
          })}
        </nav>
        <Separator />
        <div className="space-y-1.5 px-4 py-3">
          <LiveDot />
          <div
            className="truncate font-mono text-xs text-muted-foreground"
            title={me?.pubkey ?? me?.username}
          >
            {who}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* phone top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <Mascot state="idle" size={26} />
            <span className="text-sm font-semibold">
              Beamhop Relay
              {isMock ? <span className="font-normal text-muted-foreground"> · mock</span> : null}
            </span>
          </div>
          <LiveDot />
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 pb-24 md:px-8 md:py-8">
          {children}
        </main>
      </div>

      {/* phone bottom nav */}
      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur md:hidden"
        aria-label="Main"
      >
        <div className="grid grid-cols-5">
          {NAV.filter((n) => 'primary' in n).map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={isActive(n.to, path) ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-1 pt-2 pb-1 text-[10px] font-medium',
                isActive(n.to, path) ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon name={n.icon} className="size-5" />
              {'short' in n ? n.short : n.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setMore(true)}
            className={cn(
              'flex flex-col items-center gap-1 pt-2 pb-1 text-[10px] font-medium',
              moreActive ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-haspopup="dialog"
          >
            <Icon name="more" className="size-5" />
            More
          </button>
        </div>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="pb-safe rounded-t-xl md:hidden">
          <SheetHeader>
            <SheetTitle>More sections</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs">{who}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2 px-4 pb-4">
            {NAV.filter((n) => !('primary' in n)).map((n) => (
              <button
                key={n.to}
                type="button"
                onClick={() => {
                  setMore(false)
                  navigate(n.to)
                }}
                className={cn(
                  'flex h-11 items-center gap-3 rounded-md border px-3 text-sm font-medium',
                  isActive(n.to, path) ? 'border-primary/40 text-primary' : 'text-foreground',
                )}
              >
                <Icon name={n.icon} />
                {n.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
