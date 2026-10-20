/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact'
import { cx } from './util'

export type BadgeTone = 'neutral' | 'teal' | 'violet' | 'success' | 'warning' | 'danger'

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  /** Leading status dot. */
  dot?: boolean
  children?: ComponentChildren
}

export function Badge({ tone = 'neutral', dot, class: className, children, ...rest }: BadgeProps) {
  return (
    <span {...rest} class={cx('bh-badge', `bh-badge--${tone}`, className as string)}>
      {dot && <span class="bh-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  )
}

export type Path = 'direct' | 'turn' | 'relay' | 'memory'

const PATH_LABEL: Record<Path, string> = {
  direct: 'direct',
  turn: 'TURN',
  relay: 'relay',
  memory: 'memory',
}

export interface PathBadgeProps extends Omit<BadgeProps, 'tone'> {
  path: Path
}

/** Connection path badge: direct (teal), TURN (violet), relay (amber), memory (muted). */
export function PathBadge({ path, class: className, ...rest }: PathBadgeProps) {
  return (
    <Badge
      {...rest}
      dot
      data-path={path}
      class={cx('bh-badge--path', `bh-badge--path-${path}`, className as string)}
    >
      {PATH_LABEL[path]}
    </Badge>
  )
}
