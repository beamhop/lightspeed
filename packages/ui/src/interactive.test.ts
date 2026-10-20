import { describe, expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Confirm, createToaster, Dialog, Tabs, ToastHost, Toggle } from './index'
import { mount, useDom } from './test-utils'

useDom()

function key(target: EventTarget, k: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

describe('interactive components (happy-dom)', () => {
  test('Tabs: click and arrow keys change selection', () => {
    const el = mount()
    const seen: string[] = []
    const tabs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C', disabled: true },
    ]
    act(() => {
      render(h(Tabs, { tabs, value: 'a', onChange: (id) => seen.push(id) }), el)
    })
    const buttons = el.querySelectorAll('button')
    act(() => (buttons[1] as HTMLButtonElement).click())
    const list = el.querySelector('[role=tablist]') as HTMLElement
    act(() => key(list, 'ArrowRight'))
    act(() => key(list, 'ArrowLeft'))
    act(() => key(list, 'End'))
    // disabled tab 'c' is skipped by keyboard navigation
    expect(seen).toEqual(['b', 'b', 'b', 'b'])
  })

  test('Toggle flips aria-checked through onChange', () => {
    const el = mount()
    let value = false
    const draw = () =>
      render(
        h(Toggle, {
          checked: value,
          label: 'Loss',
          onChange: (v) => {
            value = v
            draw()
          },
        }),
        el,
      )
    act(draw)
    const sw = el.querySelector('[role=switch]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    act(() => sw.click())
    expect(value).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  test('Dialog closes on Escape and backdrop click, not on panel click', () => {
    const el = mount()
    let closed = 0
    act(() => {
      render(h(Dialog, { open: true, title: 'Hi', onClose: () => closed++ }, 'body'), el)
    })
    expect(el.querySelector('[role=dialog]')).not.toBeNull()
    act(() => key(document, 'Escape'))
    expect(closed).toBe(1)
    act(() => (el.querySelector('[role=dialog]') as HTMLElement).click())
    expect(closed).toBe(1)
    act(() => (el.querySelector('.bh-dialog__backdrop') as HTMLElement).click())
    expect(closed).toBe(2)
    act(() => {
      render(h(Dialog, { open: false, title: 'Hi', onClose: () => {} }), el)
    })
    expect(el.querySelector('[role=dialog]')).toBeNull()
  })

  test('Confirm calls confirm/cancel', () => {
    const el = mount()
    const calls: string[] = []
    act(() => {
      render(
        h(Confirm, {
          open: true,
          title: 'Kill peer?',
          danger: true,
          confirmLabel: 'Kill',
          onConfirm: () => calls.push('ok'),
          onCancel: () => calls.push('cancel'),
        }),
        el,
      )
    })
    const btns = Array.from(el.querySelectorAll('.bh-dialog__footer button')) as HTMLButtonElement[]
    expect(btns[1]?.className).toContain('bh-btn--danger')
    act(() => btns[1]?.click())
    act(() => btns[0]?.click())
    expect(calls).toEqual(['ok', 'cancel'])
  })

  test('Toaster shows, auto-dismisses and renders in ToastHost', async () => {
    const t = createToaster()
    const el = mount()
    act(() => {
      render(h(ToastHost, { toaster: t }), el)
    })
    act(() => {
      t.show('Saved', { tone: 'success', duration: 20 })
      t.show('Sticky', { duration: 0 })
    })
    expect(el.querySelectorAll('.bh-toast').length).toBe(2)
    expect(el.querySelector('.bh-toast--success')?.textContent).toContain('Saved')
    await act(() => new Promise((r) => setTimeout(r, 40)))
    expect(t.list().map((x) => x.message)).toEqual(['Sticky'])
    expect(el.querySelectorAll('.bh-toast').length).toBe(1)
    act(() => (el.querySelector('.bh-toast__close') as HTMLButtonElement).click())
    expect(t.list()).toEqual([])
  })
})
