/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { cx } from './util'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastItem {
  id: number
  message: ComponentChildren
  tone: ToastTone
  /** ms; 0 keeps the toast until dismissed. */
  duration: number
}

export interface Toaster {
  show(message: ComponentChildren, opts?: { tone?: ToastTone; duration?: number }): number
  dismiss(id: number): void
  list(): readonly ToastItem[]
  subscribe(cb: (items: readonly ToastItem[]) => void): () => void
}

/** Framework-free toast store; pair with <ToastHost toaster={...} />. */
export function createToaster(): Toaster {
  let items: ToastItem[] = []
  let next = 1
  const subs = new Set<(items: readonly ToastItem[]) => void>()
  const emit = () => {
    for (const s of subs) s(items)
  }
  const api: Toaster = {
    show(message, opts = {}) {
      const id = next++
      const duration = opts.duration ?? 4000
      items = [...items, { id, message, tone: opts.tone ?? 'info', duration }]
      emit()
      if (duration > 0) setTimeout(() => api.dismiss(id), duration)
      return id
    },
    dismiss(id) {
      const before = items.length
      items = items.filter((t) => t.id !== id)
      if (items.length !== before) emit()
    },
    list: () => items,
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
  }
  return api
}

/** Shared default toaster. */
export const toaster = createToaster()
export const toast = (message: ComponentChildren, opts?: { tone?: ToastTone; duration?: number }) =>
  toaster.show(message, opts)

export function ToastHost({ toaster: t = toaster }: { toaster?: Toaster }) {
  const [items, setItems] = useState<readonly ToastItem[]>(t.list())
  useEffect(() => t.subscribe(setItems), [t])
  return (
    <div class="bh-toasts" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'danger' ? 'alert' : 'status'}
          class={cx('bh-toast', `bh-toast--${item.tone}`)}
        >
          <span class="bh-toast__msg">{item.message}</span>
          <button
            type="button"
            class="bh-toast__close"
            aria-label="Dismiss"
            onClick={() => t.dismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
