// DOM tests with happy-dom. Globals are registered only for this file and removed afterwards.
// React DOM and Radix check for a DOM when they load, so they are imported after registering.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { PAGE_HELP } from '../help'
import { confirm, pendingConfirm, performWrite, revealOnce } from '../store'

GlobalRegistrator.register({ url: 'http://localhost/admin/' })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, createElement: h } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ConfirmDialog, RevealOnceModal } = await import('./Dialogs')
const { NAV } = await import('./Layout')
const { Mascot, MascotMessage } = await import('./Mascot')
const { DataTable, Field, InfoTip, Input, PageIntro, Tabs } = await import('./ui')

const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))

// Dialogs and popovers portal into document.body, so queries look at the whole document.
let root: HTMLElement
let reactRoot: Root | null = null
function render(node: ReactNode | null, el: HTMLElement) {
  act(() => {
    if (node === null) {
      reactRoot?.unmount()
      reactRoot = null
      return
    }
    reactRoot ??= createRoot(el)
    reactRoot.render(node)
  })
}
const $ = (sel: string) => document.querySelector(sel)
const $$ = (sel: string) => document.querySelectorAll(sel)

beforeAll(() => {
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterAll(async () => {
  render(null, root)
  await GlobalRegistrator.unregister()
})

/** Set an input's value the way a user would, so React's change tracking sees it. */
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  act(() => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found')
  act(() => (el as HTMLElement).click())
}

describe('Mascot', () => {
  test('renders every state as labelled SVG', () => {
    for (const state of ['idle', 'spinner', 'smile', 'angry', 'secret'] as const) {
      render(h(Mascot, { state }), root)
      const svg = $('svg')
      expect(svg?.getAttribute('data-mascot')).toBe(state)
      expect(svg?.getAttribute('role')).toBe('img')
    }
    render(h(MascotMessage, { state: 'angry', title: 'Broken' }), root)
    expect($('[role="alert"]')?.textContent).toContain('Broken')
  })
})

describe('ConfirmDialog', () => {
  test('shows scope and resolves on confirm', async () => {
    render(h(ConfirmDialog, {}), root)
    let ran = 0
    const p = performWrite({
      title: 'Kill TURN allocation',
      action: 'Kill allocation',
      danger: true,
      scope: ['Allocation a1', 'Client 1.2.3.4:5000'],
      run: async () => ++ran,
    })
    await tick()
    const scope = $$('[data-confirm-scope] li')
    expect([...scope].map((li) => li.textContent?.replace('•', '').trim())).toEqual([
      'Allocation a1',
      'Client 1.2.3.4:5000',
    ])
    expect($('[role="dialog"]')?.getAttribute('aria-label')).toBe('Kill TURN allocation')
    click($('[data-confirm="ok"]'))
    expect(await p).toEqual({ ok: true, value: 1 })
    await tick()
    expect($('[role="dialog"]')).toBeNull()
  })

  test('cancel resolves false', async () => {
    render(h(ConfirmDialog, {}), root)
    const p = confirm({ title: 'Delete', action: 'Delete', scope: ['x'] })
    await tick()
    click($('[data-confirm="cancel"]'))
    expect(await p).toBe(false)
  })

  test('type-to-confirm gates the action button', async () => {
    render(h(ConfirmDialog, {}), root)
    const p = confirm({
      title: 'Delete app',
      action: 'Delete app',
      danger: true,
      typeToConfirm: 'Pixel Party',
      scope: ['App Pixel Party'],
    })
    await tick()
    const ok = $('[data-confirm="ok"]') as HTMLButtonElement
    expect(ok.disabled).toBe(true)
    typeInto($('input[aria-label="Confirmation text"]') as HTMLInputElement, 'Pixel Party')
    await tick()
    expect(($('[data-confirm="ok"]') as HTMLButtonElement).disabled).toBe(false)
    click($('[data-confirm="ok"]'))
    expect(await p).toBe(true)
    expect(pendingConfirm.value).toBeNull()
  })
})

describe('RevealOnceModal', () => {
  test('requires acknowledgement before closing', async () => {
    render(h(RevealOnceModal, {}), root)
    revealOnce({ title: 'New API key', secrets: [{ label: 'API key', value: 'bh_secret' }] })
    await tick()
    expect($('[data-secret="API key"]')?.textContent).toBe('bh_secret')
    const done = $('[data-reveal="done"]') as HTMLButtonElement
    expect(done.disabled).toBe(true)
    click($('[role="checkbox"]'))
    await tick()
    click($('[data-reveal="done"]'))
    await tick()
    expect($('[data-secret]')).toBeNull()
  })
})

describe('DataTable', () => {
  test('renders table and phone cards', () => {
    render(
      h(DataTable<{ id: string; ip: string }>, {
        rows: [
          { id: 'a', ip: '1.1.1.1' },
          { id: 'b', ip: '2.2.2.2' },
        ],
        rowKey: (r) => r.id,
        columns: [{ key: 'ip', label: 'IP', render: (r) => r.ip }],
      }),
      root,
    )
    expect($$('tbody tr')).toHaveLength(2)
    expect($$('ul li')).toHaveLength(2)
    expect($('tbody')?.textContent).toContain('2.2.2.2')
  })
})

describe('Explanations', () => {
  test('every nav screen has a what / why / how intro', () => {
    const ids = Object.keys(PAGE_HELP)
    for (const n of NAV) {
      const key = n.to === '/' ? 'overview' : n.to.slice(1)
      expect(ids).toContain(key)
      const h = PAGE_HELP[key as keyof typeof PAGE_HELP]
      expect(h.what).toBeTruthy()
      expect(h.why).toBeTruthy()
      expect(h.how.length).toBeGreaterThan(0)
    }
  })

  test('PageIntro collapses and remembers it per browser', async () => {
    localStorage.clear()
    render(h(PageIntro, { help: PAGE_HELP.turn }), root)
    expect(root.textContent).toContain('How to use it')
    click($('[data-intro="turn"] button'))
    await tick()
    expect(root.textContent).not.toContain('How to use it')
    expect(localStorage.getItem('bh-admin-intro:turn')).toBe('hidden')
    render(null, root)
    render(h(PageIntro, { help: PAGE_HELP.turn }), root)
    expect($('[data-intro="turn"] button')?.getAttribute('aria-expanded')).toBe('false')
    click($('[data-intro="turn"] button'))
    await tick()
    expect(localStorage.getItem('bh-admin-intro:turn')).toBeNull()
  })

  test('InfoTip toggles on tap without focusing the field it labels', async () => {
    render(
      h(Field, {
        label: 'Port',
        help: 'Where TURN listens',
        children: h(Input, { value: '3478' }),
      }),
      root,
    )
    const tip = $('[data-infotip]') as HTMLElement
    expect(tip.getAttribute('aria-label')).toBe('What is Port?')
    expect($('[role="tooltip"]')).toBeNull()
    click(tip)
    await tick()
    expect($('[role="tooltip"]')?.textContent).toBe('Where TURN listens')
    expect(document.activeElement).not.toBe($('input'))
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await tick()
    expect($('[role="tooltip"]')).toBeNull()
  })

  test('InfoTip in a clickable row does not trigger the row', async () => {
    let clicks = 0
    render(
      h(DataTable<{ id: string }>, {
        rows: [{ id: 'a' }],
        rowKey: (r) => r.id,
        onRowClick: () => clicks++,
        columns: [{ key: 'id', label: 'ID', help: 'The id', render: (r) => r.id }],
      }),
      root,
    )
    click($('ul [data-infotip]'))
    await tick()
    expect(clicks).toBe(0)
    render(h(InfoTip, { label: 'Standalone', children: 'ok' }), root)
    expect($('[data-infotip]')?.getAttribute('aria-label')).toBe('What is Standalone?')
  })

  test('Tabs explain the active tab', () => {
    render(
      h(Tabs<'a' | 'b'>, {
        value: 'b',
        onChange: () => {},
        tabs: [
          { id: 'a', label: 'A', description: 'about A' },
          { id: 'b', label: 'B', description: 'about B' },
        ],
      }),
      root,
    )
    expect($('[data-tab-description]')?.textContent).toBe('about B')
  })
})
