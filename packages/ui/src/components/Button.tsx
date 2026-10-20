/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact'
import { cx } from './util'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'size'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows an inline spinner and disables the button. */
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  children?: ComponentChildren
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  class: className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      class={cx('bh-btn', `bh-btn--${variant}`, `bh-btn--${size}`, className as string)}
    >
      {loading && <span class="bh-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Accessible label; required because the button has no text. */
  label: string
  icon: ComponentChildren
}

export function IconButton({ label, icon, class: className, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      aria-label={label}
      title={label}
      class={cx('bh-icon-btn', className as string)}
    >
      {icon}
    </Button>
  )
}
