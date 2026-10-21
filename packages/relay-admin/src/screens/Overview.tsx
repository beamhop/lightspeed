import { colors } from '@beamhop/ui'
import { useValue } from '@/lib/signals'
import { Async, useResource } from '../components/Async'
import { Chart } from '../components/Chart'
import { MascotMessage } from '../components/Mascot'
import { Badge, Button, Card, Link, PageHeader, ProgressBar, Stat } from '../components/ui'
import { api, stats } from '../ctx'
import { formatAgo, formatBps, formatBytes, formatDuration, formatNumber, percent } from '../format'
import { PAGE_HELP } from '../help'
import { performWrite } from '../store'
import type { Alert } from '../types'

const LEVEL_TONE = { info: 'teal', warning: 'warn', critical: 'danger' } as const

export function Overview() {
  const res = useResource(() => api.overview.get(), [], 30_000)
  const live = useValue(stats.latest)
  const o = res.data
  const nostr = live?.nostr ?? o?.nostr
  const turn = live?.turn ?? o?.turn
  const disk = live?.disk ?? o?.disk
  const uptime = live?.uptimeSec ?? o?.uptimeSec
  const series = useValue(stats.series)
  const diskPct = disk ? percent(disk.usedBytes, disk.totalBytes) : 0

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={o?.version ? `Relay ${o.version} · live relay health` : 'Live relay health'}
        intro={PAGE_HELP.overview}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Events/s"
          value={nostr ? nostr.eventsPerSec.toFixed(1) : '—'}
          hint={nostr ? `${formatNumber(nostr.events)} stored` : undefined}
          help="Nostr events accepted per second across the public relay and every app realm. The small number is the total stored in the database. A sudden spike with no matching user growth usually means spam or a misbehaving client."
        />
        <Stat
          label="Subscriptions"
          value={formatNumber(nostr?.subscriptions)}
          tone="violet"
          help="Open REQ subscriptions: standing queries clients keep open to receive new events. Each client usually holds a few. Many per client can indicate a buggy app; see Nostr → Live subscriptions."
        />
        <Stat
          label="Clients"
          value={formatNumber(nostr?.clients)}
          tone="violet"
          help="WebSocket connections currently open to the Nostr relay (public and app realms). Roughly the number of people or devices online right now."
        />
        <Stat
          label="TURN allocations"
          value={formatNumber(turn?.allocations)}
          help="Active TURN relay sessions. Each one is a peer whose connection could not go direct and is being relayed through this server. Details and controls are on the TURN page."
        />
        <Stat
          label="Relayed"
          value={formatBps(turn?.bps)}
          help="Bandwidth currently flowing through TURN, in and out combined. This is usually your largest hosting cost; cap it per app on the app’s Quotas tab."
        />
        <Stat
          label="Disk"
          value={disk ? `${diskPct.toFixed(0)}%` : '—'}
          tone={diskPct > 80 ? 'danger' : 'ok'}
          help="Disk used on the volume holding the databases and media. Above 80% it turns red: add retention rules (Nostr → Retention), delete media or grow the disk before it fills, because a full disk stops the relay from accepting events."
          hint={
            disk ? `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)}` : undefined
          }
        />
        <Stat
          label="Uptime"
          value={formatDuration(uptime)}
          tone="ok"
          help="Time since the relay process last started. Resets after a restart, upgrade or crash; an unexpected reset is worth checking in the logs."
        />
        <Stat
          label="Apps"
          value={formatNumber(o?.apps)}
          tone="violet"
          hint={o?.blobs ? `${formatBytes(o.blobs.bytes)} media` : undefined}
          help="Number of apps registered on this relay, and the total size of media they have uploaded. Manage them on the Apps page."
        />
      </div>
      {disk && (
        <div>
          <ProgressBar value={diskPct} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Nostr events per second"
          description="Rate of accepted events over the last few minutes. Hover the chart to read exact values."
        >
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
        <Card
          title="TURN bandwidth"
          description="Megabits per second relayed by TURN over the last few minutes."
        >
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
        description="Problems the relay detected on its own, such as quota overruns, abusive clients or low disk. Jump to the source to fix it, then acknowledge to clear it for every admin."
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
            <ul className="space-y-2">
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
    <li className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border border-border p-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <Badge tone={LEVEL_TONE[a.level]}>{a.level}</Badge>
          <span className="text-xs text-muted-foreground">{formatAgo(a.createdAt)}</span>
        </div>
        <div className="text-sm">{a.message}</div>
      </div>
      <div className="flex gap-2">
        {jump && (
          <Link
            to={jump}
            className="inline-flex items-center rounded-md px-2.5 py-1.5 text-xs bg-muted border border-border hover:border-primary/60"
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
