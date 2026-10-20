import { isHex64 } from './event'
import type { Filter, NostrEvent } from './types'

const TAG_KEY = /^#[a-zA-Z]$/

/** Validates and normalizes a raw filter object. Returns the filter or an error message. */
export function parseFilter(raw: unknown): Filter | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'filter must be an object'
  const out: Filter = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    switch (k) {
      case 'ids':
      case 'authors': {
        if (!Array.isArray(v) || !v.every(isHex64)) return `${k} must be an array of 64-char hex`
        out[k] = v as string[]
        break
      }
      case 'kinds': {
        if (
          !Array.isArray(v) ||
          !v.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 65535)
        )
          return 'kinds must be an array of integers'
        out.kinds = v as number[]
        break
      }
      case 'since':
      case 'until':
      case 'limit': {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          return `${k} must be a non-negative number`
        out[k] = Math.floor(v)
        break
      }
      case 'search': {
        if (typeof v !== 'string') return 'search must be a string'
        out.search = v
        break
      }
      default: {
        if (TAG_KEY.test(k)) {
          if (!Array.isArray(v) || !v.every((s) => typeof s === 'string'))
            return `${k} must be an array of strings`
          out[k as `#${string}`] = v as string[]
        }
        // Unknown keys are ignored (forward compatibility).
      }
    }
  }
  return out
}

/** Tag filter entries of a filter: [letter, values][]. */
export function tagFilters(f: Filter): [string, string[]][] {
  const out: [string, string[]][] = []
  for (const k in f) {
    if (k.length === 2 && k[0] === '#') {
      const v = f[k as `#${string}`]
      if (v) out.push([k[1] as string, v])
    }
  }
  return out
}

/** Plain words of a NIP-50 search string, with `key:value` extensions removed. */
export function searchWords(search: string): string[] {
  return search
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^[a-z_]+:\S+$/i.test(w))
    .map((w) => w.toLowerCase())
}

/** In-memory match for live subscriptions. Ignores `limit`. */
export function matchFilter(f: Filter, e: NostrEvent): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  if (f.since !== undefined && e.created_at < f.since) return false
  if (f.until !== undefined && e.created_at > f.until) return false
  for (const k in f) {
    if (k.length === 2 && k[0] === '#') {
      const values = f[k as `#${string}`]
      if (!values) continue
      const name = k[1]
      let hit = false
      for (const t of e.tags) {
        if (t[0] === name && t[1] !== undefined && values.includes(t[1])) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
  }
  if (f.search !== undefined) {
    const words = searchWords(f.search)
    if (words.length > 0) {
      const content = e.content.toLowerCase()
      for (const w of words) if (!content.includes(w)) return false
    }
  }
  return true
}

export const matchFilters = (fs: Filter[], e: NostrEvent) => fs.some((f) => matchFilter(f, e))
