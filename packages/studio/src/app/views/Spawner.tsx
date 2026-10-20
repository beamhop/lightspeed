/** @jsxImportSource preact */
import { Badge, Button, Card, EmptyState, Input, Table, toast } from '@beamhop/ui'
import { useEffect, useState } from 'preact/hooks'
import { SimulatedRoom } from '../../adapters/simulated'
import type { SpawnedPeer } from '../../spawner'
import { refresh, room, STUDIO_HEADERS, save, serverAvailable } from '../store'

interface Form {
  script: string
  count: string
  room: string
  app: string
  relay: string
}

const DEFAULT_FORM: Form = {
  script: './peer.ts',
  count: '4',
  room: 'lobby',
  app: 'demo',
  relay: 'ws://localhost:4848',
}

function loadForm(): Form {
  try {
    return {
      ...DEFAULT_FORM,
      ...JSON.parse(globalThis.localStorage?.getItem('bh-studio:spawn') ?? '{}'),
    }
  } catch {
    return DEFAULT_FORM
  }
}

export function SpawnerView() {
  const r = room.value
  const [form, setForm] = useState<Form>(loadForm)
  const [procs, setProcs] = useState<SpawnedPeer[]>([])
  const [busy, setBusy] = useState(false)
  const [simCount, setSimCount] = useState('2')
  const set = (k: keyof Form) => (v: string) => setForm({ ...form, [k]: v })

  useEffect(() => {
    if (!serverAvailable.value) return
    const poll = async () => {
      try {
        const res = await fetch('/api/spawn')
        if (res.ok) setProcs(((await res.json()) as { peers: SpawnedPeer[] }).peers)
      } catch {
        // server went away; keep the last list
      }
    }
    void poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [serverAvailable.value])

  const spawn = async () => {
    setBusy(true)
    save('bh-studio:spawn', form)
    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: STUDIO_HEADERS,
        body: JSON.stringify({ ...form, count: Number(form.count) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      toast(`Spawned ${body.peers.length} headless peer(s)`, { tone: 'success' })
    } catch (e) {
      toast(`Spawn failed: ${e instanceof Error ? e.message : String(e)}`, { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const kill = async (id?: string) => {
    await fetch(id ? `/api/spawn/${id}` : '/api/spawn', {
      method: 'DELETE',
      headers: STUDIO_HEADERS,
    })
  }

  return (
    <div class="spawner">
      {r instanceof SimulatedRoom && (
        <Card title="Simulated peers">
          <div class="form-row">
            <Input
              label="Count"
              type="number"
              min={1}
              max={24}
              value={simCount}
              onValue={setSimCount}
            />
            <Button
              variant="primary"
              onClick={() => {
                const ids = r.spawn(Math.max(1, Math.min(24, Number(simCount) || 1)))
                refresh()
                toast(`${ids.length} simulated peer(s) joining`, { tone: 'success' })
              }}
            >
              Spawn into simulation
            </Button>
          </div>
        </Card>
      )}
      <Card title="Headless Bun peers">
        {serverAvailable.value === false ? (
          <EmptyState
            mascot="secret"
            title="Spawner needs the Studio server"
            description="Run `bunx beamhop studio` (or `bun run --cwd packages/studio serve`); the dev server alone cannot start processes."
          />
        ) : (
          <>
            <p class="bh-muted small">
              Each peer runs <code>bun run &lt;script&gt;</code> with <code>ROOM</code>,{' '}
              <code>APP</code>, <code>RELAY</code>, <code>BEAMHOP_PEER_INDEX</code> and{' '}
              <code>BEAMHOP_PEER_COUNT</code> set — use the relay transport, no WebRTC needed.
            </p>
            <div class="form-grid form-grid--wide">
              <Input
                label="Script"
                value={form.script}
                onValue={set('script')}
                mono
                hint="Path relative to where Studio was started"
              />
              <Input
                label="Peers"
                type="number"
                min={1}
                max={64}
                value={form.count}
                onValue={set('count')}
              />
              <Input label="Room" value={form.room} onValue={set('room')} />
              <Input label="App" value={form.app} onValue={set('app')} />
              <Input label="Relay" value={form.relay} onValue={set('relay')} mono />
            </div>
            <div class="form-row">
              <Button variant="primary" loading={busy} onClick={() => void spawn()}>
                Spawn {form.count} peer(s)
              </Button>
              <Button
                variant="danger"
                disabled={!procs.some((p) => p.exitedAt === undefined)}
                onClick={() => void kill()}
              >
                Kill all
              </Button>
            </div>
          </>
        )}
      </Card>
      {procs.length > 0 && (
        <Card title="Processes" flush>
          <Table<SpawnedPeer>
            dense
            rows={procs}
            rowKey={(p) => p.id}
            columns={[
              { key: 'id', header: 'ID', mono: true, render: (p) => p.id },
              { key: 'pid', header: 'PID', mono: true, render: (p) => p.pid },
              { key: 'idx', header: '#', mono: true, render: (p) => p.index },
              {
                key: 'status',
                header: 'Status',
                render: (p) =>
                  p.exitedAt === undefined ? (
                    <Badge tone="success" dot>
                      running
                    </Badge>
                  ) : (
                    <Badge tone={p.exitCode === 0 ? 'neutral' : 'danger'}>
                      exit {String(p.exitCode)}
                    </Badge>
                  ),
              },
              {
                key: 'out',
                header: 'Last output',
                mono: true,
                render: (p) => p.output.at(-1) ?? '',
              },
              {
                key: 'kill',
                header: '',
                align: 'right',
                render: (p) =>
                  p.exitedAt === undefined ? (
                    <Button size="sm" variant="ghost" onClick={() => void kill(p.id)}>
                      Kill
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}
    </div>
  )
}
