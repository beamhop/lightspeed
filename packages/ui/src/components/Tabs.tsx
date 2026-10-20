/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { cx } from './util'

export interface TabItem {
  id: string
  label: ComponentChildren
  /** Small count/badge after the label. */
  count?: number
  disabled?: boolean
}

export interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  /** aria-label for the tablist. */
  label?: string
  class?: string
}

/** Controlled tab strip with roving keyboard focus (Left/Right/Home/End). */
export function Tabs({ tabs, value, onChange, label, class: className }: TabsProps) {
  const enabled = tabs.filter((t) => !t.disabled)
  const move = (delta: number | 'home' | 'end') => {
    const idx = enabled.findIndex((t) => t.id === value)
    let next: number
    if (delta === 'home') next = 0
    else if (delta === 'end') next = enabled.length - 1
    else next = (idx + delta + enabled.length) % enabled.length
    const tab = enabled[next]
    if (tab) onChange(tab.id)
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      class={cx('bh-tabs', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') move(1)
        else if (e.key === 'ArrowLeft') move(-1)
        else if (e.key === 'Home') move('home')
        else if (e.key === 'End') move('end')
        else return
        e.preventDefault()
      }}
    >
      {tabs.map((t) => {
        const selected = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            class={cx('bh-tab', selected && 'bh-tab--active')}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined && <span class="bh-tab__count">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
