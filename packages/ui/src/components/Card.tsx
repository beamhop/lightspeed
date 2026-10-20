/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact'
import { cx } from './util'

export interface CardProps extends Omit<JSX.HTMLAttributes<HTMLElement>, 'title'> {
  title?: ComponentChildren
  /** Right-aligned header content (buttons, badges). */
  actions?: ComponentChildren
  /** Removes body padding (for tables and graphs that bleed to the edge). */
  flush?: boolean
  children?: ComponentChildren
}

export function Card({ title, actions, flush, class: className, children, ...rest }: CardProps) {
  return (
    <section {...rest} class={cx('bh-card', className as string)}>
      {(title || actions) && (
        <header class="bh-card__header">
          {title && <h3 class="bh-card__title">{title}</h3>}
          {actions && <div class="bh-card__actions">{actions}</div>}
        </header>
      )}
      <div class={cx('bh-card__body', flush && 'bh-card__body--flush')}>{children}</div>
    </section>
  )
}
