/** @jsxImportSource preact */
import { Badge, Button, Card, Confirm, EmptyState, Input, Select, Table, toast } from '@beamhop/ui'
import { useState } from 'preact/hooks'
import type { ActiveFault, Fault } from '../../room-adapter'
import { offset } from '../format'
import { faults, peerName, peers, range, refresh, room } from '../store'

function describe(f: Fault): string {
  switch (f.type) {
    case 'latency':
      return `+${f.ms} ms latency ${f.peer ? `on ${peerName(f.peer)}` : 'on every link'}`
    case 'loss':
      return `${Math.round(f.rate * 100)}% loss ${f.peer ? `on ${peerName(f.peer)}` : 'on every link'}`
    case 'partition':
      return f.groups.map((g) => `[${g.map(peerName).join(', ')}]`).join(' ⟂ ')
    case 'kill':
      return `killed ${peerName(f.peer)}`
  }
}

export function FaultsView() {
  const r = room.value
  const list = peers.value.filter((p) => !p.isSelf)
  const [latPeer, setLatPeer] = useState('')
  const [latMs, setLatMs] = useState('250')
  const [lossPeer, setLossPeer] = useState('')
  const [lossPct, setLossPct] = useState('20')
  const [groupB, setGroupB] = useState<Set<string>>(new Set())
  const [killPeer, setKillPeer] = useState('')
  const [confirmKill, setConfirmKill] = useState(false)

  if (!r?.capabilities.faults) {
    return (
      <EmptyState
        mascot="angry"
        title="Fault injection unavailable"
        description="This attach mode cannot inject faults. Use the simulated room, or the in-page bridge with the dev hook enabled."
      />
    )
  }

  const inject = async (fault: Fault) => {
    try {
      await r.injectFault(fault)
      refresh()
      toast(`Injected: ${describe(fault)}`, { tone: 'warning' })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'danger' })
    }
  }
  const peerOptions = [
    { value: '', label: 'All peers' },
    ...list.map((p) => ({ value: p.pubkey, label: peerName(p.pubkey) })),
  ]
  const start = range.value?.start ?? 0

  return (
    <div class="faults">
      <div class="faults__grid">
        <Card title="Latency">
          <div class="form-grid">
            <Select label="Peer" value={latPeer} options={peerOptions} onValue={setLatPeer} />
            <Input
              label="Added latency (ms)"
              type="number"
              min={0}
              value={latMs}
              onValue={setLatMs}
            />
            <Button
              variant="primary"
              onClick={() =>
                void inject({ type: 'latency', ms: Number(latMs) || 0, peer: latPeer || undefined })
              }
            >
              Add latency
            </Button>
          </div>
        </Card>
        <Card title="Packet loss">
          <div class="form-grid">
            <Select label="Peer" value={lossPeer} options={peerOptions} onValue={setLossPeer} />
            <Input
              label="Loss (%)"
              type="number"
              min={0}
              max={100}
              value={lossPct}
              onValue={setLossPct}
            />
            <Button
              variant="primary"
              onClick={() =>
                void inject({
                  type: 'loss',
                  rate: Math.min(100, Math.max(0, Number(lossPct) || 0)) / 100,
                  peer: lossPeer || undefined,
                })
              }
            >
              Add loss
            </Button>
          </div>
        </Card>
        <Card title="Partition">
          <p class="bh-muted small">
            Tick the peers that go to side B; everyone else stays on side A.
          </p>
          <div class="partition">
            {list.map((p) => (
              <label key={p.pubkey} class="partition__peer">
                <input
                  type="checkbox"
                  checked={groupB.has(p.pubkey)}
                  onChange={(e) => {
                    const next = new Set(groupB)
                    if ((e.currentTarget as HTMLInputElement).checked) next.add(p.pubkey)
                    else next.delete(p.pubkey)
                    setGroupB(next)
                  }}
                />
                <span>{peerName(p.pubkey)}</span>
                <Badge tone={groupB.has(p.pubkey) ? 'violet' : 'teal'}>
                  {groupB.has(p.pubkey) ? 'B' : 'A'}
                </Badge>
              </label>
            ))}
          </div>
          <Button
            variant="primary"
            disabled={groupB.size === 0 || groupB.size === list.length}
            onClick={() =>
              void inject({
                type: 'partition',
                groups: [
                  list.filter((p) => !groupB.has(p.pubkey)).map((p) => p.pubkey),
                  [...groupB],
                ],
              })
            }
          >
            Partition
          </Button>
        </Card>
        <Card title="Kill peer">
          <div class="form-grid">
            <Select
              label="Peer"
              value={killPeer}
              options={[{ value: '', label: 'Choose a peer…' }, ...peerOptions.slice(1)]}
              onValue={setKillPeer}
            />
            <Button variant="danger" disabled={!killPeer} onClick={() => setConfirmKill(true)}>
              Kill
            </Button>
          </div>
          <p class="bh-muted small">Clearing a kill fault brings the peer back (simulated room).</p>
        </Card>
      </div>
      <Card title="Active faults" flush>
        <Table<ActiveFault>
          rows={[...faults.value]}
          rowKey={(f) => f.id}
          empty="No faults — the network is behaving."
          columns={[
            { key: 'id', header: 'ID', mono: true, render: (f) => f.id, width: '60px' },
            {
              key: 'type',
              header: 'Type',
              render: (f) => (
                <Badge tone={f.fault.type === 'kill' ? 'danger' : 'warning'}>{f.fault.type}</Badge>
              ),
            },
            { key: 'what', header: 'Fault', render: (f) => describe(f.fault) },
            { key: 'since', header: 'Since', mono: true, render: (f) => offset(f.since, start) },
            {
              key: 'clear',
              header: '',
              align: 'right',
              render: (f) => (
                <Button
                  size="sm"
                  onClick={async () => {
                    await r.clearFault(f.id)
                    refresh()
                  }}
                >
                  Clear
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Confirm
        open={confirmKill}
        danger
        title="Kill peer?"
        message={`${peerName(killPeer)} drops off the room without saying goodbye. Other peers should see it leave.`}
        confirmLabel="Kill"
        onCancel={() => setConfirmKill(false)}
        onConfirm={() => {
          setConfirmKill(false)
          void inject({ type: 'kill', peer: killPeer })
          setKillPeer('')
        }}
      />
    </div>
  )
}
