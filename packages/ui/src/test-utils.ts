// Test helpers: register happy-dom globals for the duration of a test file.
import { afterAll, beforeAll } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/** Call at the top level of a test file that needs `document`/`window`. */
export function useDom(): void {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: 'http://localhost/' })
  })
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()
  })
}

/** Create a fresh container attached to the body. */
export function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}
