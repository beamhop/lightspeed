export function clock(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '--:--:--'
  const d = new Date(t)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Offset from a start time: +1.234s / +2m03s */
export function offset(t: number, start: number): string {
  const ms = Math.max(0, t - start)
  if (ms < 60_000) return `+${(ms / 1000).toFixed(ms < 10_000 ? 3 : 1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `+${m}m${String(s).padStart(2, '0')}s`
}

export function ms(v: number | undefined): string {
  return v === undefined ? '—' : `${Math.round(v)} ms`
}

export const PATH_COLOR = {
  direct: 'var(--bh-teal)',
  turn: 'var(--bh-violet)',
  relay: 'var(--bh-warning)',
  memory: 'var(--bh-text-muted)',
} as const
