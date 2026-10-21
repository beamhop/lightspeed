/** @jsxImportSource preact */
import { colors } from '@beamhop/ui'
import { useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import { Chart } from '../components/Chart'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  Stat,
} from '../components/ui'
import { api, stats } from '../ctx'
import { formatAgo, formatBps, formatBytes, formatDuration, isIp, shortHex } from '../format'
import { PAGE_HELP } from '../help'
import { currentQuery } from '../router'
import { performWrite } from '../store'
import type { Allocation } from '../types'

export function Turn() {
  const ipFilter = currentQuery.value.get('ip') ?? ''
  const [filter, setFilter] = useState(ipFilter)
  const allocs = useResource(() => api.turn.allocations(), [], 3000)
  const live = stats.latest.value
  const series = stats.series.value

  const kill = async (a: Allocation) => {
    const r = await performWrite({
      title: 'Kill TURN allocation',
      action: 'Kill allocation',
      danger: true,
      scope: [
        `Allocation ${shortHex(a.id, 12, 4)} (${a.transport.toUpperCase()})`,
        `Client ${a.client} → relayed ${a.relayed}`,
        `App ${a.appId ?? 'unknown'}, user ${shortHex(a.username, 20, 6)}`,
        'The peer connection drops; the client may re-allocate with valid credentials',
      ],
      run: () => api.turn.kill(a.id),
      success: 'Allocation killed',
    })
    if (r.ok) allocs.mutate((l) => l.filter((x) => x.id !== a.id))
  }

  const match = (a: Allocation) =>
    !filter ||
    a.client.includes(filter) ||
    a.username.includes(filter) ||
    (a.appId ?? '').includes(filter)

  return (
    <>
      <PageHeader
        title="TURN"
        subtitle="Allocations, bandwidth and IP bans"
        intro={PAGE_HELP.turn}
      />
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat
          label="Allocations"
          value={live?.turn.allocations ?? allocs.data?.length ?? '—'}
          help="Active TURN relay sessions right now. One peer in a call that cannot connect directly usually holds one allocation."
        />
        <Stat
          label="Relayed now"
          value={formatBps(live?.turn.bps)}
          tone="violet"
          help="Current bandwidth through TURN, both directions. Compare it with your server’s uplink and your hosting plan’s transfer allowance."
        />
        <Stat
          label="Bytes in (listed)"
          help="Total received from clients by the allocations listed below since each one started. Closed allocations are not counted."
          value={formatBytes(allocs.data?.reduce((s, a) => s + a.bytesIn, 0))}
        />
        <Stat
          label="Bytes out (listed)"
          help="Total sent to clients by the allocations listed below since each one started."
          value={formatBytes(allocs.data?.reduce((s, a) => s + a.bytesOut, 0))}
        />
      </div>
      <Card
        title="Bandwidth"
        class="mb-4"
        description="Relayed megabits per second and the number of allocations over the last few minutes. Bandwidth rising faster than allocations means some sessions are unusually heavy (for example HD video)."
      >
        <Chart
          data={[series[0], series[2], series[3]]}
          series={[
            {
              label: 'Mbps',
              color: colors.violet,
              fill: true,
              value: (v) => (v == null ? '—' : `${v.toFixed(1)} Mbps`),
            },
            {
              label: 'allocations',
              color: colors.teal,
              value: (v) => (v == null ? '—' : String(v)),
            },
          ]}
        />
      </Card>
      <Card
        title="Allocations"
        class="mb-4"
        description="Each row is one client’s relay session. Killing one drops that peer’s relayed connection right away; a legitimate client will usually reconnect, so to stop abuse also ban the IP or rotate the app’s TURN secret."
        actions={
          <Input
            value={filter}
            onValue={setFilter}
            placeholder="Filter by IP, user or app"
            class="!min-h-8 !py-1 w-56"
            type="search"
          />
        }
      >
        <Async res={allocs} emptyTitle="No active allocations">
          {(list) => {
            const rows = list.filter(match)
            return rows.length ? (
              <DataTable
                rows={rows}
                rowKey={(a) => a.id}
                columns={[
                  {
                    key: 'app',
                    label: 'App',
                    help: 'The app whose TURN credentials were used to open this allocation.',
                    render: (a) => <Mono>{shortHex(a.appId ?? '—', 8, 0)}</Mono>,
                  },
                  {
                    key: 'user',
                    label: 'User',
                    help: 'The peer part of the TURN REST username (expiry:appId:peer) your backend minted.',
                    render: (a) => (
                      <Mono>{shortHex(a.username.split(':').pop() ?? a.username, 8, 4)}</Mono>
                    ),
                    hideOnMobile: true,
                  },
                  {
                    key: 'tx',
                    label: 'Transport',
                    help: 'How the client reaches TURN: UDP is fastest; TCP and TLS are fallbacks for networks that block UDP.',
                    render: (a) => (
                      <Badge tone={a.transport === 'udp' ? 'teal' : 'violet'}>
                        {a.transport.toUpperCase()}
                      </Badge>
                    ),
                  },
                  {
                    key: 'client',
                    label: 'Client',
                    help: 'The client’s public IP and port as seen by the relay. Use it to ban an abusive address.',
                    render: (a) => <Mono>{a.client}</Mono>,
                  },
                  {
                    key: 'relayed',
                    label: 'Relayed',
                    help: 'The address and port this server opened on the client’s behalf. The other peer sends to this address.',
                    render: (a) => <Mono>{a.relayed}</Mono>,
                    hideOnMobile: true,
                  },
                  {
                    key: 'bytes',
                    label: 'In / out',
                    help: 'Bytes received from and sent to this client since the allocation opened.',
                    render: (a) => `${formatBytes(a.bytesIn)} / ${formatBytes(a.bytesOut)}`,
                  },
                  { key: 'age', label: 'Age', render: (a) => formatAgo(a.createdAt) },
                ]}
                actions={(a) => (
                  <Button size="sm" variant="danger" onClick={() => kill(a)}>
                    Kill
                  </Button>
                )}
              />
            ) : (
              <p class="text-sm text-muted py-4 text-center">No allocations match “{filter}”.</p>
            )
          }}
        </Async>
      </Card>
      <Bans initialIp={ipFilter} />
    </>
  )
}

const DURATIONS = [
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '1 day' },
  { value: '604800', label: '7 days' },
  { value: '0', label: 'Permanent' },
]

function Bans({ initialIp }: { initialIp: string }) {
  const res = useResource(() => api.bans.list(), [])
  const [ip, setIp] = useState(initialIp)
  const [reason, setReason] = useState('')
  const [dur, setDur] = useState('86400')
  const valid = isIp(ip)

  const add = async (e: Event) => {
    e.preventDefault()
    const durationSec = Number(dur) || null
    const r = await performWrite({
      title: 'Ban IP address',
      action: 'Ban IP',
      danger: true,
      scope: [
        `${ip.trim()}${ip.includes('/') ? ' (CIDR range)' : ''}`,
        'Blocked on every listener: Nostr, TURN, Blossom and admin',
        `Duration: ${durationSec ? formatDuration(durationSec) : 'permanent'}`,
        'Open connections from this address are closed',
      ],
      run: () => api.bans.add({ ip: ip.trim(), reason: reason.trim() || undefined, durationSec }),
      success: `Banned ${ip.trim()}`,
    })
    if (r.ok) {
      setIp('')
      setReason('')
      void res.reload()
    }
  }

  return (
    <Card
      title="IP bans"
      description="Block an IP address or a whole range (CIDR, e.g. 203.0.113.0/24) from every listener: Nostr, TURN, media and this admin UI. Use a timed ban for a short burst of abuse and a permanent one for known bad actors. Be careful not to ban your own address."
    >
      <form class="grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto] items-end mb-4" onSubmit={add}>
        <Field
          label="IP or CIDR"
          error={ip && !valid ? 'Not an IP address' : null}
          help="A single IPv4/IPv6 address, or a range in CIDR notation. /24 covers 256 IPv4 addresses; use ranges when an attacker hops between neighbouring addresses."
        >
          <Input value={ip} onValue={setIp} placeholder="203.0.113.7 or 203.0.113.0/24" />
        </Field>
        <Field
          label="Reason"
          help="A note for other admins explaining why; shown in the list and the audit log."
        >
          <Input value={reason} onValue={setReason} placeholder="optional" />
        </Field>
        <Field
          label="Duration"
          help="The ban lifts automatically after this time. Permanent bans stay until someone clicks Unban."
        >
          <Select value={dur} options={DURATIONS} onValue={setDur} />
        </Field>
        <Button type="submit" variant="danger" disabled={!valid}>
          Ban
        </Button>
      </form>
      <Async res={res} emptyTitle="No bans">
        {(bans) => (
          <DataTable
            rows={bans}
            rowKey={(b) => b.id}
            columns={[
              { key: 'ip', label: 'IP', render: (b) => <Mono>{b.ip}</Mono> },
              { key: 'reason', label: 'Reason', render: (b) => b.reason ?? '—' },
              { key: 'since', label: 'Since', render: (b) => formatAgo(b.createdAt) },
              {
                key: 'exp',
                label: 'Expires',
                render: (b) =>
                  b.expiresAt ? formatAgo(b.expiresAt) : <Badge tone="danger">never</Badge>,
              },
            ]}
            actions={(b) => (
              <Button
                size="sm"
                onClick={async () => {
                  const r = await performWrite({
                    title: 'Lift ban',
                    action: 'Unban',
                    scope: [
                      `${b.ip}`,
                      'Connections from this address are accepted again on every listener',
                    ],
                    run: () => api.bans.remove(b.id),
                    success: `Unbanned ${b.ip}`,
                  })
                  if (r.ok) res.mutate((l) => l.filter((x) => x.id !== b.id))
                }}
              >
                Unban
              </Button>
            )}
          />
        )}
      </Async>
    </Card>
  )
}
