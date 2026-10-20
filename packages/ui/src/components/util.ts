/** Join class names, skipping falsy entries. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

let idCounter = 0
/** Stable-enough unique id for aria wiring (SSR-safe: deterministic order). */
export function uid(prefix = 'bh'): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

/** Human-readable byte count: 0 B, 1.2 KiB, 3.4 MiB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Short form of a hex pubkey: `ab12…ef90`. */
export function shortKey(hex: string, n = 4): string {
  if (hex.length <= n * 2 + 1) return hex
  return `${hex.slice(0, n)}…${hex.slice(-n)}`
}
