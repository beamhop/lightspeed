/** @jsxImportSource preact */
import { colors } from '@beamhop/ui'
import { Async, useResource } from '../components/Async'
import { Chart } from '../components/Chart'
import { MascotMessage } from '../components/Mascot'
import { Badge, Button, Card, Link, PageHeader, ProgressBar, Stat } from '../components/ui'
import { api, stats } from '../ctx'
import { formatAgo, formatBps, formatBytes, formatDuration, formatNumber, percent } from '../format'
import { performWrite } from '../store'
import type { Alert } from '../types'

const LEVEL_TONE = { info: 'teal', warning: 'warn', critical: 'danger' } as const

export function Overview() {
  const res = useResource(() => api.overview.get(), [], 30_000)
  const live = stats.latest.value
  const o = res.data
  const nostr = live?.nostr ?? o?.nostr
  const turn = live?.turn ?? o?.turn
  const disk = live?.disk ?? o?.disk
  const uptime = live?.uptimeSec ?? o?.uptimeSec
  const series = stats.series.value
  const diskPct = disk ? percent(disk.usedBytes, disk.totalBytes) : 0

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={o?.version ? `Relay ${o.version}` : 'Live relay health'}
      />
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat
          label="Events/s"
          value={nostr ? nostr.eventsPerSec.toFixed(1) : '—'}
          hint={nostr ? `${formatNumber(nostr.events)} stored` : undefined}
        />
        <Stat label="Subscriptions" value={formatNumber(nostr?.subscriptions)} tone="violet" />
        <Stat label="Clients" value={formatNumber(nostr?.clients)} tone="violet" />
        <Stat label="TURN allocations" value={formatNumber(turn?.allocations)} />
        <Stat label="Relayed" value={formatBps(turn?.bps)} />
        <Stat
          label="Disk"
          value={disk ? `${diskPct.toFixed(0)}%` : '—'}
          tone={diskPct > 80 ? 'danger' : 'ok'}
          hint={
            disk ? `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)}` : undefined
          }
        />
        <Stat label="Uptime" value={formatDuration(uptime)} tone="ok" />
        <Stat
          label="Apps"
          value={formatNumber(o?.apps)}
          tone="violet"
          hint={o?.blobs ? `${formatBytes(o.blobs.bytes)} media` : undefined}
        />
      </div>
      {disk && (
        <div class="mb-4">
          <ProgressBar value={diskPct} />
        </div>
      )}

      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <Card title="Nostr events per second">
          <Chart
            data={[series[0], series[1]]}
            series={[
              {
                label: 'events/s',
                color: colors.teal,
                fill: true,
                value: (v) => (v == null ? '—' : v.toFixed(1)),
              },
            ]}
          />
        </Card>
        <Card title="TURN bandwidth">
          <Chart
            data={[series[0], series[2]]}
            series={[
              {
                label: 'Mbps',
                color: colors.violet,
                fill: true,
                value: (v) => (v == null ? '—' : `${v.toFixed(1)} Mbps`),
              },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Alerts"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void res.reload()}>
            Refresh
          </Button>
        }
      >
        <Async
          res={res}
          empty={(d) => d.alerts.filter((a) => !a.acknowledged).length === 0}
          emptyTitle="All quiet. No open alerts."
        >
          {(d) => (
            <ul class="space-y-2">
              {d.alerts
                .filter((a) => !a.acknowledged)
                .map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    onAck={() =>
                      res.mutate((x) => ({
                        ...x,
                        alerts: x.alerts.map((y) =>
                          y.id === a.id ? { ...y, acknowledged: true } : y,
                        ),
                      }))
                    }
                  />
                ))}
            </ul>
          )}
        </Async>
        {res.error && res.data ? (
          <MascotMessage compact state="angry" title="Refresh failed" />
        ) : null}
      </Card>
    </>
  )
}

function AlertRow({ alert: a, onAck }: { alert: Alert; onAck: () => void }) {
  const jump = a.target?.app
    ? `/apps/${a.target.app}`
    : a.target?.ip || a.target?.client
      ? `/turn?ip=${encodeURIComponent(a.target.ip ?? a.target.client ?? '')}`
      : null
  return (
    <li class="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border border-line p-3">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <Badge tone={LEVEL_TONE[a.level]}>{a.level}</Badge>
          <span class="text-xs text-muted">{formatAgo(a.createdAt)}</span>
        </div>
        <div class="text-sm">{a.message}</div>
      </div>
      <div class="flex gap-2">
        {jump && (
          <Link
            to={jump}
            class="inline-flex items-center rounded-md px-2.5 py-1.5 text-xs bg-raised border border-line hover:border-teal/60"
          >
            {a.target?.app ? 'Open app' : 'Inspect client'}
          </Link>
        )}
        <Button
          size="sm"
          onClick={async () => {
            const r = await performWrite({
              title: 'Acknowledge alert',
              action: 'Acknowledge',
              scope: [`Alert ${a.code}: ${a.message}`, 'Hides it from the overview for all admins'],
              run: () => api.overview.ackAlert(a.id),
              success: 'Alert acknowledged',
            })
            if (r.ok) onAck()
          }}
        >
          Acknowledge
        </Button>
      </div>
    </li>
  )
}
