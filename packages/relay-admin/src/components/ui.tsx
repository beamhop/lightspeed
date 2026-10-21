// Admin building blocks composed from the shadcn/ui components in ./ui. Screens import from here so
// spacing, table gutters and field layout stay identical everywhere.

import { Check, Copy, Info, Loader2 } from 'lucide-react'
import {
  Children,
  type ComponentProps,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react'
import { cn } from '@/lib/utils'
import { href } from '../router'
import { Badge as UiBadge } from './ui/badge'
import { Button as UiButton } from './ui/button'
import {
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from './ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input as UiInput } from './ui/input'
import { Label } from './ui/label'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Progress } from './ui/progress'
import {
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Select as UiSelect,
} from './ui/select'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { TabsList, TabsTrigger, Tabs as UiTabs } from './ui/tabs'
import { Textarea } from './ui/textarea'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANT = {
  primary: 'default',
  secondary: 'outline',
  danger: 'destructive',
  ghost: 'ghost',
} as const

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  children,
  disabled,
  ...rest
}: Omit<ComponentProps<typeof UiButton>, 'variant' | 'size'> & {
  variant?: Variant
  size?: 'sm' | 'md' | 'icon'
  loading?: boolean
}) {
  return (
    <UiButton
      type="button"
      variant={VARIANT[variant]}
      size={size === 'md' ? 'default' : size === 'icon' ? 'icon-sm' : 'sm'}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </UiButton>
  )
}

export function Link({
  to,
  children,
  ...rest
}: Omit<ComponentProps<'a'>, 'href'> & { to: string }) {
  return (
    <a href={href(to)} data-nav="" {...rest}>
      {children}
    </a>
  )
}

/** Whether the nearest Card pads its content (null outside a card). Tables bleed to the edges. */
const CardPad = createContext<boolean | null>(null)

export function Card({
  title,
  description,
  help,
  actions,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode
  /** One or two sentences under the title: what this section is and when to use it. */
  description?: ReactNode
  /** Longer explanation behind an (i) button next to the title. */
  help?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** false: content runs edge to edge (tables still line up with the header). */
  pad?: boolean
}) {
  const header = title || description || actions
  return (
    <UiCard className={cn('min-w-0 gap-5', className)}>
      {header && (
        <CardHeader className="max-sm:grid-cols-1!">
          {title && (
            <CardTitle className="flex items-center gap-1.5">
              {title}
              {help && (
                <InfoTip label={typeof title === 'string' ? title : 'this section'}>{help}</InfoTip>
              )}
            </CardTitle>
          )}
          {description && (
            <CardDescription className="max-w-3xl leading-relaxed">{description}</CardDescription>
          )}
          {actions && (
            <CardAction className="col-start-1 row-span-1 row-start-auto flex flex-wrap items-center gap-2 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end">
              {actions}
            </CardAction>
          )}
        </CardHeader>
      )}
      <CardPad.Provider value={pad}>
        <CardContent className={cn('min-w-0', !pad && 'px-0')}>{children}</CardContent>
      </CardPad.Provider>
    </UiCard>
  )
}

type Tone = 'teal' | 'violet' | 'warn' | 'danger' | 'ok'

const DOT: Record<Tone, string> = {
  teal: 'bg-primary',
  violet: 'bg-violet',
  warn: 'bg-warning',
  danger: 'bg-destructive',
  ok: 'bg-success',
}

export function Stat({
  label,
  value,
  hint,
  help,
  tone = 'teal',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  /** What the number means and when to worry, behind an (i) button. */
  help?: ReactNode
  tone?: Tone
}) {
  return (
    <UiCard className="min-w-0 gap-1 px-4 py-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
        <span className="truncate">{label}</span>
        {help && <InfoTip label={label}>{help}</InfoTip>}
      </div>
      <div className="truncate text-2xl font-semibold tabular-nums" data-stat={label}>
        {value}
      </div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </UiCard>
  )
}

const BADGE: Record<'muted' | Tone, string> = {
  muted: 'bg-muted text-muted-foreground',
  teal: 'bg-primary/15 text-primary',
  violet: 'bg-violet/15 text-violet',
  warn: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  ok: 'bg-success/15 text-success',
}

export function Badge({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'muted' | Tone
  children: ReactNode
  className?: string
}) {
  return (
    <UiBadge variant="secondary" className={cn(BADGE[tone], className)}>
      {children}
    </UiBadge>
  )
}

export function Field({
  label,
  hint,
  help,
  error,
  children,
  className,
}: {
  label: string
  /** Short always-visible line under the input (format, units, defaults). */
  hint?: ReactNode
  /** What the setting does and why you would change it, behind an (i) button. */
  help?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
}) {
  const id = useId()
  // Point the label at the control: the single child element gets the id unless it has one.
  const only = Children.count(children) === 1 && isValidElement(children) ? children : null
  const controlId = (only?.props as { id?: string } | undefined)?.id ?? id
  const control = only
    ? cloneElement(only as ReactElement<{ id?: string; 'aria-invalid'?: boolean }>, {
        id: controlId,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children
  return (
    <div className={cn('grid min-w-0 content-start gap-2', className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={only ? controlId : undefined}>{label}</Label>
        {help && <InfoTip label={label}>{help}</InfoTip>}
      </div>
      {control}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function Input({
  onValue,
  onChange,
  ...rest
}: ComponentProps<'input'> & { onValue?: (v: string) => void }) {
  return (
    <UiInput
      {...rest}
      onChange={(e) => {
        onValue?.(e.currentTarget.value)
        onChange?.(e)
      }}
    />
  )
}

export function TextArea({
  onValue,
  onChange,
  className,
  ...rest
}: ComponentProps<'textarea'> & { onValue?: (v: string) => void }) {
  return (
    <Textarea
      {...rest}
      className={cn('font-mono text-xs md:text-xs', className)}
      onChange={(e) => {
        onValue?.(e.currentTarget.value)
        onChange?.(e)
      }}
    />
  )
}

/** Radix Select forbids empty item values, so '' is mapped to a sentinel. */
const EMPTY = '\u0000empty'

export function Select<T extends string>({
  value,
  options,
  onValue,
  className,
  id,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: T
  options: { value: T; label: string }[]
  onValue: (v: T) => void
  className?: string
  id?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <UiSelect
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onValue((v === EMPTY ? '' : v) as T)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value === '' ? EMPTY : o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  help,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: ReactNode
  help?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="grid content-start gap-1.5">
      <div className="flex min-h-9 items-center gap-2">
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {help && <InfoTip label={label}>{help}</InfoTip>}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  stretch,
}: {
  /** Fill the available width (e.g. a small card) instead of sizing to the labels. */
  stretch?: boolean
  value: T
  /** `description` explains the active tab under the tab bar. */
  tabs: { id: T; label: string; description?: ReactNode }[]
  onChange: (t: T) => void
}) {
  const active = tabs.find((t) => t.id === value)
  return (
    <UiTabs value={value} onValueChange={(v) => onChange(v as T)} className="min-w-0 gap-3">
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        <TabsList className={cn(stretch && 'w-full')}>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="px-3">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {active?.description && (
        <p
          className="max-w-3xl text-sm leading-relaxed text-muted-foreground"
          data-tab-description=""
        >
          {active.description}
        </p>
      )}
    </UiTabs>
  )
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  intro,
}: {
  /** Small line above the title, e.g. a breadcrumb. */
  eyebrow?: ReactNode
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  /** "About this page" panel: what the screen is, why it is useful and how to use it. */
  intro?: PageHelp
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {eyebrow && <div className="text-xs text-muted-foreground">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {intro && <PageIntro help={intro} />}
    </>
  )
}

export interface PageHelp {
  /** Stable key for remembering the collapsed state. */
  id: string
  what: ReactNode
  why: ReactNode
  how: ReactNode[]
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
    <UiCard
      className="gap-0 border-primary/25 bg-primary/5 py-0 shadow-none"
      aria-label="About this page"
      data-intro={help.id}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!hidden}
        className="flex w-full items-center justify-between gap-2 rounded-xl px-6 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Info className="size-4 text-primary" />
          About this page
        </span>
        <span className="text-xs text-muted-foreground">{hidden ? 'Show' : 'Hide'}</span>
      </button>
      {!hidden && (
        <div className="grid gap-6 px-6 pb-5 text-sm md:grid-cols-3">
          <IntroColumn title="What it is">
            <p>{help.what}</p>
          </IntroColumn>
          <IntroColumn title="Why it matters">
            <p>{help.why}</p>
          </IntroColumn>
          <IntroColumn title="How to use it">
            <ol className="list-decimal space-y-1 pl-4">
              {help.how.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          </IntroColumn>
        </div>
      )}
    </UiCard>
  )
}

function IntroColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-primary uppercase">{title}</h3>
      <div className="leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

/**
 * Small (i) button that explains the thing next to it. Opens on hover, focus or tap. Clicks stop
 * here so a tip inside a clickable row or next to a field doesn't trigger it.
 */
export function InfoTip({ children, label }: { children: ReactNode; label: string }) {
  const [pinned, setPinned] = useState(false)
  const [hover, setHover] = useState(false)
  const open = pinned || hover
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPinned(false)
          setHover(false)
        }
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={`What is ${label}?`}
        data-infotip=""
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setPinned(!pinned)
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={cn(
          'inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50',
          open && 'text-primary',
        )}
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        role="tooltip"
        side="top"
        collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="w-auto max-w-[300px] px-3 py-2 text-xs leading-relaxed font-normal tracking-normal normal-case"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>
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
      {done ? <Check /> : <Copy />}
      {done ? 'Copied' : label}
    </Button>
  )
}

/** Responsive list: a table on wide screens, stacked cards on phones. */
export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  /** Explains the column, behind an (i) button in the header. */
  help?: ReactNode
  /** Extra classes for the header and cells (e.g. 'text-right', 'whitespace-normal'). */
  className?: string
  /** Hide in the phone card layout. */
  hideOnMobile?: boolean
}

// Inside a card the table runs edge to edge and its first/last columns line up with the card's
// 24px gutter, so headers, rows and the card title share one left edge.
const EDGE = '[&_tr>*:first-child]:pl-6 [&_tr>*:last-child]:pr-6'

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
  actions?: (r: T) => ReactNode
  onRowClick?: (r: T) => void
}) {
  const pad = useContext(CardPad)
  return (
    <>
      <div className={cn('hidden md:block', pad === true && '-mx-6', pad !== null && EDGE)}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c) => (
                <TableHead key={c.key} className={cn('text-muted-foreground', c.className)}>
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {c.help && <InfoTip label={c.label}>{c.help}</InfoTip>}
                  </span>
                </TableHead>
              ))}
              {actions && (
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={rowKey(r)}
                className={cn(onRowClick && 'cursor-pointer')}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <TableCell key={c.key} className={c.className}>
                    {c.render(r)}
                  </TableCell>
                ))}
                {actions && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-2">{actions(r)}</div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className={cn('flex flex-col gap-2 md:hidden', pad === false && 'px-6')}>
        {rows.map((r) => (
          <li
            key={rowKey(r)}
            className={cn(
              'rounded-lg border bg-background/40 p-3',
              onRowClick && 'cursor-pointer active:bg-muted',
            )}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={undefined}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              {columns
                .filter((c) => !c.hideOnMobile)
                .map((c) => (
                  <Fragment key={c.key}>
                    <dt className="inline-flex items-center gap-1 self-center text-xs text-muted-foreground">
                      {c.label}
                      {c.help && <InfoTip label={c.label}>{c.help}</InfoTip>}
                    </dt>
                    <dd className="min-w-0 truncate text-right">{c.render(r)}</dd>
                  </Fragment>
                ))}
            </dl>
            {actions && (
              <div
                className="mt-3 flex justify-end gap-2 border-t pt-3"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={undefined}
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
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  tone?: 'danger' | 'secret'
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-label={title}
        className={cn(
          'max-h-[90dvh] overflow-y-auto',
          tone === 'danger' && 'border-destructive/50',
          tone === 'secret' && 'border-violet/60',
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className="leading-relaxed">{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        <div className="min-w-0 text-sm">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

export function ProgressBar({ value, tone }: { value: number; tone?: 'teal' | 'warn' | 'danger' }) {
  const t = tone ?? (value > 90 ? 'danger' : value > 75 ? 'warn' : 'teal')
  const bar = {
    teal: '*:data-[slot=progress-indicator]:bg-primary',
    warn: '*:data-[slot=progress-indicator]:bg-warning',
    danger: '*:data-[slot=progress-indicator]:bg-destructive',
  }[t]
  return (
    <Progress
      value={Math.max(0, Math.min(100, value))}
      aria-valuenow={Math.round(value)}
      className={cn('h-1.5 bg-muted', bar)}
    />
  )
}
