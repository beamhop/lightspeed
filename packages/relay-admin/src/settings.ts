// Theme and settings helpers. DOM-free apart from the guarded document/localStorage access.

import type { Settings as SettingsT } from './types'

export const THEME_KEY = 'bh-admin-theme'

export function applyTheme(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function storedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** Field-by-field summary of a settings change for the confirmation dialog. */
export function diffSettings(a: SettingsT, b: SettingsT, prefix = ''): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = (a as unknown as Record<string, unknown>)[k]
    const y = (b as unknown as Record<string, unknown>)[k]
    const path = prefix ? `${prefix}.${k}` : k
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x))
      out.push(...diffSettings(x as SettingsT, y as SettingsT, path))
    else if (JSON.stringify(x) !== JSON.stringify(y))
      out.push(`${path}: ${JSON.stringify(x ?? null)} → ${JSON.stringify(y ?? null)}`)
  }
  return out
}
