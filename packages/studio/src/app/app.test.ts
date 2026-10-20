// Smoke test: every Studio view renders against the simulated room in happy-dom.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import type { Tab } from './store'

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: 'http://localhost/' })
})

describe('Studio app', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterAll(async () => {
    await cleanup?.()
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()
  })

  test('renders every view with a simulated room and supports replay', async () => {
    const { App } = await import('./App')
    const store = await import('./store')
    const el = document.createElement('div')
    document.body.appendChild(el)
    cleanup = async () => {
      await store.detach()
      render(null, el)
    }
    act(() => {
      render(h(App, { autoAttach: false, probeServer: false }), el)
    })
    await act(async () => {
      await store.attach({
        ...store.settings.value,
        mode: 'simulated',
        sim: {
          seed: 3,
          peers: 4,
          topology: 'star',
          speed: 1,
          relayFirst: false,
          admission: 'open',
        },
      })
    })
    expect(store.events.value.length).toBeGreaterThan(100)
    expect(el.querySelector('.studio__subtitle')?.textContent).toContain('simulated')
    expect(el.querySelectorAll('.graph__node').length).toBe(4)
    expect(el.querySelectorAll('.graph__host').length).toBe(1)

    const tabs: Tab[] = [
      'inspector',
      'timeline',
      'connection',
      'faults',
      'spawner',
      'health',
      'identity',
      'topology',
    ]
    for (const t of tabs) {
      act(() => {
        store.tab.value = t
      })
      expect(el.querySelector('.studio__main')?.textContent?.length ?? 0).toBeGreaterThan(10)
    }

    // replay: pin to the very start → nothing connected yet
    const start = store.range.value?.start ?? 0
    act(() => store.scrubTo(start))
    expect(store.live.value).toBe(false)
    expect(el.querySelectorAll('.graph__link').length).toBe(0)
    act(() => store.goLive())
    expect(el.querySelectorAll('.graph__link').length).toBe(3)
  })
})
