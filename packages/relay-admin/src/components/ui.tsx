/** @jsxImportSource preact */
// Admin-local UI primitives (kept here on purpose; @beamhop/ui only provides tokens to this package).

import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ComponentChildren,
  Fragment,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { href } from '../router'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-teal text-midnight hover:brightness-110 font-semibold',
  secondary: 'bg-raised text-ink border border-line hover:border-teal/60',
  danger: 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
  ghost: 'text-muted hover:text-ink hover:bg-raised',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  class: cls = '',
  loading,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class'> & {
  class?: string
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
}) {
  const sz = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm'
  return (
    <button
      type="button"
      {...(rest as Record<string, unknown>)}
      disabled={rest.disabled || loading}
      class={`inline-flex items-center justify-center gap-1.5 rounded-md transition disabled:opacity-50 disabled:cursor-not-allowed min-h-9 ${sz} ${VARIANTS[variant]} ${cls}`}
    >
      {loading && (
        <span class="inline-block size-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {children}
    </button>
  )
}

export function Link({
  to,
  class: cls = '',
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'class'> & { to: string; class?: string }) {
  return (
    <a href={href(to)} data-nav="" class={cls} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  )
}

export function Card({
  title,
  actions,
  children,
  class: cls = '',
  pad = true,
}: {
  title?: ComponentChildren
  actions?: ComponentChildren
  children?: ComponentChildren
  class?: string
  pad?: boolean
}) {
  return (
    <section class={`rounded-lg bg-surface border border-line ${cls}`}>
      {(title || actions) && (
        <header class="flex items-center justify-between gap-2 px-4 pt-3 pb-2 flex-wrap">
          <h2 class="text-sm font-semibold text-ink">{title}</h2>
          {actions && <div class="flex gap-2 flex-wrap">{actions}</div>}
        </header>
      )}
      <div class={pad ? 'px-4 pb-4' : ''}>{children}</div>
    </section>
  )
}

export function Stat({
  label,
  value,
  hint,
  tone = 'teal',
}: {
  label: string
  value: ComponentChildren
  hint?: ComponentChildren
  tone?: 'teal' | 'violet' | 'warn' | 'danger' | 'ok'
}) {
  const tones = {
    teal: 'bg-teal',
    violet: 'bg-violet',
    warn: 'bg-warn',
    danger: 'bg-danger',
    ok: 'bg-ok',
  }
  return (
    <div class="rounded-lg bg-surface border border-line p-3 min-w-0">
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span class={`size-1.5 rounded-full ${tones[tone]}`} />
        <span class="truncate">{label}</span>
      </div>
      <div class="mt-1 text-xl font-semibold tabular-nums text-ink truncate" data-stat={label}>
        {value}
      </div>
      {hint && <div class="text-xs text-muted mt-0.5 truncate">{hint}</div>}
    </div>
  )
}

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'teal' | 'violet' | 'warn' | 'danger' | 'ok'
  children: ComponentChildren
}) {
  const t = {
    muted: 'bg-raised text-muted',
    teal: 'bg-teal/15 text-teal',
    violet: 'bg-violet/15 text-violet',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    ok: 'bg-ok/15 text-ok',
  }[tone]
  return (
    <span
      class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${t}`}
    >
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ComponentChildren
  error?: string | null
  children: ComponentChildren
}) {
  return (
    <label class="block">
      <span class="block text-xs font-medium text-muted mb-1">{label}</span>
      {children}
      {hint && !error && <span class="block text-[11px] text-muted mt-1">{hint}</span>}
      {error && <span class="block text-[11px] text-danger mt-1">{error}</span>}
    </label>
  )
}

const inputCls =
  'w-full rounded-md bg-midnight border border-line px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-teal focus:outline-none min-h-10'

export function Input({
  class: cls = '',
  onValue,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'class'> & {
  class?: string
  onValue?: (v: string) => void
}) {
  return (
    <input
      {...(rest as Record<string, unknown>)}
      class={`${inputCls} ${cls}`}
      onInput={(e) => {
        onValue?.((e.currentTarget as HTMLInputElement).value)
        rest.onInput?.(e as never)
      }}
    />
  )
}

export function TextArea({
  class: cls = '',
  onValue,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'class'> & {
  class?: string
  onValue?: (v: string) => void
}) {
  return (
    <textarea
      {...(rest as Record<string, unknown>)}
      class={`${inputCls} font-mono text-xs ${cls}`}
      onInput={(e) => onValue?.((e.currentTarget as HTMLTextAreaElement).value)}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onValue,
  class: cls = '',
}: {
  value: T
  options: { value: T; label: string }[]
  onValue: (v: T) => void
  class?: string
}) {
  return (
    <select
      value={value}
      class={`${inputCls} ${cls}`}
      onChange={(e) => onValue((e.currentTarget as HTMLSelectElement).value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      class="flex items-center gap-2 text-sm text-ink min-h-9"
    >
      <span
        class={`relative inline-block h-5 w-9 rounded-full transition ${checked ? 'bg-teal' : 'bg-line'}`}
      >
        <span
          class={`absolute top-0.5 size-4 rounded-full bg-midnight transition-all ${checked ? 'left-4.5' : 'left-0.5'}`}
        />
      </span>
      {label}
    </button>
  )
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T
  tabs: { id: T; label: string }[]
  onChange: (t: T) => void
}) {
  return (
    <div class="-mx-4 px-4 overflow-x-auto" role="tablist">
      <div class="flex gap-1 border-b border-line min-w-max">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            class={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition ${value === t.id ? 'border-teal text-ink font-medium' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ComponentChildren
  actions?: ComponentChildren
}) {
  return (
    <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p class="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div class="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}

export function Mono({
  children,
  class: cls = '',
}: {
  children: ComponentChildren
  class?: string
}) {
  return <span class={`font-mono text-xs ${cls}`}>{children}</span>
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
        } catch {}
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  )
}

/** Responsive list: a table on wide screens, stacked cards on phones. */
export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ComponentChildren
  class?: string
  /** Hide in the phone card layout. */
  hideOnMobile?: boolean
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  actions,
  onRowClick,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (r: T) => string
  actions?: (r: T) => ComponentChildren
  onRowClick?: (r: T) => void
}) {
  return (
    <>
      <div class="hidden md:block overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-muted border-b border-line">
              {columns.map((c) => (
                <th key={c.key} class={`py-2 px-2 font-medium ${c.class ?? ''}`}>
                  {c.label}
                </th>
              ))}
              {actions && <th class="py-2 px-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={rowKey(r)}
                class={`border-b border-line/50 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-raised/60' : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} class={`py-2 px-2 align-middle ${c.class ?? ''}`}>
                    {c.render(r)}
                  </td>
                ))}
                {actions && (
                  <td
                    class="py-2 px-2 text-right whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {actions(r)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul class="md:hidden flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={rowKey(r)}
            class={`rounded-md border border-line bg-midnight/40 p-3 ${onRowClick ? 'active:bg-raised' : ''}`}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
          >
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {columns
                .filter((c) => !c.hideOnMobile)
                .map((c) => (
                  <Fragment key={c.key}>
                    <dt class="text-xs text-muted self-center">{c.label}</dt>
                    <dd class="min-w-0 truncate text-right">{c.render(r)}</dd>
                  </Fragment>
                ))}
            </dl>
            {actions && (
              <div
                class="flex justify-end gap-2 mt-2 pt-2 border-t border-line/60"
                onClick={(e) => e.stopPropagation()}
              >
                {actions(r)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  tone,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ComponentChildren
  footer?: ComponentChildren
  tone?: 'danger' | 'secret'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  const border =
    tone === 'danger' ? 'border-danger/50' : tone === 'secret' ? 'border-violet/60' : 'border-line'
  return (
    <div
      class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        class={`relative w-full sm:max-w-lg max-h-[90dvh] overflow-y-auto rounded-t-2xl sm:rounded-lg bg-surface border ${border} shadow-2xl pb-safe`}
      >
        <div class="px-5 pt-5 pb-2">
          <h2 class="text-lg font-semibold text-ink">{title}</h2>
        </div>
        <div class="px-5 pb-4 text-sm text-ink">{children}</div>
        {footer && (
          <div class="px-5 pb-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function ProgressBar({ value, tone }: { value: number; tone?: 'teal' | 'warn' | 'danger' }) {
  const t = tone ?? (value > 90 ? 'danger' : value > 75 ? 'warn' : 'teal')
  const c = { teal: 'bg-teal', warn: 'bg-warn', danger: 'bg-danger' }[t]
  return (
    <div
      class="h-1.5 w-full rounded-full bg-raised overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={`h-full ${c} transition-all`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}
