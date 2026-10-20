/** @jsxImportSource preact */
import {
  Badge,
  Card,
  EmptyState,
  formatBytes,
  PathBadge,
  Select,
  Sparkline,
  Stat,
  Table,
} from '@beamhop/ui'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { connectionHistory, connectionPairs, type StateTransition } from '../../model/connection'
import type { ConnectionInfo } from '../../room-adapter'
import { ms, offset } from '../format'
import { events, live, peerName, range, room, selectedLink, viewTime } from '../store'

const STATES = ['new', 'connecting', 'connected', 'away', 'disconnected', 'closed'] as const

export function ConnectionView() {
  const all = events.value
  const pairs = useMemo(() => connectionPairs(all), [all.length])
  const sel = selectedLink.value ?? pairs[0] ?? null
  const until = live.value ? Number.POSITIVE_INFINITY : viewTime.value
  const h = useMemo(
    () => (sel ? connectionHistory(all, sel.source, sel.peer, until) : null),
    [all, sel?.source, sel?.peer, until],
  )
  const [info, setInfo] = useState<ConnectionInfo | null>(null)
  const r = room.value

  useEffect(() => {
    if (!sel || !r?.capabilities.connectionInfo) {
      setInfo(null)
      return
    }
    const poll = () => setInfo(r.connectionInfo(sel.source, sel.peer))
    poll()
    const id = setInterval(poll, 500)
    return () => clearInterval(id)
  }, [r, sel?.source, sel?.peer])

  if (!sel || !h) {
    return (
      <EmptyState
        mascot="idle"
        title="No connections yet"
        description="Connection telemetry appears once peers start the handshake."
      />
    )
  }
  const start = range.value?.start ?? 0
  const visited = new Map<string, number>()
  for (const tr of h.transitions) visited.set(tr.to, (visited.get(tr.to) ?? 0) + 1)
  const bytes = Object.values(h.channels).reduce((acc, c) => acc + c.sent + c.received, 0)
  const lastPath = h.paths.at(-1)

  return (
    <div class="connection">
      <Card
        title="Connection"
        actions={
          <Select
            value={`${sel.source}>${sel.peer}`}
            options={pairs.map((p) => ({
              value: `${p.source}>${p.peer}`,
              label: `${peerName(p.source)} → ${peerName(p.peer)}`,
            }))}
            onValue={(v) => {
              const [source, peer] = v.split('>') as [string, string]
              selectedLink.value = { source, peer }
            }}
          />
        }
      >
        <div class="conn-head">
          <div>
            <div class="conn-head__peers">
              {peerName(h.source)} <span class="bh-muted">sees</span> {peerName(h.peer)}
            </div>
            <div class="conn-head__badges">
              <Badge
                tone={
                  h.current === 'connected'
                    ? 'success'
                    : h.current === 'away'
                      ? 'warning'
                      : h.current === 'connecting'
                        ? 'neutral'
                        : 'danger'
                }
                dot
              >
                {h.current}
              </Badge>
              {lastPath && <PathBadge path={lastPath.path} />}
            </div>
          </div>
          <div class="stat-grid stat-grid--4">
            <Stat
              label="RTT"
              value={h.rtt.at(-1)?.ms ?? '—'}
              unit="ms"
              trend={h.rtt.slice(-40).map((x) => x.ms)}
              tone="violet"
            />
            <Stat label="Bytes" value={formatBytes(bytes)} />
            <Stat
              label="Msgs out / in"
              value={`${h.messages.out} / ${h.messages.in}`}
              tone="teal"
            />
            <Stat
              label="Resumes"
              value={h.resumes.length}
              tone={h.resumes.length ? 'warning' : 'default'}
            />
          </div>
        </div>
        <svg class="fsm" viewBox="0 0 720 70" role="img" aria-label="Connection state machine">
          {STATES.map((st, i) => {
            const x = 20 + i * 120
            const n = st === 'new' ? 1 : (visited.get(st) ?? 0)
            const current = h.current === st
            return (
              <g key={st} transform={`translate(${x} 20)`}>
                {i < STATES.length - 1 && (
                  <line x1={92} y1={15} x2={120} y2={15} class="fsm__edge" />
                )}
                <rect
                  width={92}
                  height={30}
                  rx={15}
                  class={`fsm__state${n ? ' fsm__state--visited' : ''}${current ? ' fsm__state--current' : ''}`}
                />
                <text x={46} y={19} text-anchor="middle">
                  {st}
                  {n > 1 ? ` ×${n}` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      </Card>
      <div class="connection__grid">
        <Card title="State history" flush>
          <Table<StateTransition & { i: number }>
            dense
            rows={h.transitions.map((t, i) => ({ ...t, i })).reverse()}
            rowKey={(t) => t.i}
            columns={[
              { key: 'at', header: 'Time', mono: true, render: (t) => offset(t.at, start) },
              { key: 'from', header: 'From', render: (t) => t.from },
              { key: 'to', header: 'To', render: (t) => <strong>{t.raw}</strong> },
              {
                key: 'path',
                header: 'Path',
                render: (t) => (t.path ? <PathBadge path={t.path} /> : ''),
              },
            ]}
          />
        </Card>
        <Card title="Candidate pairs" flush>
          {info ? (
            <Table
              dense
              rows={info.candidatePairs}
              rowKey={(c) => `${c.local}|${c.remote}`}
              columns={[
                { key: 'local', header: 'Local', mono: true, render: (c) => c.local },
                { key: 'remote', header: 'Remote', mono: true, render: (c) => c.remote },
                { key: 'path', header: 'Path', render: (c) => <PathBadge path={c.path} /> },
                {
                  key: 'state',
                  header: 'State',
                  render: (c) => (
                    <Badge
                      tone={
                        c.state === 'succeeded'
                          ? 'success'
                          : c.state === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {c.nominated ? '★ ' : ''}
                      {c.state}
                    </Badge>
                  ),
                },
                {
                  key: 'rtt',
                  header: 'RTT',
                  mono: true,
                  align: 'right',
                  render: (c) => ms(c.rttMs),
                },
              ]}
            />
          ) : (
            <div class="pad bh-muted">
              {h.paths.length
                ? h.paths.map((p) => (
                    <div key={`${p.at}-${p.path}`} class="bh-mono small">
                      {offset(p.at, start)} {p.path} {p.candidatePair ?? ''}
                    </div>
                  ))
                : 'No candidate data from this attach mode.'}
            </div>
          )}
        </Card>
        <Card title="Channels" flush>
          <div class="pad">
            {(
              info?.channels ??
              Object.keys(h.channels).map((label) => ({
                label,
                bufferedAmount: 0,
                bufferedAmountLowThreshold: 0,
                readyState: 'open',
                reliability: '—',
              }))
            ).map((c) => {
              const counters = h.channels[c.label]
              const pct = c.bufferedAmountLowThreshold
                ? Math.min(100, (c.bufferedAmount / (c.bufferedAmountLowThreshold * 4)) * 100)
                : 0
              return (
                <div key={c.label} class="channel">
                  <div class="channel__head">
                    <span class="bh-mono">{c.label}</span>
                    <span class="bh-muted small">
                      {c.reliability} · {c.readyState}
                    </span>
                  </div>
                  <div class="meter" title={`buffered ${formatBytes(c.bufferedAmount)}`}>
                    <div
                      class={`meter__fill${c.bufferedAmount > c.bufferedAmountLowThreshold ? ' meter__fill--hot' : ''}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div class="bh-muted small bh-mono">
                    buffered {formatBytes(c.bufferedAmount)} · sent{' '}
                    {formatBytes(counters?.sent ?? 0)} · recv {formatBytes(counters?.received ?? 0)}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
        <Card title="Resume history" flush>
          {h.resumes.length ? (
            <Table
              dense
              rows={[...h.resumes].reverse()}
              rowKey={(r) => r.awayAt}
              columns={[
                {
                  key: 'away',
                  header: 'Away at',
                  mono: true,
                  render: (r) => offset(r.awayAt, start),
                },
                {
                  key: 'back',
                  header: 'Back at',
                  mono: true,
                  render: (r) => (r.backAt ? offset(r.backAt, start) : 'still away'),
                },
                {
                  key: 'gap',
                  header: 'Gap',
                  mono: true,
                  align: 'right',
                  render: (r) => ms(r.gapMs),
                },
              ]}
            />
          ) : (
            <div class="pad bh-muted">No away/back gaps — the session never dropped.</div>
          )}
          <div class="pad">
            <Sparkline
              values={h.rtt.slice(-120).map((x) => x.ms)}
              width={300}
              height={40}
              color="var(--bh-violet)"
              label="RTT history"
            />
          </div>
        </Card>
      </div>
    </div>
  )
}
