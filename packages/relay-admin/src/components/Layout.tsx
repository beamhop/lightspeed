/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { isMock, stats } from '../ctx'
import { shortNpub } from '../format'
import { currentPath, navigate } from '../router'
import { session } from '../store'
import { Mascot } from './Mascot'
import { Link } from './ui'

const ICONS: Record<string, string> = {
  overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  nostr:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm1 14.9V19h-2v-2.1A5 5 0 017 12h2a3 3 0 106 0h2a5 5 0 01-4 4.9zM11 5h2v6h-2z',
  turn: 'M4 12a8 8 0 0114-5.3V4h2v6h-6V8h2.7A6 6 0 106 12H4zm16 0a8 8 0 01-14 5.3V20H4v-6h6v2H7.3A6 6 0 1018 12h2z',
  apps: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  media: 'M4 5h16v14H4V5zm2 2v8l4-4 3 3 2-2 3 3V7H6zm9 1.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  payments: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  admins: 'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
  settings:
    'M19.4 13a7.6 7.6 0 000-2l2.1-1.6-2-3.4-2.5 1a7 7 0 00-1.7-1L15 3h-4l-.4 2.6a7 7 0 00-1.7 1l-2.5-1-2 3.4L6.6 11a7.6 7.6 0 000 2l-2.1 1.6 2 3.4 2.5-1a7 7 0 001.7 1L11 21h4l.4-2.6a7 7 0 001.7-1l2.5 1 2-3.4-2.2-1.6zM13 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
  more: 'M5 10a2 2 0 100 4 2 2 0 000-4zm7 0a2 2 0 100 4 2 2 0 000-4zm7 0a2 2 0 100 4 2 2 0 000-4z',
}

export function Icon({ name, class: cls = 'size-5' }: { name: string; class?: string }) {
  return (
    <svg viewBox="0 0 24 24" class={cls} fill="currentColor" aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
    </svg>
  )
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
  const s = stats.status.value
  const tone =
    s === 'open'
      ? 'bg-ok'
      : s === 'reconnecting' || s === 'connecting'
        ? 'bg-warn animate-pulse'
        : 'bg-danger'
  const label =
    s === 'open'
      ? 'Live'
      : s === 'reconnecting'
        ? `Reconnecting (${stats.attempts.value})`
        : s === 'connecting'
          ? 'Connecting'
          : 'Offline'
  return (
    <span
      class="inline-flex items-center gap-1.5 text-xs text-muted"
      title="Stats stream"
      data-live={s}
    >
      <span class={`size-2 rounded-full ${tone}`} />
      {label}
    </span>
  )
}

export function Layout({ children }: { children: ComponentChildren }) {
  const path = currentPath.value
  const [more, setMore] = useState(false)
  const me = session.value
  const who = me?.pubkey ? shortNpub(me.pubkey) : (me?.username ?? '')
  const moreActive = NAV.some((n) => !('primary' in n) && isActive(n.to, path))

  return (
    <div class="min-h-dvh md:flex">
      {/* desktop sidebar */}
      <aside class="hidden md:flex md:flex-col w-60 shrink-0 border-r border-line bg-surface/60 sticky top-0 h-dvh">
        <div class="flex items-center gap-2 px-4 py-4">
          <Mascot state="idle" size={34} />
          <div>
            <div class="text-sm font-semibold text-ink leading-tight">Beamhop Relay</div>
            <div class="text-[11px] text-muted">Admin{isMock ? ' · mock' : ''}</div>
          </div>
        </div>
        <nav class="flex-1 px-2 space-y-0.5" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={isActive(n.to, path) ? 'page' : undefined}
              class={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${isActive(n.to, path) ? 'bg-teal/10 text-teal font-medium' : 'text-muted hover:text-ink hover:bg-raised'}`}
            >
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div class="px-4 py-3 border-t border-line text-xs text-muted space-y-1">
          <LiveDot />
          <div class="truncate font-mono" title={me?.pubkey ?? me?.username}>
            {who}
          </div>
        </div>
      </aside>

      <div class="flex-1 min-w-0 flex flex-col">
        {/* phone top bar */}
        <header class="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-12 bg-midnight/90 backdrop-blur border-b border-line">
          <div class="flex items-center gap-2">
            <Mascot state="idle" size={26} />
            <span class="text-sm font-semibold">
              Beamhop Relay{isMock ? <span class="text-muted font-normal"> · mock</span> : null}
            </span>
          </div>
          <LiveDot />
        </header>
        <main class="flex-1 px-4 py-4 md:px-8 md:py-6 pb-24 md:pb-8 max-w-6xl w-full mx-auto">
          {children}
        </main>
      </div>

      {/* phone bottom nav */}
      <nav
        class="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-t border-line pb-safe"
        aria-label="Main"
      >
        <div class="grid grid-cols-5">
          {NAV.filter((n) => 'primary' in n).map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={isActive(n.to, path) ? 'page' : undefined}
              class={`flex flex-col items-center gap-0.5 pt-2 pb-1 text-[10px] ${isActive(n.to, path) ? 'text-teal' : 'text-muted'}`}
            >
              <Icon name={n.icon} />
              {'short' in n ? n.short : n.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setMore(true)}
            class={`flex flex-col items-center gap-0.5 pt-2 pb-1 text-[10px] ${moreActive ? 'text-teal' : 'text-muted'}`}
            aria-haspopup="dialog"
          >
            <Icon name="more" />
            More
          </button>
        </div>
      </nav>
      {more && (
        <div class="md:hidden fixed inset-0 z-50" role="dialog" aria-label="More sections">
          <div class="absolute inset-0 bg-black/60" onClick={() => setMore(false)} />
          <div class="absolute bottom-0 inset-x-0 rounded-t-2xl bg-surface border-t border-line p-4 pb-safe">
            <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
            <div class="grid grid-cols-2 gap-2">
              {NAV.filter((n) => !('primary' in n)).map((n) => (
                <button
                  key={n.to}
                  type="button"
                  onClick={() => {
                    setMore(false)
                    navigate(n.to)
                  }}
                  class={`flex items-center gap-3 rounded-md border border-line px-3 py-3 text-sm ${isActive(n.to, path) ? 'text-teal border-teal/40' : 'text-ink'}`}
                >
                  <Icon name={n.icon} />
                  {n.label}
                </button>
              ))}
            </div>
            <div class="mt-3 text-xs text-muted truncate font-mono">{who}</div>
          </div>
        </div>
      )}
    </div>
  )
}
