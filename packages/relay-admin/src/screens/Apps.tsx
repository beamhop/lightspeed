/** @jsxImportSource preact */
import { colors } from '@beamhop/ui'
import { useEffect, useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import { Chart } from '../components/Chart'
import { PolicyEditor } from '../components/PolicyEditor'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  InfoTip,
  Input,
  Link,
  Modal,
  Mono,
  PageHeader,
  Stat,
  Tabs,
  Toggle,
} from '../components/ui'
import { api } from '../ctx'
import { formatAgo, formatBytes, formatDate, formatNumber, toCsv } from '../format'
import { PAGE_HELP } from '../help'
import { currentQuery, navigate } from '../router'
import { performWrite, revealOnce, toast } from '../store'
import type { App, AppQuotas, AppUsage } from '../types'

export function AppsList() {
  const res = useResource(() => api.apps.list(), [])
  const [creating, setCreating] = useState(false)
  return (
    <>
      <PageHeader
        title="Apps"
        subtitle="Realms with their own TURN secret, API key, quotas and policy"
        intro={PAGE_HELP.apps}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New app
          </Button>
        }
      />
      <Card pad={false}>
        <div class="p-3 md:p-4">
          <Async res={res} emptyTitle="No apps yet. Create the first one.">
            {(apps) => (
              <DataTable
                rows={apps}
                rowKey={(a) => a.id}
                onRowClick={(a) => navigate(`/apps/${a.id}`)}
                columns={[
                  {
                    key: 'name',
                    label: 'Name',
                    render: (a) => <span class="font-medium">{a.name}</span>,
                  },
                  {
                    key: 'id',
                    label: 'ID',
                    help: 'The App ID your client passes to the Beamhop library. It also appears in the realm URLs (/a/<id>).',
                    render: (a) => <Mono class="text-muted">{a.id}</Mono>,
                  },
                  {
                    key: 'status',
                    label: 'Status',
                    help: 'Disabled apps keep their data but all their Nostr, TURN and data-relay traffic is refused.',
                    render: (a) => (
                      <Badge tone={a.enabled ? 'ok' : 'muted'}>
                        {a.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    ),
                  },
                  {
                    key: 'plan',
                    label: 'Plan',
                    help: 'The payment plan attached to this app, if any.',
                    render: (a) => a.plan ?? '—',
                    hideOnMobile: true,
                  },
                  {
                    key: 'usage',
                    label: 'Traffic (month)',
                    help: 'Relayed bytes (TURN and data relay) this calendar month.',
                    render: (a) => formatBytes(a.usage?.bytesMonth),
                  },
                  {
                    key: 'created',
                    label: 'Created',
                    render: (a) => formatAgo(a.createdAt),
                    hideOnMobile: true,
                  },
                ]}
              />
            )}
          </Async>
        </div>
      </Card>
      <CreateAppModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          void res.reload()
          navigate(`/apps/${id}`)
        }}
      />
    </>
  )
}

function CreateAppModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
    }
  }, [open])
  const submit = async () => {
    onClose()
    const r = await performWrite({
      title: 'Create app',
      action: 'Create app',
      scope: [
        `New realm “${name.trim()}”`,
        'Generates a TURN secret and an API key (shown once)',
        'Opens wss://<relay>/a/<id> and its data relay',
      ],
      run: () =>
        api.apps.create({ name: name.trim(), description: description.trim() || undefined }),
      success: (a) => `Created ${a.name}`,
    })
    if (r.ok) {
      revealOnce({
        title: `Secrets for ${r.value.name}`,
        secrets: [
          { label: 'App ID', value: r.value.id },
          { label: 'TURN secret', value: r.value.turnSecret },
          { label: 'API key', value: r.value.apiKey },
        ],
      })
      onCreated(r.value.id)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New app"
      description="Creates a private realm for one product. You get an App ID, a TURN secret and an API key; the secrets are shown only once, so have somewhere safe to paste them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <Field label="Name" hint="Shown to admins only. You can tell apps apart by it.">
          <Input value={name} onValue={setName} placeholder="My multiplayer game" autoFocus />
        </Field>
        <Field label="Description" hint="Optional note, e.g. the team or repository that owns it.">
          <Input value={description} onValue={setDescription} placeholder="optional" />
        </Field>
      </div>
    </Modal>
  )
}

type DetailTab = 'keys' | 'quotas' | 'policy' | 'usage'

export function AppDetail({ id }: { id: string }) {
  const res = useResource(() => api.apps.get(id), [id])
  const tab = (currentQuery.value.get('tab') as DetailTab) || 'keys'
  return (
    <Async res={res}>
      {(app) => (
        <>
          <div class="text-xs text-muted mb-1">
            <Link to="/apps" class="hover:text-ink">
              Apps
            </Link>{' '}
            / {app.name}
          </div>
          <PageHeader
            title={app.name}
            subtitle={<Mono>{app.id}</Mono>}
            intro={PAGE_HELP.app}
            actions={
              <>
                <Toggle
                  label={app.enabled ? 'Enabled' : 'Disabled'}
                  help="Switch off to stop all of this app’s traffic at once (for example during abuse or non-payment) without losing keys, policy or history. Switch on to resume."
                  checked={app.enabled}
                  onChange={async (v) => {
                    const r = await performWrite({
                      title: v ? 'Enable app' : 'Disable app',
                      action: v ? 'Enable' : 'Disable',
                      danger: !v,
                      scope: [
                        `App “${app.name}” (${app.id})`,
                        v
                          ? 'Accepts Nostr, TURN and data-relay traffic again'
                          : 'Rejects new TURN credentials, realm events and data-relay sessions; open sessions are closed',
                      ],
                      run: () => api.apps.update(app.id, { enabled: v }),
                    })
                    if (r.ok) res.mutate((a) => ({ ...a, enabled: v }))
                  }}
                />
                <Button
                  variant="danger"
                  onClick={async () => {
                    const r = await performWrite({
                      title: 'Delete app',
                      action: 'Delete app',
                      danger: true,
                      typeToConfirm: app.name,
                      scope: [
                        `App “${app.name}” (${app.id})`,
                        'Its TURN secret and API key stop working immediately',
                        'Realm events, policy, quotas and usage history are deleted',
                        'Cannot be undone',
                      ],
                      run: () => api.apps.remove(app.id),
                      success: `Deleted ${app.name}`,
                    })
                    if (r.ok) navigate('/apps')
                  }}
                >
                  Delete
                </Button>
              </>
            }
          />
          <Tabs<DetailTab>
            value={tab}
            onChange={(t) => navigate(`/apps/${app.id}?tab=${t}`, { replace: true })}
            tabs={[
              {
                id: 'keys',
                label: 'Keys',
                description:
                  'The secrets and URLs an integration needs. Secrets are never shown again after creation; if one is lost or leaked, rotate it and update your backend.',
              },
              {
                id: 'quotas',
                label: 'Quotas',
                description:
                  'Limits for this app. When a count or size limit is reached, new TURN allocations or uploads are refused; the bandwidth cap slows traffic down instead. 0 means unlimited.',
              },
              {
                id: 'policy',
                label: 'Policy',
                description:
                  'Rules for events published to this app’s realm (wss://<host>/a/<id>). They are independent of the public relay policy on the Nostr page.',
              },
              {
                id: 'usage',
                label: 'Usage',
                description:
                  'What this app consumed over the last 30 days. Export the CSV to bill a customer or to size quotas.',
              },
            ]}
          />
          <div class="pt-4">
            {tab === 'keys' && <Keys app={app} onChange={(a) => res.mutate(() => a)} />}
            {tab === 'quotas' && <Quotas app={app} onSaved={(a) => res.mutate(() => a)} />}
            {tab === 'policy' && <PolicyEditor realm={app.id} />}
            {tab === 'usage' && <Usage app={app} />}
          </div>
        </>
      )}
    </Async>
  )
}

function Keys({ app, onChange }: { app: App; onChange: (a: App) => void }) {
  const rotate = async (kind: 'turn' | 'api') => {
    const label = kind === 'turn' ? 'TURN secret' : 'API key'
    const r = await performWrite({
      title: `Rotate ${label}`,
      action: `Rotate ${label}`,
      danger: true,
      scope: [
        `App “${app.name}” (${app.id})`,
        kind === 'turn'
          ? 'The old secret stops validating new TURN REST credentials; existing allocations run until they expire'
          : 'Backends using the old key get 401 from /a/<id>/turn-credentials until updated',
        'The new value is shown once',
      ],
      run: async () =>
        kind === 'turn'
          ? (await api.apps.rotateTurnSecret(app.id)).turnSecret
          : (await api.apps.rotateApiKey(app.id)).apiKey,
      success: `${label} rotated`,
    })
    if (r.ok) {
      revealOnce({ title: `New ${label} for ${app.name}`, secrets: [{ label, value: r.value }] })
      onChange({
        ...app,
        ...(kind === 'turn'
          ? { turnSecretHint: `…${r.value.slice(-4)}` }
          : { apiKeyHint: `…${r.value.slice(-4)}` }),
      })
    }
  }
  const relay = typeof location !== 'undefined' ? location.host : 'relay'
  return (
    <div class="grid md:grid-cols-2 gap-4">
      <Card
        title="Secrets"
        description="Only the last characters are shown. Rotating issues a new value (shown once) and invalidates the old one."
      >
        <dl class="space-y-3 text-sm">
          <div class="flex items-center justify-between gap-2">
            <div>
              <dt class="text-xs text-muted inline-flex items-center gap-1">
                TURN secret
                <InfoTip label="TURN secret">
                  Shared secret the relay uses to sign short-lived TURN credentials (TURN REST,
                  HMAC-SHA1). Your backend never needs it directly if it calls the turn-credentials
                  endpoint with the API key.
                </InfoTip>
              </dt>
              <dd>
                <Mono>{app.turnSecretHint ?? '••••'}</Mono>
              </dd>
            </div>
            <Button variant="danger" size="sm" onClick={() => rotate('turn')}>
              Rotate
            </Button>
          </div>
          <div class="flex items-center justify-between gap-2">
            <div>
              <dt class="text-xs text-muted inline-flex items-center gap-1">
                API key
                <InfoTip label="API key">
                  Lets your backend request TURN credentials for its users (Authorization: Bearer
                  &lt;key&gt;). Keep it on the server; never ship it inside a web or mobile app.
                </InfoTip>
              </dt>
              <dd>
                <Mono>{app.apiKeyHint ?? '••••'}</Mono>
              </dd>
            </div>
            <Button variant="danger" size="sm" onClick={() => rotate('api')}>
              Rotate
            </Button>
          </div>
        </dl>
      </Card>
      <Card title="Endpoints" description="Configure these URLs in your app and backend.">
        <dl class="space-y-2 text-sm">
          {[
            [
              'Realm relay',
              `wss://${relay}/a/${app.id}`,
              'Private Nostr relay for this app. Peers use it to find each other and exchange signalling.',
            ],
            [
              'Data relay',
              `wss://${relay}/a/${app.id}/data`,
              'Fallback that forwards end-to-end-encrypted data between peers that cannot connect directly, and lets server-side peers join without WebRTC.',
            ],
            [
              'TURN credentials',
              `POST https://${relay}/a/${app.id}/turn-credentials`,
              'Your backend calls this with the API key to get short-lived TURN username/password pairs for a user.',
            ],
          ].map(([k, v, h]) => (
            <div key={k}>
              <dt class="text-xs text-muted inline-flex items-center gap-1">
                {k}
                <InfoTip label={k as string}>{h}</InfoTip>
              </dt>
              <dd class="break-all">
                <Mono>{v}</Mono>
              </dd>
            </div>
          ))}
          <div>
            <dt class="text-xs text-muted">Created</dt>
            <dd>{formatDate(app.createdAt)}</dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}

const QUOTA_FIELDS: {
  key: keyof AppQuotas
  label: string
  unit: string
  scale: number
  help: string
}[] = [
  {
    key: 'maxAllocations',
    label: 'Max TURN allocations',
    unit: '',
    scale: 1,
    help: 'How many TURN relay sessions this app may hold at once. Roughly the number of simultaneous users who need relaying.',
  },
  {
    key: 'maxMbps',
    label: 'Bandwidth cap',
    unit: 'Mbps',
    scale: 1,
    help: 'Maximum TURN throughput shared by all of this app’s allocations. Traffic above it is slowed down, not dropped.',
  },
  {
    key: 'gbPerMonth',
    label: 'Monthly transfer',
    unit: 'GB',
    scale: 1,
    help: 'Total TURN traffic allowed per calendar month. Once used up, new allocations are refused until the next month and an alert appears on the Overview.',
  },
  {
    key: 'maxStorageBytes',
    label: 'Media storage',
    unit: 'GB',
    scale: 1024 ** 3,
    help: 'Total size of Blossom media this app’s users may store. Uploads beyond it are rejected.',
  },
  {
    key: 'maxBlobBytes',
    label: 'Max blob size',
    unit: 'MB',
    scale: 1024 ** 2,
    help: 'Largest single file a user may upload for this app.',
  },
]

export function Quotas({ app, onSaved }: { app: App; onSaved: (a: App) => void }) {
  const [q, setQ] = useState<AppQuotas>(app.quotas)
  const [mime, setMime] = useState((app.quotas.allowedMime ?? []).join(', '))
  useEffect(() => {
    setQ(app.quotas)
    setMime((app.quotas.allowedMime ?? []).join(', '))
  }, [app])
  const next: AppQuotas = { ...q, allowedMime: mime.split(/[\s,]+/).filter(Boolean) }
  const changes = QUOTA_FIELDS.filter((f) => (app.quotas[f.key] ?? 0) !== (next[f.key] ?? 0)).map(
    (f) => {
      const fmt = (v: unknown) => (v ? `${Number(v) / f.scale} ${f.unit}`.trim() : 'unlimited')
      return `${f.label}: ${fmt(app.quotas[f.key])} → ${fmt(next[f.key])}`
    },
  )
  if ((app.quotas.allowedMime ?? []).join(',') !== (next.allowedMime ?? []).join(','))
    changes.push(`Allowed MIME: ${(next.allowedMime ?? []).join(', ') || 'any'}`)
  return (
    <Card title="Quotas">
      <div class="grid sm:grid-cols-2 gap-3">
        {QUOTA_FIELDS.map((f) => (
          <Field
            key={f.key}
            label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
            hint="0 = unlimited"
            help={f.help}
          >
            <Input
              type="number"
              min={0}
              inputMode="decimal"
              value={String(((q[f.key] as number | undefined) ?? 0) / f.scale)}
              onValue={(v) => setQ({ ...q, [f.key]: Math.max(0, Number(v) || 0) * f.scale })}
            />
          </Field>
        ))}
        <Field
          label="Allowed media types"
          hint="e.g. image/*, video/mp4 — empty = any"
          help="MIME types users may upload for this app, separated by commas. Use type/* for a whole family. Restricting this prevents your media quota being used for unrelated files."
        >
          <Input value={mime} onValue={setMime} />
        </Field>
      </div>
      <div class="flex justify-end gap-2 mt-4">
        <Button
          variant="primary"
          disabled={!changes.length}
          onClick={async () => {
            const r = await performWrite({
              title: 'Update quotas',
              action: 'Save quotas',
              scope: [`App “${app.name}” (${app.id})`, ...changes],
              run: () => api.apps.update(app.id, { quotas: next }),
              success: 'Quotas saved',
            })
            if (r.ok) onSaved(r.value)
          }}
        >
          Save quotas
        </Button>
      </div>
    </Card>
  )
}

function Usage({ app }: { app: App }) {
  const res = useResource(() => api.apps.usage(app.id), [app.id])
  const exportCsv = (u: AppUsage) => {
    const csv = toCsv(
      u.points.map((p) => ({
        date: new Date(p.ts * 1000).toISOString().slice(0, 10),
        bytesIn: p.bytesIn,
        bytesOut: p.bytesOut,
        allocations: p.allocations,
        events: p.events,
      })),
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-${app.id}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('info', 'Usage exported')
  }
  return (
    <Async res={res}>
      {(u) => (
        <>
          <div class="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            <Stat
              label="Transfer (30d)"
              value={formatBytes(u.totals.bytes)}
              help="TURN plus data-relay bytes in both directions over the last 30 days."
            />
            <Stat
              label="Events (30d)"
              value={formatNumber(u.totals.events)}
              tone="violet"
              help="Nostr events published to this app’s realm over the last 30 days."
            />
            <Stat
              label="Peak allocations"
              value={u.totals.peakAllocations}
              help="Highest number of simultaneous TURN allocations in the period. Use it to set Max TURN allocations with some headroom."
            />
          </div>
          <Card
            title="Daily transfer"
            description="Per-day relayed traffic (GB) and published events (thousands). Export CSV downloads the daily numbers."
            actions={
              <Button size="sm" onClick={() => exportCsv(u)}>
                Export CSV
              </Button>
            }
          >
            <Chart
              height={200}
              data={[
                u.points.map((p) => p.ts),
                u.points.map((p) => (p.bytesIn + p.bytesOut) / 1024 ** 3),
                u.points.map((p) => p.events / 1000),
              ]}
              series={[
                {
                  label: 'GB',
                  color: colors.violet,
                  fill: true,
                  value: (v) => (v == null ? '—' : `${v.toFixed(2)} GB`),
                },
                {
                  label: 'k events',
                  color: colors.teal,
                  value: (v) => (v == null ? '—' : `${v.toFixed(1)}k`),
                },
              ]}
            />
          </Card>
        </>
      )}
    </Async>
  )
}
