/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Button } from './Button'
import { cx, uid } from './util'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ComponentChildren
  children?: ComponentChildren
  /** Footer content, usually buttons. */
  footer?: ComponentChildren
  /** Close when the backdrop is clicked (default true). */
  dismissable?: boolean
  size?: 'sm' | 'md' | 'lg'
}

/** Modal dialog. Escape and backdrop click close it; focus moves into the panel on open. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  dismissable = true,
  size = 'md',
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useRef(uid('bh-dialog')).current

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose()
    }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])

  if (!open) return null
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Escape is handled on document; the backdrop click is a mouse-only convenience.
    <div
      class="bh-dialog__backdrop"
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        class={cx('bh-dialog', `bh-dialog--${size}`)}
      >
        <header class="bh-dialog__header">
          <h2 id={titleId} class="bh-dialog__title">
            {title}
          </h2>
          {dismissable && (
            <button type="button" class="bh-dialog__close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </header>
        <div class="bh-dialog__body">{children}</div>
        {footer && <footer class="bh-dialog__footer">{footer}</footer>}
      </div>
    </div>
  )
}

export interface ConfirmProps {
  open: boolean
  title: ComponentChildren
  message?: ComponentChildren
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function Confirm({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Dialog>
  )
}
