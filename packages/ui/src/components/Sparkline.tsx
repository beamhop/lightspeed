/** @jsxImportSource preact */
import { cx } from './util'

export interface SparklineProps {
  values: readonly number[]
  width?: number
  height?: number
  /** CSS color; defaults to the teal token. */
  color?: string
  /** Fill the area under the line. */
  area?: boolean
  /** Fixed y-range; defaults to the min/max of the values. */
  min?: number
  max?: number
  label?: string
  class?: string
}

/** Compute the SVG polyline points for a series (exported for tests and custom charts). */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  range?: { min?: number; max?: number },
  pad = 2,
): [number, number][] {
  if (values.length === 0) return []
  const finite = values.filter((v) => Number.isFinite(v))
  const lo = range?.min ?? (finite.length ? Math.min(...finite) : 0)
  const hi = range?.max ?? (finite.length ? Math.max(...finite) : 1)
  const span = hi - lo || 1
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  return values.map((v, i) => {
    const x = values.length > 1 ? pad + i * stepX : width / 2
    const clamped = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
    const y = height - pad - ((clamped - lo) / span) * (height - pad * 2)
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
  })
}

export function Sparkline({
  values,
  width = 100,
  height = 24,
  color = 'var(--bh-teal)',
  area = true,
  min,
  max,
  label,
  class: className,
}: SparklineProps) {
  const pts = sparklinePoints(values, width, height, { min, max })
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const last = pts[pts.length - 1]
  const first = pts[0]
  return (
    <svg
      class={cx('bh-sparkline', className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Trend of ${values.length} values`}
    >
      {area && first && last && (
        <polygon
          points={`${first[0]},${height} ${line} ${last[0]},${height}`}
          style={{ fill: color }}
          opacity="0.15"
        />
      )}
      {pts.length > 0 && (
        <polyline
          points={line}
          fill="none"
          style={{ stroke: color }}
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      )}
      {last && <circle cx={last[0]} cy={last[1]} r="2" style={{ fill: color }} />}
    </svg>
  )
}
