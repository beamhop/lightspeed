/** @jsxImportSource preact */
import { Badge, Button, Card, EmptyState, Input, Mascot, Table, Toggle } from '@beamhop/ui'
import { useState } from 'preact/hooks'
import {
  browserAllocationTest,
  checkRelay,
  type HealthCheck,
  type HealthReport,
} from '../../health'
import { ms } from '../format'
import { STUDIO_HEADERS, save, serverAvailable } from '../store'

const LABELS: Record<HealthCheck['name'], string> = {
  nip11: 'NIP-11 info',
  auth: 'NIP-42 AUTH',
  signaling: 'Signaling RTT',
  turn: 'TURN credential mint',
  allocation: 'TURN allocation',
}

interface Form {
  relay: string
  appId: string
  apiKey: string
}

function loadForm(): Form {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem('bh-studio:health') ?? '{}')
    // the API key is never persisted
    return { relay: 'ws://localhost:4848', appId: '', ...saved, apiKey: '' }
  } catch {
    return { relay: 'ws://localhost:4848', appId: '', apiKey: '' }
  }
}

export function HealthView() {
  const [form, setForm] = useState<Form>(loadForm)
  const [viaServer, setViaServer] = useState(true)
  const [report, setReport] = useState<HealthReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    save('bh-studio:health', { relay: form.relay, appId: form.appId })
    try {
      const opts = {
        relay: form.relay.trim(),
        appId: form.appId.trim() || undefined,
        apiKey: form.apiKey || undefined,
      }
      if (viaServer && serverAvailable.value) {
        const res = await fetch('/api/health', {
          method: 'POST',
          headers: STUDIO_HEADERS,
          body: JSON.stringify(opts),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        setReport(body as HealthReport)
      } else {
        setReport(
          await checkRelay({
            ...opts,
            allocationTest: (servers) => browserAllocationTest(servers),
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const failed = report?.checks.some((c) => c.ok === false)
  return (
    <div class="health">
      <Card title="Relay">
        <div class="form-grid form-grid--wide">
          <Input
            label="Relay URL"
            value={form.relay}
            mono
            onValue={(relay) => setForm({ ...form, relay })}
          />
          <Input
            label="App id"
            value={form.appId}
            placeholder="optional: realm relay + TURN"
            onValue={(appId) => setForm({ ...form, appId })}
          />
          <Input
            label="API key"
            type="password"
            value={form.apiKey}
            placeholder="optional: TURN mint"
            autoComplete="off"
            onValue={(apiKey) => setForm({ ...form, apiKey })}
            hint="Kept in memory only"
          />
        </div>
        <div class="form-row">
          <Button
            variant="primary"
            loading={running}
            onClick={() => void run()}
            disabled={!/^wss?:\/\//.test(form.relay.trim())}
          >
            Run checks
          </Button>
          <Toggle
            checked={viaServer && serverAvailable.value === true}
            disabled={!serverAvailable.value}
            label={
              serverAvailable.value
                ? 'Probe from the Studio server (no CORS)'
                : 'Probing from the browser'
            }
            onChange={setViaServer}
          />
        </div>
      </Card>
      <Card title="Results" flush>
        {error && <div class="studio__error">{error}</div>}
        {running ? (
          <EmptyState mascot="spinner" title="Probing relay…" />
        ) : report ? (
          <>
            <div class="health__verdict">
              <Mascot state={failed ? 'angry' : 'smile'} size={56} />
              <div>
                <div class="studio__title">
                  {failed ? 'Something is off' : 'Relay looks healthy'}
                </div>
                <div class="bh-muted small bh-mono">{report.relay}</div>
              </div>
            </div>
            <Table<HealthCheck>
              rows={report.checks}
              rowKey={(c) => c.name}
              columns={[
                { key: 'name', header: 'Check', render: (c) => LABELS[c.name] },
                {
                  key: 'ok',
                  header: 'Result',
                  render: (c) => (
                    <Badge tone={c.ok === null ? 'neutral' : c.ok ? 'success' : 'danger'} dot>
                      {c.ok === null ? 'skipped' : c.ok ? 'ok' : 'failed'}
                    </Badge>
                  ),
                },
                { key: 'ms', header: 'Time', mono: true, align: 'right', render: (c) => ms(c.ms) },
                { key: 'detail', header: 'Detail', render: (c) => c.detail },
              ]}
            />
          </>
        ) : (
          <EmptyState
            mascot="idle"
            title="No checks run yet"
            description="NIP-11 fetch, AUTH challenge, signaling RTT and TURN credential mint + allocation test."
          />
        )}
      </Card>
    </div>
  )
}
