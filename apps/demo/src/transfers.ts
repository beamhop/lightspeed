import type { FileProgress, Hex } from './p2p'

export interface Transfer {
  id: string
  name: string
  direction: 'in' | 'out'
  total: number
  perPeer: Record<Hex, FileProgress>
  url?: string
}

/** Folds progress events into one record per transfer, with one row per peer. Newest first. */
export function applyProgress(
  list: Transfer[],
  p: FileProgress,
  makeUrl: (b: Blob) => string,
): Transfer[] {
  const idx = list.findIndex((t) => t.id === p.transferId && t.direction === p.direction)
  const base: Transfer =
    idx >= 0
      ? (list[idx] as Transfer)
      : { id: p.transferId, name: p.name, direction: p.direction, total: p.total, perPeer: {} }
  const next: Transfer = { ...base, perPeer: { ...base.perPeer, [p.peer]: p } }
  if (p.blob && !next.url) next.url = makeUrl(p.blob)
  if (idx < 0) return [next, ...list]
  const copy = [...list]
  copy[idx] = next
  return copy
}
