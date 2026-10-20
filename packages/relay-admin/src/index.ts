// Public entry for other workspace packages (e.g. @beamhop/relay serving the SPA, tests).
// The SPA itself starts from src/main.tsx and is built by Vite into ../dist.

export type { AdminApi, ApiOptions } from './api'
export { ApiError, asList, buildQuery, createApi, DEFAULT_POLICY, normalizePolicy } from './api'
export { createMockApi } from './mock/server'
export { backoffDelay, createStatsStream, normalizeStats, statsUrl } from './stats'
export type * from './types'

/** Absolute path of the built SPA (vite build output, served at /admin). */
export const distDir: string = new URL('../dist', import.meta.url).pathname
