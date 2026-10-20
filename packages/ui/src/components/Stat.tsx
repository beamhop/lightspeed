/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { Sparkline } from './Sparkline'
import { cx } from './util'

export interface StatProps {
  label: ComponentChildren
  value: ComponentChildren
  unit?: string
  /** Signed change; positive renders up/teal, negative down/red. */
  delta?: number
  deltaLabel?: string
  /** Optional history rendered as a sparkline under the value. */
  trend?: readonly number[]
  tone?: 'default' | 'teal' | 'violet' | 'warning' | 'danger'
  class?: string
}

export function Stat({
  label,
  value,
  unit,
  delta,
  deltaLabel,
  trend,
  tone = 'default',
  class: className,
}: StatProps) {
  return (
    <div class={cx('bh-stat', `bh-stat--${tone}`, className)}>
      <div class="bh-stat__label">{label}</div>
      <div class="bh-stat__value">
        {value}
        {unit && <span class="bh-stat__unit">{unit}</span>}
      </div>
      {delta !== undefined && (
        <div
          class={cx('bh-stat__delta', delta >= 0 ? 'bh-stat__delta--up' : 'bh-stat__delta--down')}
        >
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}
          {deltaLabel ? ` ${deltaLabel}` : ''}
        </div>
      )}
      {trend && trend.length > 1 && (
        <Sparkline values={trend} width={120} height={28} class="bh-stat__trend" />
      )}
    </div>
  )
}
