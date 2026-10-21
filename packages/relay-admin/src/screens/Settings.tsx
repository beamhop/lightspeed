/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import { Button, Card, Field, Input, PageHeader, Select, Toggle } from '../components/ui'
import { api, isMock, stats } from '../ctx'
import { PAGE_HELP } from '../help'
import { performWrite, session, toast } from '../store'
import type { Settings as SettingsT } from '../types'

const THEME_KEY = 'bh-admin-theme'

export function applyTheme(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function storedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** Field-by-field summary of a settings change for the confirmation dialog. */
export function diffSettings(a: SettingsT, b: SettingsT, prefix = ''): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = (a as unknown as Record<string, unknown>)[k]
    const y = (b as unknown as Record<string, unknown>)[k]
    const path = prefix ? `${prefix}.${k}` : k
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x))
      out.push(...diffSettings(x as SettingsT, y as SettingsT, path))
    else if (JSON.stringify(x) !== JSON.stringify(y))
      out.push(`${path}: ${JSON.stringify(x ?? null)} → ${JSON.stringify(y ?? null)}`)
  }
  return out
}

export function Settings() {
  const res = useResource(() => api.settings.get(), [])
  const [theme, setTheme] = useState(storedTheme())
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Listeners, TLS, logging, metrics and backups"
        intro={PAGE_HELP.settings}
        actions={
          <Button
            onClick={async () => {
              try {
                await api.auth.logout()
              } catch {}
              stats.stop()
              session.value = null
            }}
          >
            Sign out
          </Button>
        }
      />
      <Card
        title="Appearance"
        class="mb-4"
        description="How this admin UI looks for you. It does not affect the relay or other admins."
      >
        <Toggle
          label="Light theme"
          checked={theme === 'light'}
          onChange={(v) => {
            const t = v ? 'light' : 'dark'
            setTheme(t)
            applyTheme(t)
            try {
              localStorage.setItem(THEME_KEY, t)
            } catch {}
          }}
        />
        <p class="text-xs text-muted mt-1">
          Stored in this browser only.{isMock ? ' Mock mode: changes live in memory.' : ''}
        </p>
      </Card>
      <Async res={res}>
        {(s) => <SettingsForm saved={s} onSaved={(n) => res.mutate(() => n)} />}
      </Async>
    </>
  )
}

function SettingsForm({ saved, onSaved }: { saved: SettingsT; onSaved: (s: SettingsT) => void }) {
  const [s, setS] = useState<SettingsT>(saved)
  useEffect(() => setS(saved), [saved])
  const changes = diffSettings(saved, s)
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0))
  const restart = changes.some((c) => c.startsWith('listeners') || c.startsWith('tls'))

  return (
    <div class="grid lg:grid-cols-2 gap-4">
      <Card
        title="Listeners and ports"
        description="The network ports the relay listens on. Your firewall and any load balancer must forward these. Port changes apply after a restart; the public URL applies immediately."
      >
        <div class="grid grid-cols-2 gap-3">
          <div class="col-span-2">
            <Field
              label="Public URL"
              hint="e.g. https://relay.example.com"
              help="The address users and apps reach the relay at. It is used in NIP-42 AUTH challenges, NIP-98 checks, the URLs shown on the Apps page and links on /pay. Must match what clients connect to, including https."
            >
              <Input value={s.publicUrl} onValue={(v) => setS({ ...s, publicUrl: v })} />
            </Field>
          </div>
          <Field
            label="HTTPS / WSS"
            help="Main port for the Nostr relay, data relay, media, /pay and this admin UI. Normally 443."
          >
            <Input
              type="number"
              value={String(s.listeners.https)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, https: num(v) } })}
            />
          </Field>
          <Field
            label="TURN UDP"
            help="STUN/TURN over UDP, the fastest path. The standard port is 3478."
          >
            <Input
              type="number"
              value={String(s.listeners.turnUdp)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnUdp: num(v) } })}
            />
          </Field>
          <Field
            label="TURN TCP"
            help="TURN over TCP for networks that block UDP. Usually also 3478."
          >
            <Input
              type="number"
              value={String(s.listeners.turnTcp)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnTcp: num(v) } })}
            />
          </Field>
          <Field
            label="TURNS (TLS)"
            help="TURN over TLS (turns:), which looks like HTTPS traffic and gets through strict corporate firewalls. Standard port 5349; 0 turns it off. Needs the TLS certificate below."
          >
            <Input
              type="number"
              value={String(s.listeners.turnTls)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnTls: num(v) } })}
            />
          </Field>
          <Field
            label="Relay port range"
            help="UDP ports TURN opens for relayed traffic, one per allocation. The range limits how many simultaneous allocations are possible and must be open in your firewall."
          >
            <div class="flex gap-1 items-center">
              <Input
                type="number"
                value={String(s.listeners.relayPorts[0])}
                onValue={(v) =>
                  setS({
                    ...s,
                    listeners: { ...s.listeners, relayPorts: [num(v), s.listeners.relayPorts[1]] },
                  })
                }
              />
              <span class="text-muted">–</span>
              <Input
                type="number"
                value={String(s.listeners.relayPorts[1])}
                onValue={(v) =>
                  setS({
                    ...s,
                    listeners: { ...s.listeners, relayPorts: [s.listeners.relayPorts[0], num(v)] },
                  })
                }
              />
            </div>
          </Field>
        </div>
      </Card>
      <Card
        title="TLS"
        description="The certificate that secures HTTPS, WSS and TURNS. Leave both paths empty when a reverse proxy (Caddy, nginx) terminates TLS in front of the relay. The relay reloads the files when they change, so renewals (e.g. certbot) need no restart; changing the paths does."
      >
        <div class="space-y-3">
          <Field
            label="Certificate path"
            help="Path on the server to a PEM certificate chain (fullchain.pem from Let’s Encrypt/certbot)."
          >
            <Input
              value={s.tls.cert}
              onValue={(v) => setS({ ...s, tls: { ...s.tls, cert: v } })}
              class="font-mono"
            />
          </Field>
          <Field
            label="Key path"
            help="Path on the server to the PEM private key matching the certificate. The relay process must be able to read it."
          >
            <Input
              value={s.tls.key}
              onValue={(v) => setS({ ...s, tls: { ...s.tls, key: v } })}
              class="font-mono"
            />
          </Field>
        </div>
      </Card>
      <Card
        title="Logging and metrics"
        description="How much the relay writes to its logs, and whether it exposes numbers for monitoring tools such as Prometheus and Grafana."
      >
        <div class="grid grid-cols-2 gap-3 items-end">
          <Field
            label="Log level"
            hint="Applies immediately."
            help="debug: everything, for troubleshooting (noisy). info: normal operation. warn: only problems. error: only failures. Logs are always JSON lines on stdout, ready for journald, Loki or a cloud log service."
          >
            <Select
              value={s.logging.level}
              onValue={(v) => setS({ ...s, logging: { ...s.logging, level: v } })}
              options={(['debug', 'info', 'warn', 'error'] as const).map((l) => ({
                value: l,
                label: l,
              }))}
            />
          </Field>
          <Toggle
            label="Prometheus metrics"
            help="Expose counters (events, clients, TURN bandwidth, …) at the metrics path for Prometheus to scrape. When off, the path returns 404. Applies immediately."
            checked={s.metrics.enabled}
            onChange={(v) => setS({ ...s, metrics: { ...s.metrics, enabled: v } })}
          />
          <Field
            label="Metrics path"
            hint={
              s.metrics.tokenSet
                ? 'Protected by a bearer token (metrics.token).'
                : 'Public. Set metrics.token in the config file to require a bearer token.'
            }
            help="The URL Prometheus scrapes. It is fixed by the relay. The token is a secret, so it is set in beamhop-relay.toml or BEAMHOP_METRICS_TOKEN rather than here."
          >
            <Input value={s.metrics.path} readOnly class="font-mono opacity-70" />
          </Field>
        </div>
        <Button class="mt-3" size="sm" onClick={() => downloadGrafana(s.metrics.path)}>
          Download Grafana dashboard
        </Button>
        <p class="text-[11px] text-muted mt-1">
          A ready-made dashboard JSON: in Grafana choose Dashboards → New → Import and upload it.
        </p>
      </Card>
      <Card
        title="Backups"
        description="Automatic daily snapshots of the relay databases into the backup directory on this server. Copy that directory off the machine (rsync, restic, a volume snapshot) so a lost server does not take its backups with it. You can also run one by hand on Nostr → Backup."
      >
        <div class="grid grid-cols-2 gap-3 items-end">
          <Toggle
            label="Nightly backups"
            help="Take a snapshot once a day at the hour below."
            checked={s.backups.enabled}
            onChange={(v) => setS({ ...s, backups: { ...s.backups, enabled: v } })}
          />
          <Field
            label="Hour (UTC)"
            help="Hour of day, 0–23 in UTC, when the backup runs. Pick a quiet time for your users."
          >
            <Input
              type="number"
              min={0}
              max={23}
              value={String(s.backups.hourUtc)}
              onValue={(v) =>
                setS({ ...s, backups: { ...s.backups, hourUtc: Math.min(23, num(v)) } })
              }
            />
          </Field>
          <Field
            label="Retention (days)"
            help="Backups older than this are deleted automatically to save disk space."
          >
            <Input
              type="number"
              value={String(s.backups.retentionDays)}
              onValue={(v) => setS({ ...s, backups: { ...s.backups, retentionDays: num(v) } })}
            />
          </Field>
        </div>
      </Card>
      <div class="lg:col-span-2 flex items-center justify-between gap-2 sticky bottom-20 md:bottom-2 rounded-lg bg-surface/95 backdrop-blur border border-line px-4 py-3">
        <span class="text-xs text-muted">
          {changes.length
            ? `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}${restart ? ' · listener/TLS changes need a restart' : ''}`
            : 'No changes'}
        </span>
        <div class="flex gap-2">
          <Button variant="ghost" disabled={!changes.length} onClick={() => setS(saved)}>
            Reset
          </Button>
          <Button
            variant="primary"
            disabled={!changes.length}
            onClick={async () => {
              const r = await performWrite({
                title: 'Save relay settings',
                action: 'Save settings',
                danger: restart,
                scope: [
                  'Relay-wide configuration (persisted to admin.db, overrides beamhop-relay.toml)',
                  ...changes,
                  ...(restart ? ['Listener/TLS changes apply after the next restart'] : []),
                ],
                run: () => api.settings.put(s),
                success: 'Settings saved',
              })
              if (r.ok) onSaved(r.value)
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function downloadGrafana(metricsPath: string) {
  const panel = (id: number, title: string, expr: string, unit: string) => ({
    id,
    title,
    type: 'timeseries',
    gridPos: { h: 8, w: 12, x: ((id - 1) % 2) * 12, y: Math.floor((id - 1) / 2) * 8 },
    fieldConfig: { defaults: { unit } },
    targets: [{ expr, refId: 'A' }],
  })
  const dash = {
    title: 'Beamhop Relay',
    uid: 'beamhop-relay',
    schemaVersion: 39,
    description: `Scrapes ${metricsPath}`,
    panels: [
      panel(1, 'Nostr events/s', 'rate(beamhop_nostr_events_total[1m])', 'ops'),
      panel(2, 'Connected clients', 'beamhop_nostr_clients', 'short'),
      panel(3, 'TURN allocations', 'beamhop_turn_allocations', 'short'),
      panel(4, 'TURN relayed bandwidth', 'rate(beamhop_turn_bytes_total[1m]) * 8', 'bps'),
    ],
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(dash, null, 2)], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = 'beamhop-relay-grafana.json'
  a.click()
  URL.revokeObjectURL(url)
  toast('info', 'Dashboard downloaded')
}
