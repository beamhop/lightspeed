/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import { Button, Card, Field, Input, PageHeader, Select, Toggle } from '../components/ui'
import { api, isMock, stats } from '../ctx'
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
      <Card title="Appearance" class="mb-4">
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
      <Card title="Listeners and ports">
        <div class="grid grid-cols-2 gap-3">
          <div class="col-span-2">
            <Field label="Public URL">
              <Input value={s.publicUrl} onValue={(v) => setS({ ...s, publicUrl: v })} />
            </Field>
          </div>
          <Field label="HTTPS / WSS">
            <Input
              type="number"
              value={String(s.listeners.https)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, https: num(v) } })}
            />
          </Field>
          <Field label="TURN UDP">
            <Input
              type="number"
              value={String(s.listeners.turnUdp)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnUdp: num(v) } })}
            />
          </Field>
          <Field label="TURN TCP">
            <Input
              type="number"
              value={String(s.listeners.turnTcp)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnTcp: num(v) } })}
            />
          </Field>
          <Field label="TURNS (TLS)">
            <Input
              type="number"
              value={String(s.listeners.turnTls)}
              onValue={(v) => setS({ ...s, listeners: { ...s.listeners, turnTls: num(v) } })}
            />
          </Field>
          <Field label="Relay port range">
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
      <Card title="TLS">
        <div class="space-y-3">
          <Toggle
            label="Automatic certificates (ACME)"
            checked={s.tls.auto}
            onChange={(v) => setS({ ...s, tls: { ...s.tls, auto: v } })}
          />
          <Field label="Certificate path">
            <Input
              value={s.tls.cert}
              onValue={(v) => setS({ ...s, tls: { ...s.tls, cert: v } })}
              class="font-mono"
            />
          </Field>
          <Field label="Key path">
            <Input
              value={s.tls.key}
              onValue={(v) => setS({ ...s, tls: { ...s.tls, key: v } })}
              class="font-mono"
            />
          </Field>
        </div>
      </Card>
      <Card title="Logging and metrics">
        <div class="grid grid-cols-2 gap-3 items-end">
          <Field label="Log level">
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
            label="JSON logs"
            checked={s.logging.json}
            onChange={(v) => setS({ ...s, logging: { ...s.logging, json: v } })}
          />
          <Toggle
            label="Prometheus metrics"
            checked={s.metrics.enabled}
            onChange={(v) => setS({ ...s, metrics: { ...s.metrics, enabled: v } })}
          />
          <Field label="Metrics path">
            <Input
              value={s.metrics.path}
              onValue={(v) => setS({ ...s, metrics: { ...s.metrics, path: v } })}
            />
          </Field>
        </div>
        <Button class="mt-3" size="sm" onClick={() => downloadGrafana(s.metrics.path)}>
          Download Grafana dashboard
        </Button>
      </Card>
      <Card title="Backups">
        <div class="grid grid-cols-2 gap-3 items-end">
          <Toggle
            label="Nightly backups"
            checked={s.backups.enabled}
            onChange={(v) => setS({ ...s, backups: { ...s.backups, enabled: v } })}
          />
          <Field label="Hour (UTC)">
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
          <Field label="Retention (days)">
            <Input
              type="number"
              value={String(s.backups.retentionDays)}
              onValue={(v) => setS({ ...s, backups: { ...s.backups, retentionDays: num(v) } })}
            />
          </Field>
          <Field label="S3 URL (optional)">
            <Input
              value={s.backups.s3Url ?? ''}
              onValue={(v) => setS({ ...s, backups: { ...s.backups, s3Url: v || undefined } })}
              placeholder="s3://bucket/prefix"
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
