/** @jsxImportSource preact */
import { effect } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { ConfirmDialog, RevealOnceModal, Toasts } from './components/Dialogs'
import { Layout } from './components/Layout'
import { MascotMessage } from './components/Mascot'
import { Link } from './components/ui'
import { api, rememberMockAuth, stats } from './ctx'
import { currentPath, matchRoute } from './router'
import { Admins } from './screens/Admins'
import { AppDetail, AppsList } from './screens/Apps'
import { Login } from './screens/Login'
import { Media } from './screens/Media'
import { Nostr } from './screens/Nostr'
import { Overview } from './screens/Overview'
import { Payments } from './screens/Payments'
import { Settings } from './screens/Settings'
import { Turn } from './screens/Turn'
import { session } from './store'

export const ROUTES: {
  path: string
  render: (p: Record<string, string>) => preact.ComponentChildren
}[] = [
  { path: '/', render: () => <Overview /> },
  { path: '/nostr', render: () => <Nostr /> },
  { path: '/turn', render: () => <Turn /> },
  { path: '/apps', render: () => <AppsList /> },
  { path: '/apps/:id', render: (p) => <AppDetail key={p.id} id={p.id as string} /> },
  { path: '/media', render: () => <Media /> },
  { path: '/payments', render: () => <Payments /> },
  { path: '/admins', render: () => <Admins /> },
  { path: '/settings', render: () => <Settings /> },
]

export function resolveRoute(path: string) {
  for (const r of ROUTES) {
    const params = matchRoute(r.path, path)
    if (params) return { route: r, params }
  }
  return null
}

let booted = false
/** Load the session once and keep the stats stream tied to it. */
export function boot(): void {
  if (booted) return
  booted = true
  api.auth
    .me()
    .then((me) => {
      session.value = me
    })
    .catch(() => {
      session.value = null
    })
  effect(() => {
    if (session.value) {
      rememberMockAuth(true)
      stats.start()
    } else if (session.value === null) {
      rememberMockAuth(false)
      stats.stop()
    }
  })
}

export function App() {
  useEffect(() => boot(), [])
  const me = session.value
  if (me === undefined) {
    return (
      <div class="min-h-dvh flex items-center justify-center">
        <MascotMessage state="spinner" title="Hopping in…" />
      </div>
    )
  }
  if (me === null) {
    return (
      <>
        <Login />
        <RevealOnceModal />
        <Toasts />
      </>
    )
  }
  const match = resolveRoute(currentPath.value)
  return (
    <>
      <Layout>
        {match ? (
          match.route.render(match.params)
        ) : (
          <MascotMessage state="angry" title="No such page">
            <Link to="/" class="text-teal">
              Back to overview
            </Link>
          </MascotMessage>
        )}
      </Layout>
      <ConfirmDialog />
      <RevealOnceModal />
      <Toasts />
    </>
  )
}
