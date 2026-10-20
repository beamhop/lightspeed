/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import type { MascotState } from '../tokens'
import { Mascot } from './Mascot'
import { cx } from './util'

export interface EmptyStateProps {
  title: ComponentChildren
  description?: ComponentChildren
  /** Mascot mood; 'idle' for empty, 'spinner' for loading, 'angry' for errors. */
  mascot?: MascotState | false
  action?: ComponentChildren
  class?: string
}

export function EmptyState({
  title,
  description,
  mascot = 'idle',
  action,
  class: className,
}: EmptyStateProps) {
  return (
    <div class={cx('bh-empty', className)}>
      {mascot && <Mascot state={mascot} size={96} />}
      <div class="bh-empty__title">{title}</div>
      {description && <div class="bh-empty__desc">{description}</div>}
      {action && <div class="bh-empty__action">{action}</div>}
    </div>
  )
}
