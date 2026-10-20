import { useEffect, useMemo, useState } from 'preact/hooks'
import { formatBytes, usePeers } from '../hooks'
import type { DemoRoom } from '../p2p'
import { applyProgress, type Transfer } from '../transfers'

export function Files({ room }: { room: DemoRoom }) {
  const peers = usePeers(room)
  const names = useMemo(() => Object.fromEntries(peers.map((p) => [p.id, p.name])), [peers])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [dragging, setDragging] = useState(false)
  const others = peers.length - 1

  useEffect(
    () => room.onFile((p) => setTransfers((list) => applyProgress(list, p, URL.createObjectURL))),
    [room],
  )

  const send = (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) void room.sendFile(f, f.name)
  }

  return (
    <div class="card">
      <label
        class={dragging ? 'drop active' : 'drop'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          send(e.dataTransfer?.files ?? null)
        }}
      >
        <input
          type="file"
          multiple
          hidden
          disabled={others === 0}
          onChange={(e) => send(e.currentTarget.files)}
          data-testid="file-input"
        />
        <strong>{others === 0 ? 'No peers yet' : 'Drop files here or click to pick'}</strong>
        <span class="muted small">
          Streamed in 16 KiB chunks over a reliable channel with backpressure, to{' '}
          {others === 1 ? '1 peer' : `${others} peers`}.
        </span>
      </label>

      <ul class="transfers" data-testid="transfers">
        {transfers.map((t) => (
          <li key={`${t.direction}-${t.id}`} class="transfer">
            <div class="row between">
              <span>
                {t.direction === 'out' ? '↑' : '↓'} <strong>{t.name}</strong>{' '}
                <span class="muted small">{formatBytes(t.total)}</span>
              </span>
              {t.url && (
                <a href={t.url} download={t.name} class="button">
                  Save
                </a>
              )}
            </div>
            {Object.values(t.perPeer).map((p) => (
              <div key={p.peer} class="progress-row">
                <span class="small">{names[p.peer] ?? p.peer.slice(0, 8)}</span>
                <progress max={p.total || 1} value={p.total ? p.sent : 1} />
                <span class="small muted">
                  {p.error
                    ? p.error
                    : p.done
                      ? 'done'
                      : `${Math.floor((p.sent / (p.total || 1)) * 100)}%`}
                </span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}
