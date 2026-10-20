import { useEffect, useRef, useState } from 'preact/hooks'
import { usePeers } from '../hooks'
import type { DemoRoom, Hex } from '../p2p'

interface CursorState {
  x: number
  y: number
  at: number
}

const SEND_INTERVAL_MS = 33 // ~30 Hz; the channel is unreliable so stale frames are simply lost
const STALE_MS = 5000

export function Cursors({ room }: { room: DemoRoom }) {
  const peers = usePeers(room)
  const [cursors, setCursors] = useState<Record<Hex, CursorState>>({})
  const areaRef = useRef<HTMLDivElement>(null)
  const lastSent = useRef(0)
  const [, tick] = useState(0)

  useEffect(
    () =>
      room.onCursor((c) =>
        setCursors((prev) => ({ ...prev, [c.from]: { x: c.x, y: c.y, at: Date.now() } })),
      ),
    [room],
  )
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const onMove = (e: PointerEvent) => {
    const el = areaRef.current
    if (!el) return
    const now = performance.now()
    if (now - lastSent.current < SEND_INTERVAL_MS) return
    lastSent.current = now
    const r = el.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    room.sendCursor(x, y)
  }

  const now = Date.now()
  return (
    <div class="card">
      <p class="muted small">
        Move your pointer. Positions go out on an unreliable, unordered channel (maxRetransmits 0),
        so a lost frame is replaced by the next one instead of being retransmitted.
      </p>
      <div
        class="canvas"
        ref={areaRef}
        onPointerMove={onMove}
        onPointerDown={onMove}
        data-testid="cursor-canvas"
      >
        {peers
          .filter((p) => !p.self)
          .map((p) => {
            const c = cursors[p.id]
            if (!c || now - c.at > STALE_MS) return null
            return (
              <div
                key={p.id}
                class="cursor"
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, color: p.color }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill="currentColor" />
                </svg>
                <span class="cursor-label" style={{ background: p.color }}>
                  {p.name}
                  {p.rttMs !== undefined ? ` · ${p.rttMs} ms` : ''}
                </span>
              </div>
            )
          })}
      </div>
    </div>
  )
}
