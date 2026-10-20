/** @jsxImportSource preact */
import { Button, Card, EmptyState, formatBytes, PathBadge, Sparkline, Stat } from '@beamhop/ui'
import { useMemo, useRef } from 'preact/hooks'
import { linkKey } from '../../model/events'
import { forceLayout, type Point } from '../../model/layout'
import { histogram } from '../../model/timeline'
import {
  activeLinks,
  linkBytes,
  pathCounts,
  presentNodes,
  type TopoLink,
} from '../../model/topology'
import type { PathType } from '../../room-adapter'
import { ms, PATH_COLOR } from '../format'
import {
  events,
  peerName,
  peers,
  selectedLink,
  selectedPeer,
  snapshot,
  tab,
  viewTime,
} from '../store'

const W = 800
const H = 520

function linkColor(l: TopoLink): string {
  if (l.state === 'away') return 'var(--bh-warning)'
  if (l.state !== 'connected') return 'var(--bh-text-muted)'
  return PATH_COLOR[l.path ?? 'memory']
}

export function TopologyView() {
  const s = snapshot.value
  const topo = s.topology
  const nodes = presentNodes(topo)
  const links = activeLinks(topo)
  const hostSet = new Set(peers.value.filter((p) => p.isHost).map((p) => p.pubkey))
  const selfSet = new Set(peers.value.filter((p) => p.isSelf).map((p) => p.pubkey))
  const prev = useRef<Record<string, Point>>({})

  const ids = nodes.map((n) => n.id)
  const shape = `${ids.sort().join(',')}|${links
    .map((l) => l.key)
    .sort()
    .join(',')}`
  const pos = useMemo(() => {
    const p = forceLayout(
      ids,
      links.map((l) => [l.a, l.b] as [string, string]),
      {
        width: W,
        height: H,
        previous: prev.current,
        iterations: Object.keys(prev.current).length ? 60 : 160,
      },
    )
    prev.current = p
    return p
  }, [shape])

  // with many links, show RTT-only chips and reveal the full badge on hover/selection
  const dense = links.length > 6
  const counts = pathCounts(topo)
  const rtts = links.map((l) => l.rttMs).filter((v): v is number => v !== undefined)
  const avgRtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : undefined
  const t = viewTime.value
  const rate = useMemo(() => {
    const msgs = events.value.filter((e) => e.event.type === 'message')
    return histogram(msgs, t - 60_000, t, 60)
  }, [events.value.length, Math.floor(t / 1000)])

  const sel = selectedLink.value
  const selLink = sel ? topo.links[linkKey(sel.source, sel.peer)] : undefined

  return (
    <div class="topology">
      <Card
        title="Topology"
        flush
        actions={
          <div class="legend">
            {(['direct', 'turn', 'relay'] as PathType[]).map((p) => (
              <PathBadge key={p} path={p} />
            ))}
          </div>
        }
      >
        {nodes.length === 0 ? (
          <EmptyState
            mascot="spinner"
            title="No peers yet"
            description="Waiting for the first announce on the room topic."
          />
        ) : (
          <svg class="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Room topology graph">
            {links.map((l) => {
              const a = pos[l.a]
              const b = pos[l.b]
              if (!a || !b) return null
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              const bytes = linkBytes(l).total
              const selected = selLink?.key === l.key
              const label = `${l.path === 'turn' ? 'TURN' : (l.path ?? '?')} · ${ms(l.rttMs)} · ${formatBytes(bytes)}`
              const short = l.rttMs === undefined ? '…' : `${Math.round(l.rttMs)}`
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: SVG group acts as a link hit target
                <g
                  key={l.key}
                  class={`graph__link${selected ? ' graph__link--selected' : ''}`}
                  data-path={l.path}
                  data-state={l.state}
                  onClick={() => {
                    selectedLink.value = { source: l.a, peer: l.b }
                  }}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="graph__hit" />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    style={{ stroke: linkColor(l) }}
                    stroke-width={selected ? 3.5 : 2}
                    stroke-dasharray={
                      l.path === 'relay' || l.state !== 'connected' ? '6 5' : undefined
                    }
                  />
                  {dense && (
                    <g
                      transform={`translate(${mx} ${my})`}
                      class="graph__label graph__label--compact"
                    >
                      <rect
                        x={-short.length * 3.1 - 5}
                        y={-8}
                        width={short.length * 6.2 + 10}
                        height={16}
                        rx={8}
                      />
                      <text text-anchor="middle" dy="3.5" style={{ fill: linkColor(l) }}>
                        {short}
                      </text>
                    </g>
                  )}
                  <g
                    transform={`translate(${mx} ${my})`}
                    class={`graph__label graph__label--full${dense && !selected ? ' graph__label--hover' : ''}`}
                  >
                    <rect
                      x={-label.length * 3.1 - 6}
                      y={-10}
                      width={label.length * 6.2 + 12}
                      height={20}
                      rx={10}
                    />
                    <text text-anchor="middle" dy="4" style={{ fill: linkColor(l) }}>
                      {label}
                    </text>
                  </g>
                </g>
              )
            })}
            {nodes.map((n) => {
              const p = pos[n.id]
              if (!p) return null
              const host = hostSet.has(n.id)
              const self = selfSet.has(n.id)
              const selected = selectedPeer.value === n.id
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: SVG node hit target
                <g
                  key={n.id}
                  class={`graph__node${selected ? ' graph__node--selected' : ''}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => {
                    selectedPeer.value = selected ? null : n.id
                  }}
                >
                  <title>{n.id}</title>
                  <circle
                    r={22}
                    class={`graph__dot${host ? ' graph__dot--host' : ''}${self ? ' graph__dot--self' : ''}`}
                  />
                  <text text-anchor="middle" dy="5" class="graph__initial">
                    {peerName(n.id).slice(0, 2).toUpperCase()}
                  </text>
                  {host && (
                    <g class="graph__host" transform="translate(14 -24)">
                      <rect x={-14} y={-9} width={28} height={16} rx={8} />
                      <text text-anchor="middle" dy="3">
                        host
                      </text>
                    </g>
                  )}
                  <text text-anchor="middle" y={40} class="graph__name">
                    {peerName(n.id)}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </Card>
      <aside class="side">
        <div class="stat-grid">
          <Stat label="Peers" value={nodes.length} tone="teal" />
          <Stat label="Links" value={links.length} />
          <Stat
            label="Avg RTT"
            value={avgRtt === undefined ? '—' : Math.round(avgRtt)}
            unit="ms"
            tone="violet"
          />
          <Stat label="Resumes" value={s.resumes} tone={s.resumes ? 'warning' : 'default'} />
        </div>
        <Card title="Paths">
          <div class="path-counts">
            {(['direct', 'turn', 'relay'] as PathType[]).map((p) => (
              <div key={p} class="path-counts__row">
                <PathBadge path={p} />
                <span class="bh-mono">{counts[p]}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Messages / s (last 60 s)">
          <Sparkline values={rate} width={260} height={48} label="Message rate" />
          <div class="bh-muted small">
            {s.messages.out.toLocaleString()} sent · {s.messages.in.toLocaleString()} received ·{' '}
            {formatBytes(s.messages.bytes)}
          </div>
        </Card>
        {selLink && (
          <Card
            title="Selected link"
            actions={
              <Button size="sm" onClick={() => (tab.value = 'connection')}>
                Details
              </Button>
            }
          >
            <div class="kv">
              <span>Peers</span>
              <span>
                {peerName(selLink.a)} ↔ {peerName(selLink.b)}
              </span>
              <span>State</span>
              <span>{selLink.state}</span>
              <span>Path</span>
              <span>{selLink.path ? <PathBadge path={selLink.path} /> : '—'}</span>
              <span>RTT</span>
              <span class="bh-mono">{ms(selLink.rttMs)}</span>
              <span>Bytes</span>
              <span class="bh-mono">{formatBytes(linkBytes(selLink).total)}</span>
              <span>Pair</span>
              <span class="bh-mono small">{selLink.candidatePair ?? '—'}</span>
            </div>
          </Card>
        )}
      </aside>
    </div>
  )
}
