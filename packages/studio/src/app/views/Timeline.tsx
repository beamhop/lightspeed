/** @jsxImportSource preact */
import { Card, Select } from '@beamhop/ui'
import { useMemo, useState } from 'preact/hooks'
import { buildTracks, type Lane, type TimelineItem } from '../../model/timeline'
import { offset } from '../format'
import { events, knownPeers, peerName, range, scrubTo, selectedPeer, viewTime } from '../store'

const LANES: { id: Lane; label: string }[] = [
  { id: 'signal', label: 'Signaling' },
  { id: 'connection', label: 'Connection' },
  { id: 'message', label: 'Messages' },
]
const WINDOWS = [
  { value: '10000', label: '10 s' },
  { value: '30000', label: '30 s' },
  { value: '120000', label: '2 min' },
  { value: '600000', label: '10 min' },
]
const W = 1000
const LANE_H = 54
const TOP = 26

const TONE: Record<TimelineItem['tone'], string> = {
  teal: 'var(--bh-teal)',
  violet: 'var(--bh-violet)',
  warning: 'var(--bh-warning)',
  danger: 'var(--bh-danger)',
  success: 'var(--bh-success)',
  muted: 'var(--bh-text-muted)',
}

export function TimelineView() {
  const [win, setWin] = useState('30000')
  const t = viewTime.value
  const span = Number(win)
  const from = t - span * 0.85
  const to = from + span
  const peer = selectedPeer.value ?? ''
  const all = events.value
  const tracks = useMemo(
    () => buildTracks(all, { peer: peer || undefined, from, to }),
    [all, peer, from, to],
  )
  const start = range.value?.start ?? 0
  const x = (at: number) => ((at - from) / span) * W
  const height = TOP + LANES.length * LANE_H + 8

  const ticks: number[] = []
  const step = span <= 10_000 ? 1000 : span <= 30_000 ? 5000 : span <= 120_000 ? 15_000 : 60_000
  // ticks aligned to the session start so labels read +5s, +10s, …
  for (let v = start + Math.ceil((from - start) / step) * step; v <= to; v += step) {
    if (v >= start) ticks.push(v)
  }

  const recent = [...tracks.connection, ...tracks.signal, ...tracks.message]
    .filter((i) => i.at <= t)
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .slice(0, 14)

  return (
    <div class="timeline">
      <Card
        title="Timeline"
        flush
        actions={
          <div class="filters filters--inline">
            <Select
              value={peer}
              options={[
                { value: '', label: 'All peers' },
                ...knownPeers.value.map((p) => ({
                  value: p,
                  label: `as seen by / with ${peerName(p)}`,
                })),
              ]}
              onValue={(v) => {
                selectedPeer.value = v || null
              }}
            />
            <Select value={win} options={WINDOWS} onValue={setWin} />
          </div>
        }
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the scrubber below is the keyboard path */}
        <svg
          class="tl"
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label="Event timeline; click to replay that instant"
          onClick={(e) => {
            const svg = e.currentTarget as SVGSVGElement
            const rect = svg.getBoundingClientRect()
            const at = from + ((e.clientX - rect.left) / rect.width) * span
            scrubTo(Math.max(range.value?.start ?? at, Math.min(range.value?.end ?? at, at)))
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1={TOP - 6} y2={height} class="tl__grid" />
              <text x={x(v) + 3} y={14} class="tl__tick">
                {offset(v, start)}
              </text>
            </g>
          ))}
          {LANES.map((lane, li) => {
            const y = TOP + li * LANE_H
            const items = tracks[lane.id]
            return (
              <g key={lane.id}>
                <rect x={0} y={y} width={W} height={LANE_H - 6} class="tl__lane" />
                <text x={6} y={y + 14} class="tl__lane-label">
                  {lane.label} · {items.length}
                </text>
                {items.map((it, i) => (
                  <rect
                    key={it.seq}
                    x={x(it.at) - 1.5}
                    y={y + 20 + (i % 3) * 8}
                    width={3}
                    height={lane.id === 'connection' ? 22 : 8}
                    rx={1.5}
                    style={{ fill: TONE[it.tone] }}
                    opacity={it.at > t ? 0.25 : 0.95}
                  >
                    <title>
                      {offset(it.at, start)} {peerName(it.source)}
                      {it.peer ? ` ↔ ${peerName(it.peer)}` : ''}: {it.label}
                    </title>
                  </rect>
                ))}
              </g>
            )
          })}
          <line x1={x(t)} x2={x(t)} y1={TOP - 8} y2={height} class="tl__cursor" />
        </svg>
      </Card>
      <Card title="At the cursor" flush>
        <ul class="event-list">
          {recent.map((it) => (
            <li key={it.seq}>
              <span class="bh-mono bh-muted">{offset(it.at, start)}</span>
              <span class="dot" style={{ background: TONE[it.tone] }} />
              <span>
                <strong>{peerName(it.source)}</strong>
                {it.peer ? ` ↔ ${peerName(it.peer)}` : ''}
              </span>
              <span class="bh-mono">{it.label}</span>
            </li>
          ))}
          {recent.length === 0 && <li class="bh-muted">Nothing in this window.</li>}
        </ul>
      </Card>
    </div>
  )
}
