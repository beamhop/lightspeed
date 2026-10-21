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
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
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
  description,
  help,
  actions,
  children,
  class: cls = '',
  pad = true,
}: {
  title?: ComponentChildren
  /** One or two sentences under the title: what this section is and when to use it. */
  description?: ComponentChildren
  /** Longer explanation behind an (i) button next to the title. */
  help?: ComponentChildren
  actions?: ComponentChildren
  children?: ComponentChildren
  class?: string
  pad?: boolean
}) {
  return (
    <section class={`rounded-lg bg-surface border border-line ${cls}`}>
      {(title || actions) && (
        <header class="flex items-center justify-between gap-2 px-4 pt-3 pb-2 flex-wrap">
          <h2 class="text-sm font-semibold text-ink inline-flex items-center gap-1.5">
            {title}
            {help && (
              <InfoTip label={typeof title === 'string' ? title : 'this section'}>{help}</InfoTip>
            )}
          </h2>
          {actions && <div class="flex gap-2 flex-wrap">{actions}</div>}
        </header>
      )}
      {description && (
        <p
          class={`px-4 pb-3 text-xs text-muted leading-relaxed max-w-3xl ${title || actions ? '-mt-1' : 'pt-3'}`}
        >
          {description}
        </p>
      )}
      <div class={pad ? 'px-4 pb-4' : ''}>{children}</div>
    </section>
  )
}

export function Stat({
  label,
  value,
  hint,
  help,
  tone = 'teal',
}: {
  label: string
  value: ComponentChildren
  hint?: ComponentChildren
  /** What the number means and when to worry, behind an (i) button. */
  help?: ComponentChildren
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
        {help && <InfoTip label={label}>{help}</InfoTip>}
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
  help,
  error,
  children,
}: {
  label: string
  /** Short always-visible line under the input (format, units, defaults). */
  hint?: ComponentChildren
  /** What the setting does and why you would change it, behind an (i) button. */
  help?: ComponentChildren
  error?: string | null
  children: ComponentChildren
}) {
  return (
    <label class="block">
      <span class="flex items-center gap-1 text-xs font-medium text-muted mb-1">
        {label}
        {help && <InfoTip label={label}>{help}</InfoTip>}
      </span>
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
  hint,
  help,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: ComponentChildren
  help?: ComponentChildren
}) {
  const sw = (
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
  if (!hint && !help) return sw
  return (
    <div>
      <div class="flex items-center gap-1.5">
        {sw}
        {help && <InfoTip label={label}>{help}</InfoTip>}
      </div>
      {hint && <p class="text-[11px] text-muted -mt-1">{hint}</p>}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T
  /** `description` explains the active tab under the tab bar. */
  tabs: { id: T; label: string; description?: ComponentChildren }[]
  onChange: (t: T) => void
}) {
  const active = tabs.find((t) => t.id === value)
  return (
    <>
      <div class="-mx-4 px-4 overflow-x-auto [scrollbar-width:none]" role="tablist">
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
      {active?.description && (
        <p class="pt-3 text-sm text-muted leading-relaxed max-w-3xl" data-tab-description="">
          {active.description}
        </p>
      )}
    </>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
  intro,
}: {
  title: string
  subtitle?: ComponentChildren
  actions?: ComponentChildren
  /** "About this page" panel: what the screen is, why it is useful and how to use it. */
  intro?: PageHelp
}) {
  return (
    <>
      <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div class="min-w-0">
          <h1 class="text-xl font-semibold text-ink">{title}</h1>
          {subtitle && <p class="text-sm text-muted mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div class="flex gap-2 flex-wrap items-center">{actions}</div>}
      </div>
      {intro && <PageIntro help={intro} />}
    </>
  )
}

export interface PageHelp {
  /** Stable key for remembering the collapsed state. */
  id: string
  what: ComponentChildren
  why: ComponentChildren
  how: ComponentChildren[]
}

const INTRO_KEY = 'bh-admin-intro:'

function introCollapsed(id: string): boolean {
  try {
    return localStorage.getItem(INTRO_KEY + id) === 'hidden'
  } catch {
    return false
  }
}

/** Collapsible explainer shown at the top of a screen. Open by default; collapse is per browser. */
export function PageIntro({ help }: { help: PageHelp }) {
  const [hidden, setHidden] = useState(() => introCollapsed(help.id))
  const toggle = () => {
    const next = !hidden
    setHidden(next)
    try {
      if (next) localStorage.setItem(INTRO_KEY + help.id, 'hidden')
      else localStorage.removeItem(INTRO_KEY + help.id)
    } catch {}
  }
  return (
    <section
      class="mb-4 rounded-lg border border-teal/25 bg-teal/5"
      aria-label="About this page"
      data-intro={help.id}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!hidden}
        class="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <span class="inline-flex items-center gap-2 text-sm font-medium text-ink">
          <span class="inline-flex size-5 items-center justify-center rounded-full bg-teal/15 text-teal text-xs font-semibold">
            ?
          </span>
          About this page
        </span>
        <span class="text-xs text-muted">{hidden ? 'Show' : 'Hide'}</span>
      </button>
      {!hidden && (
        <div class="grid gap-4 px-4 pb-4 md:grid-cols-3 text-sm">
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-teal mb-1">What it is</h3>
            <p class="text-muted leading-relaxed">{help.what}</p>
          </div>
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-teal mb-1">
              Why it matters
            </h3>
            <p class="text-muted leading-relaxed">{help.why}</p>
          </div>
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-teal mb-1">
              How to use it
            </h3>
            <ol class="list-decimal pl-4 space-y-1 text-muted leading-relaxed">
              {help.how.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Small (i) button that explains the thing next to it. Opens on hover, focus or tap; the panel is
 * fixed-positioned so it is never clipped by truncating or scrolling parents. It is a span (not a
 * button) so it can live inside a <label> without stealing the label's click.
 */
export function InfoTip({ children, label }: { children: ComponentChildren; label: string }) {
  const [pinned, setPinned] = useState(false)
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number }>()
  const trigger = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const id = useId()
  const open = pinned || hover

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const r = trigger.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(300, vw - 16)
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, vw - width - 8))
    setPos(
      r.top > vh * 0.6
        ? { left, width, bottom: vh - r.top + 6 }
        : { left, width, top: r.bottom + 6 },
    )
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => {
      setPinned(false)
      setHover(false)
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!trigger.current?.contains(t) && !panel.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const toggle = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    setPinned(!pinned)
  }
  return (
    <span class="relative inline-flex shrink-0 normal-case tracking-normal font-normal">
      <span
        ref={trigger}
        role="button"
        tabIndex={0}
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        data-infotip=""
        onClick={toggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggle(e)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        class={`inline-flex size-4 cursor-help items-center justify-center rounded-full border text-[10px] font-semibold leading-none transition ${open ? 'border-teal text-teal' : 'border-line text-muted hover:border-teal/60 hover:text-teal'}`}
      >
        i
      </span>
      {open && pos && (
        <span
          ref={panel}
          id={id}
          role="tooltip"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            left: `${pos.left}px`,
            width: `${pos.width}px`,
            top: pos.top === undefined ? undefined : `${pos.top}px`,
            bottom: pos.bottom === undefined ? undefined : `${pos.bottom}px`,
          }}
          class="fixed z-[60] block rounded-md border border-line bg-raised px-3 py-2 text-xs font-normal leading-relaxed text-ink shadow-xl whitespace-normal text-left"
        >
          {children}
        </span>
      )}
    </span>
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
  /** Explains the column, behind an (i) button in the header. */
  help?: ComponentChildren
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
                  <span class="inline-flex items-center gap-1">
                    {c.label}
                    {c.help && <InfoTip label={c.label}>{c.help}</InfoTip>}
                  </span>
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
                    <dt class="text-xs text-muted self-center inline-flex items-center gap-1">
                      {c.label}
                      {c.help && <InfoTip label={c.label}>{c.help}</InfoTip>}
                    </dt>
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
  description,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** What submitting this dialog will do. */
  description?: ComponentChildren
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
          {description && <p class="mt-1 text-sm text-muted leading-relaxed">{description}</p>}
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
