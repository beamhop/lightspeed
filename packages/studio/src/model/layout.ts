// Deterministic Fruchterman–Reingold force layout for the topology graph.

export interface Point {
  x: number
  y: number
}

export interface LayoutOptions {
  width: number
  height: number
  iterations?: number
  /** Previous positions; nodes keep them as a starting point so the graph doesn't jump. */
  previous?: Record<string, Point>
  padding?: number
}

export function forceLayout(
  ids: readonly string[],
  edges: readonly [string, string][],
  opts: LayoutOptions,
): Record<string, Point> {
  const { width, height, iterations = 120, padding = 40 } = opts
  const sorted = [...ids].sort()
  const n = sorted.length
  const cx = width / 2
  const cy = height / 2
  const pos: Record<string, Point> = {}
  if (n === 0) return pos
  if (n === 1) {
    pos[sorted[0] as string] = { x: cx, y: cy }
    return pos
  }
  // deterministic seed positions on a circle (or previous positions when known)
  const r0 = Math.min(width, height) / 2 - padding
  sorted.forEach((id, i) => {
    const prev = opts.previous?.[id]
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2
    pos[id] = prev ? { ...prev } : { x: cx + r0 * Math.cos(angle), y: cy + r0 * Math.sin(angle) }
  })
  const area = (width - padding * 2) * (height - padding * 2)
  const k = Math.sqrt(area / n) * 0.75
  let temp = Math.min(width, height) / (opts.previous ? 20 : 8)
  const cool = temp / (iterations + 1)
  const valid = edges.filter(([a, b]) => a in pos && b in pos && a !== b)

  for (let it = 0; it < iterations; it++) {
    const disp: Record<string, Point> = {}
    for (const id of sorted) disp[id] = { x: 0, y: 0 }
    // repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = sorted[i] as string
        const b = sorted[j] as string
        const pa = pos[a] as Point
        const pb = pos[b] as Point
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let d = Math.hypot(dx, dy)
        if (d < 0.01) {
          // deterministic nudge for coincident points
          dx = (i - j) * 0.1
          dy = (j - i) * 0.07
          d = Math.hypot(dx, dy)
        }
        const f = (k * k) / d
        const da = disp[a] as Point
        const db = disp[b] as Point
        da.x += (dx / d) * f
        da.y += (dy / d) * f
        db.x -= (dx / d) * f
        db.y -= (dy / d) * f
      }
    }
    // attraction along edges
    for (const [a, b] of valid) {
      const pa = pos[a] as Point
      const pb = pos[b] as Point
      const dx = pa.x - pb.x
      const dy = pa.y - pb.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const f = (d * d) / k
      const da = disp[a] as Point
      const db = disp[b] as Point
      da.x -= (dx / d) * f
      da.y -= (dy / d) * f
      db.x += (dx / d) * f
      db.y += (dy / d) * f
    }
    // gravity towards the centre keeps disconnected nodes on screen
    for (const id of sorted) {
      const p = pos[id] as Point
      const dd = disp[id] as Point
      dd.x += (cx - p.x) * 0.05 * (k / 50)
      dd.y += (cy - p.y) * 0.05 * (k / 50)
      const len = Math.max(0.01, Math.hypot(dd.x, dd.y))
      const step = Math.min(len, temp)
      p.x = clamp(p.x + (dd.x / len) * step, padding, width - padding)
      p.y = clamp(p.y + (dd.y / len) * step, padding, height - padding)
    }
    temp = Math.max(0.5, temp - cool)
  }
  for (const id of sorted) {
    const p = pos[id] as Point
    p.x = Math.round(p.x * 10) / 10
    p.y = Math.round(p.y * 10) / 10
  }
  return pos
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
