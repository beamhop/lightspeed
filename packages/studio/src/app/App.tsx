/** @jsxImportSource preact */
import { Badge, Mascot, Tabs, ToastHost } from '@beamhop/ui'
import { useEffect } from 'preact/hooks'
import { AttachBar } from './AttachBar'
import { Scrubber } from './Scrubber'
import {
  attach,
  attachError,
  checkServer,
  events,
  faults,
  live,
  room,
  snapshot,
  type Tab,
  tab,
} from './store'
import { ConnectionView } from './views/Connection'
import { FaultsView } from './views/Faults'
import { HealthView } from './views/Health'
import { IdentityView } from './views/Identity'
import { InspectorView } from './views/Inspector'
import { SpawnerView } from './views/Spawner'
import { TimelineView } from './views/Timeline'
import { TopologyView } from './views/Topology'

const VIEWS: Record<Tab, () => preact.JSX.Element> = {
  topology: TopologyView,
  inspector: InspectorView,
  timeline: TimelineView,
  connection: ConnectionView,
  faults: FaultsView,
  spawner: SpawnerView,
  health: HealthView,
  identity: IdentityView,
}

export interface AppProps {
  /** Attach with the saved settings on mount (default true). */
  autoAttach?: boolean
  /** Probe /api/info for the Studio server (default true). */
  probeServer?: boolean
}

export function App({ autoAttach = true, probeServer = true }: AppProps) {
  useEffect(() => {
    if (autoAttach) void attach()
    if (probeServer) void checkServer()
  }, [autoAttach, probeServer])

  const View = VIEWS[tab.value]
  const s = snapshot.value
  const r = room.value
  return (
    <div class="studio bh-root">
      <header class="studio__header">
        <div class="studio__brand">
          <Mascot state={attachError.value ? 'angry' : r ? 'idle' : 'spinner'} size={34} />
          <div>
            <div class="studio__title">Beamhop Studio</div>
            <div class="studio__subtitle bh-muted">
              {r ? `${r.mode} · ${r.roomId}` : 'not attached'}
            </div>
          </div>
        </div>
        <AttachBar />
        <div class="studio__status">
          <Badge tone={live.value ? 'success' : 'warning'} dot>
            {live.value ? 'live' : 'replay'}
          </Badge>
          <span class="bh-muted bh-mono">{events.value.length.toLocaleString()} events</span>
        </div>
      </header>
      {attachError.value && (
        <div class="studio__error" role="alert">
          {attachError.value}
        </div>
      )}
      <nav class="studio__tabs">
        <Tabs
          label="Studio views"
          value={tab.value}
          onChange={(id) => {
            tab.value = id as Tab
          }}
          tabs={[
            {
              id: 'topology',
              label: 'Topology',
              count: Object.values(s.topology.nodes).filter((n) => n.present).length,
            },
            { id: 'inspector', label: 'Messages', count: s.messages.in + s.messages.out },
            { id: 'timeline', label: 'Timeline' },
            { id: 'connection', label: 'Connections' },
            { id: 'faults', label: 'Faults', count: faults.value.length || undefined },
            { id: 'spawner', label: 'Spawner' },
            { id: 'health', label: 'Relay health' },
            { id: 'identity', label: 'Identity' },
          ]}
        />
      </nav>
      <main class="studio__main">
        <View />
      </main>
      <Scrubber />
      <ToastHost />
    </div>
  )
}
