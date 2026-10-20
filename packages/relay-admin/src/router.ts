// Tiny history router on signals. Paths are app-relative ("/apps/abc"); the base (/admin) is added
// when touching window.location.

import { signal } from '@preact/signals'

export type Params = Record<string, string>

export function normalizeBase(base: string): string {
  const b = base.replace(/\/+$/, '')
  return b === '' ? '' : b.startsWith('/') ? b : `/${b}`
}

let base = '/admin'

export function setBase(b: string): void {
  base = normalizeBase(b)
}

export function getBase(): string {
  return base
}

/** Strip the base from a pathname. */
export function stripBase(pathname: string, b = base): string {
  if (b && (pathname === b || pathname.startsWith(`${b}/`))) pathname = pathname.slice(b.length)
  return pathname === '' ? '/' : pathname
}

export const currentPath = signal('/')
export const currentQuery = signal<URLSearchParams>(new URLSearchParams())

/** Match "/apps/:id" style patterns. Trailing slashes ignored. "*" matches the rest. */
export function matchRoute(pattern: string, path: string): Params | null {
  const ps = pattern.split('/').filter(Boolean)
  const xs = (path.split('?')[0] ?? '').split('/').filter(Boolean)
  const params: Params = {}
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as string
    if (p === '*') {
      params['*'] = xs.slice(i).map(decodeURIComponent).join('/')
      return params
    }
    const x = xs[i]
    if (x === undefined) return null
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(x)
    else if (p !== x) return null
  }
  return xs.length === ps.length ? params : null
}

function syncFromLocation(): void {
  if (typeof location === 'undefined') return
  currentPath.value = stripBase(location.pathname)
  currentQuery.value = new URLSearchParams(location.search)
}

/** Keep sticky query params (e.g. mock=1) across navigation. */
const STICKY = ['mock']

export function href(to: string): string {
  const [p, q = ''] = to.split('?')
  const params = new URLSearchParams(q)
  if (typeof location !== 'undefined') {
    const cur = new URLSearchParams(location.search)
    for (const k of STICKY) if (cur.has(k) && !params.has(k)) params.set(k, cur.get(k) as string)
  }
  const qs = params.toString()
  return `${base}${p === '/' ? '/' : p}${qs ? `?${qs}` : ''}`
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (typeof history === 'undefined') {
    const [p, q = ''] = to.split('?')
    currentPath.value = p || '/'
    currentQuery.value = new URLSearchParams(q)
    return
  }
  const url = href(to)
  if (opts.replace) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  syncFromLocation()
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0)
}

export function startRouter(): () => void {
  syncFromLocation()
  const onPop = () => syncFromLocation()
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return
    const a = (e.target as Element | null)?.closest?.('a[data-nav]') as HTMLAnchorElement | null
    if (!a) return
    const url = new URL(a.href)
    if (url.origin !== location.origin) return
    e.preventDefault()
    navigate(stripBase(url.pathname) + url.search)
  }
  window.addEventListener('popstate', onPop)
  document.addEventListener('click', onClick)
  return () => {
    window.removeEventListener('popstate', onPop)
    document.removeEventListener('click', onClick)
  }
}
