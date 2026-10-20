import { describe, expect, test } from 'bun:test'
import { h } from 'preact'
import { renderToString } from 'preact-render-to-string'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  formatBytes,
  IconButton,
  Input,
  Mascot,
  PathBadge,
  Select,
  Sparkline,
  Stat,
  shortKey,
  sparklinePoints,
  Table,
  Tabs,
} from './index'
import type { MascotState } from './tokens'

describe('static rendering', () => {
  test('Button variants and loading state', () => {
    const html = renderToString(h(Button, { variant: 'primary', loading: true }, 'Save'))
    expect(html).toContain('bh-btn--primary')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled')
    expect(html).toContain('bh-btn__spinner')
    expect(html).toContain('Save')
  })

  test('IconButton carries an accessible label', () => {
    const html = renderToString(h(IconButton, { label: 'Close', icon: '×' }))
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('bh-icon-btn')
  })

  test('Card renders title, actions and flush body', () => {
    const html = renderToString(h(Card, { title: 'Peers', actions: 'A', flush: true }, 'body'))
    expect(html).toContain('bh-card__title')
    expect(html).toContain('Peers')
    expect(html).toContain('bh-card__body--flush')
  })

  test('PathBadge maps paths to labels and tones', () => {
    expect(renderToString(h(PathBadge, { path: 'direct' }))).toContain('bh-badge--path-direct')
    const turn = renderToString(h(PathBadge, { path: 'turn' }))
    expect(turn).toContain('TURN')
    expect(turn).toContain('data-path="turn"')
    expect(renderToString(h(PathBadge, { path: 'relay' }))).toContain('bh-badge--path-relay')
    expect(renderToString(h(Badge, { tone: 'danger' }, 'x'))).toContain('bh-badge--danger')
  })

  test('Table renders rows, custom cells and empty state', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]
    const html = renderToString(
      h(Table<{ id: string; n: number }>, {
        columns: [
          { key: 'id', header: 'ID' },
          { key: 'n', header: 'N', render: (r) => `#${r.n * 10}`, align: 'right' },
        ],
        rows,
        rowKey: (r) => r.id,
        selectedKey: 'b',
      }),
    )
    expect(html).toContain('#20')
    expect(html).toContain('bh-table__row--selected')
    const empty = renderToString(
      h(Table<{ id: string }>, {
        columns: [{ key: 'id', header: 'ID' }],
        rows: [],
        rowKey: (r) => r.id,
        empty: 'No peers',
      }),
    )
    expect(empty).toContain('No peers')
  })

  test('Tabs marks the selected tab', () => {
    const html = renderToString(
      h(Tabs, {
        tabs: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', count: 3 },
        ],
        value: 'b',
        onChange: () => {},
      }),
    )
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/aria-selected="true"[^>]*>B/)
    expect(html).toContain('bh-tab__count')
  })

  test('Input and Select render labels wired to controls', () => {
    const input = renderToString(h(Input, { label: 'Relay', value: 'wss://x', error: 'bad' }))
    const id = /for="([^"]+)"/.exec(input)?.[1]
    expect(id).toBeTruthy()
    expect(input).toContain(`id="${id}"`)
    expect(input).toContain('aria-invalid="true"')
    expect(input).toContain('role="alert"')
    const select = renderToString(
      h(Select, {
        label: 'Mode',
        value: 'b',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        onValue: () => {},
      }),
    )
    expect(select).toContain('<select')
    expect(select).toContain('B</option>')
  })

  test('Stat shows value, unit, delta and trend', () => {
    const html = renderToString(
      h(Stat, { label: 'RTT', value: 42, unit: 'ms', delta: -3, trend: [1, 2, 3] }),
    )
    expect(html).toContain('ms')
    expect(html).toContain('bh-stat__delta--down')
    expect(html).toContain('<svg')
  })

  test('EmptyState renders the mascot', () => {
    const html = renderToString(h(EmptyState, { title: 'Nothing', mascot: 'spinner' }))
    expect(html).toContain('data-state="spinner"')
    expect(html).toContain('Nothing')
  })

  test('Mascot renders every state with distinct markup', () => {
    const states: MascotState[] = ['idle', 'spinner', 'smile', 'angry', 'secret']
    const out = states.map((state) => renderToString(h(Mascot, { state, size: 48 })))
    for (const [i, html] of out.entries()) {
      expect(html).toContain(`bh-mascot--${states[i]}`)
      expect(html).toContain('viewBox="0 0 120 120"')
      expect(html).toContain('role="img"')
    }
    expect(new Set(out).size).toBe(states.length)
    expect(out[1]).toContain('animateTransform')
    expect(out[4]).toContain('bh-mascot__paw')
    expect(out[3]).toContain('bh-mascot__steam')
  })
})

describe('sparkline geometry', () => {
  test('maps min to bottom and max to top', () => {
    const pts = sparklinePoints([0, 5, 10], 100, 20, undefined, 0)
    expect(pts).toEqual([
      [0, 20],
      [50, 10],
      [100, 0],
    ])
  })
  test('handles flat, single and empty series', () => {
    expect(sparklinePoints([], 10, 10)).toEqual([])
    expect(sparklinePoints([3], 10, 10, undefined, 0)).toEqual([[5, 10]])
    const flat = sparklinePoints([2, 2], 10, 10, undefined, 0)
    expect(flat.every(([, y]) => y === 10)).toBe(true)
  })
  test('renders an svg polyline', () => {
    const html = renderToString(h(Sparkline, { values: [1, 3, 2] }))
    expect(html).toContain('<polyline')
  })
})

describe('formatting helpers', () => {
  test('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MiB')
    expect(formatBytes(-1)).toBe('–')
  })
  test('shortKey', () => {
    expect(shortKey('abcdef0123456789')).toBe('abcd…6789')
    expect(shortKey('abc')).toBe('abc')
  })
})
