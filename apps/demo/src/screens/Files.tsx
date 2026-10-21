import { ArrowDown, ArrowUp, Download, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
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
    <Card>
      <CardContent className="grid gap-5">
        <label
          className={cn(
            'grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
            dragging ? 'border-primary bg-primary/10' : 'hover:border-primary/50 hover:bg-muted/40',
            others === 0 && 'cursor-not-allowed opacity-70',
          )}
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
          <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
            <Upload className="size-5" />
          </span>
          <strong className="font-medium">
            {others === 0 ? 'No peers yet' : 'Drop files here or click to pick'}
          </strong>
          <span className="max-w-md text-xs text-muted-foreground">
            Streamed in 16 KiB chunks over a reliable channel with backpressure, to{' '}
            {others === 1 ? '1 peer' : `${others} peers`}.
          </span>
        </label>

        {transfers.length > 0 && (
          <ul className="grid gap-3" data-testid="transfers">
            {transfers.map((t) => (
              <li key={`${t.direction}-${t.id}`} className="grid gap-3 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {t.direction === 'out' ? (
                      <ArrowUp className="size-4 shrink-0 text-violet" aria-label="sent" />
                    ) : (
                      <ArrowDown className="size-4 shrink-0 text-primary" aria-label="received" />
                    )}
                    <strong className="truncate font-medium">{t.name}</strong>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(t.total)}
                    </span>
                  </span>
                  {t.url && (
                    <Button asChild size="sm" variant="outline">
                      <a href={t.url} download={t.name}>
                        <Download />
                        Save
                      </a>
                    </Button>
                  )}
                </div>
                {Object.values(t.perPeer).map((p) => {
                  const pct = p.total ? Math.floor((p.sent / p.total) * 100) : 100
                  return (
                    <div
                      key={p.peer}
                      className="grid grid-cols-[minmax(0,8rem)_1fr_3.5rem] items-center gap-3"
                    >
                      <span className="truncate text-xs">
                        {names[p.peer] ?? p.peer.slice(0, 8)}
                      </span>
                      <Progress value={pct} className={cn(p.error && '[&>*]:bg-destructive')} />
                      <span
                        className={cn(
                          'text-right text-xs tabular-nums text-muted-foreground',
                          p.error && 'text-destructive',
                        )}
                      >
                        {p.error ? p.error : p.done ? 'done' : `${pct}%`}
                      </span>
                    </div>
                  )
                })}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
