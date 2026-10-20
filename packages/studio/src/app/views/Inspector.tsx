/** @jsxImportSource preact */
import { Badge, Card, EmptyState, formatBytes, Input, Select, Table } from '@beamhop/ui'
import { useMemo, useState } from 'preact/hooks'
import {
  actionCounts,
  decodePayload,
  filterMessages,
  type MessageRecord,
} from '../../model/inspector'
import { offset } from '../format'
import { events, knownPeers, live, peerName, range, selectedPeer, viewTime } from '../store'

const MAX_ROWS = 400

export function InspectorView() {
  const [action, setAction] = useState('')
  const [direction, setDirection] = useState('')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const peer = selectedPeer.value ?? ''
  const until = live.value ? undefined : viewTime.value
  const all = events.value

  const rows = useMemo(() => {
    const out = filterMessages(all, {
      peer: peer || undefined,
      action: action || undefined,
      direction: (direction || undefined) as 'in' | 'out' | undefined,
      text: text || undefined,
      until,
    })
    return out.slice(-MAX_ROWS).reverse()
  }, [all, peer, action, direction, text, until])

  const actions = useMemo(() => actionCounts(all), [all])
  const start = range.value?.start ?? 0
  const sel = rows.find((r) => r.seq === selected) ?? null

  return (
    <div class="inspector">
      <Card
        title="Message inspector"
        flush
        actions={
          <span class="bh-muted small">
            {rows.length >= MAX_ROWS ? `latest ${MAX_ROWS}` : `${rows.length} messages`}
          </span>
        }
      >
        <div class="filters">
          <Select
            label="Peer"
            value={peer}
            options={[
              { value: '', label: 'All peers' },
              ...knownPeers.value.map((p) => ({ value: p, label: peerName(p) })),
            ]}
            onValue={(v) => {
              selectedPeer.value = v || null
            }}
          />
          <Select
            label="Action"
            value={action}
            options={[
              { value: '', label: 'All actions' },
              ...actions.map((a) => ({ value: a.action, label: `${a.action} (${a.count})` })),
            ]}
            onValue={setAction}
          />
          <Select
            label="Direction"
            value={direction}
            options={[
              { value: '', label: 'Both' },
              { value: 'out', label: 'Sent (out)' },
              { value: 'in', label: 'Received (in)' },
            ]}
            onValue={setDirection}
          />
          <Input label="Search payload" value={text} placeholder="text…" onValue={setText} />
        </div>
        <Table<MessageRecord>
          dense
          rows={rows}
          rowKey={(r) => r.seq}
          selectedKey={selected}
          onRowClick={(r) => setSelected(r.seq === selected ? null : r.seq)}
          empty={
            <EmptyState
              mascot="idle"
              title="No messages match"
              description="Loosen the filters or wait for traffic."
            />
          }
          columns={[
            {
              key: 'at',
              header: 'Time',
              mono: true,
              render: (r) => offset(r.event.at, start),
              width: '90px',
            },
            { key: 'source', header: 'Reported by', render: (r) => peerName(r.source) },
            {
              key: 'dir',
              header: '',
              width: '40px',
              render: (r) => (
                <Badge tone={r.event.direction === 'out' ? 'teal' : 'violet'}>
                  {r.event.direction}
                </Badge>
              ),
            },
            { key: 'peer', header: 'Peer', render: (r) => peerName(r.event.peer) },
            { key: 'action', header: 'Action', mono: true, render: (r) => r.event.action },
            {
              key: 'size',
              header: 'Size',
              align: 'right',
              mono: true,
              render: (r) => formatBytes(r.event.size),
            },
          ]}
        />
      </Card>
      <Card title="Payload" class="inspector__detail">
        {sel ? (
          <>
            <div class="kv">
              <span>Action</span>
              <span class="bh-mono">{sel.event.action}</span>
              <span>Route</span>
              <span>
                {sel.event.direction === 'out'
                  ? `${peerName(sel.source)} → ${peerName(sel.event.peer)}`
                  : `${peerName(sel.event.peer)} → ${peerName(sel.source)}`}
              </span>
              <span>Size</span>
              <span class="bh-mono">{formatBytes(sel.event.size)}</span>
              <span>Seq</span>
              <span class="bh-mono">#{sel.seq}</span>
            </div>
            <pre class="json">{decodePayload(sel.event.payload)}</pre>
          </>
        ) : (
          <EmptyState
            mascot="secret"
            title="Pick a message"
            description="Payloads are decoded through the app protocol and shown as JSON."
          />
        )}
      </Card>
    </div>
  )
}
