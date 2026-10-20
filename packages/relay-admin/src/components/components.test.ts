// DOM tests with happy-dom. Globals are registered only for this file and removed afterwards.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { h, render } from 'preact'
import { confirm, pendingConfirm, performWrite, revealOnce } from '../store'
import { ConfirmDialog, RevealOnceModal } from './Dialogs'
import { Mascot, MascotMessage } from './Mascot'
import { DataTable } from './ui'

const tick = () => new Promise((r) => setTimeout(r, 0))

let root: HTMLElement
beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/admin/' })
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterAll(async () => {
  render(null, root)
  await GlobalRegistrator.unregister()
})

function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found')
  ;(el as HTMLElement).click()
}

describe('Mascot', () => {
  test('renders every state as labelled SVG', () => {
    for (const state of ['idle', 'spinner', 'smile', 'angry', 'secret'] as const) {
      render(h(Mascot, { state }), root)
      const svg = root.querySelector('svg')
      expect(svg?.getAttribute('data-mascot')).toBe(state)
      expect(svg?.getAttribute('role')).toBe('img')
    }
    render(h(MascotMessage, { state: 'angry', title: 'Broken' }), root)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Broken')
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
    const scope = root.querySelectorAll('[data-confirm-scope] li')
    expect([...scope].map((li) => li.textContent?.replace('•', '').trim())).toEqual([
      'Allocation a1',
      'Client 1.2.3.4:5000',
    ])
    expect(root.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Kill TURN allocation',
    )
    click(root.querySelector('[data-confirm="ok"]'))
    expect(await p).toEqual({ ok: true, value: 1 })
    await tick()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })

  test('cancel resolves false', async () => {
    render(h(ConfirmDialog, {}), root)
    const p = confirm({ title: 'Delete', action: 'Delete', scope: ['x'] })
    await tick()
    click(root.querySelector('[data-confirm="cancel"]'))
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
    const ok = root.querySelector('[data-confirm="ok"]') as HTMLButtonElement
    expect(ok.disabled).toBe(true)
    const input = root.querySelector('input[aria-label="Confirmation text"]') as HTMLInputElement
    input.value = 'Pixel Party'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect((root.querySelector('[data-confirm="ok"]') as HTMLButtonElement).disabled).toBe(false)
    click(root.querySelector('[data-confirm="ok"]'))
    expect(await p).toBe(true)
    expect(pendingConfirm.value).toBeNull()
  })
})

describe('RevealOnceModal', () => {
  test('requires acknowledgement before closing', async () => {
    render(h(RevealOnceModal, {}), root)
    revealOnce({ title: 'New API key', secrets: [{ label: 'API key', value: 'bh_secret' }] })
    await tick()
    expect(root.querySelector('[data-secret="API key"]')?.textContent).toBe('bh_secret')
    const done = root.querySelector('[data-reveal="done"]') as HTMLButtonElement
    expect(done.disabled).toBe(true)
    click(root.querySelector('input[type="checkbox"]'))
    await tick()
    click(root.querySelector('[data-reveal="done"]'))
    await tick()
    expect(root.querySelector('[data-secret]')).toBeNull()
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
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(root.querySelectorAll('ul li')).toHaveLength(2)
    expect(root.querySelector('tbody')?.textContent).toContain('2.2.2.2')
  })
})
