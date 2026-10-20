// Wires the API client and the stats stream for the running app (real relay or ?mock=1).

import { createApi } from './api'
import { createMockApi, seedHistory } from './mock/server'
import { createStatsStream, statsUrl } from './stats'
import { session } from './store'

export function detectMock(search: string, env: Record<string, unknown> = {}): boolean {
  if (env.VITE_MOCK === '1' || env.VITE_MOCK === 'true') return true
  const p = new URLSearchParams(search)
  return p.get('mock') === '1' || p.get('mock') === 'true'
}

const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}
const loc =
  typeof location !== 'undefined' ? location : { search: '', protocol: 'http:', host: 'localhost' }

export const isMock = detectMock(loc.search, env)
const MOCK_AUTH_KEY = 'bh-admin-mock-signed-in'

function readMockAuth(): boolean {
  try {
    return sessionStorage.getItem(MOCK_AUTH_KEY) === '1'
  } catch {
    return false
  }
}

/** Mock state is in memory; remember the sign-in per tab so reloads keep you on the page. */
export function rememberMockAuth(on: boolean): void {
  if (!isMock) return
  try {
    if (on) sessionStorage.setItem(MOCK_AUTH_KEY, '1')
    else sessionStorage.removeItem(MOCK_AUTH_KEY)
  } catch {}
}

export const mock = isMock ? createMockApi({ latencyMs: 150, signedIn: readMockAuth() }) : null

export const api = createApi({
  ...(mock ? { fetch: mock.fetch } : {}),
  onUnauthorized: () => {
    session.value = null
  },
})

export const stats = createStatsStream({
  url: statsUrl(loc),
  ...(mock ? { createSocket: mock.createSocket, initialHistory: seedHistory() } : {}),
})
