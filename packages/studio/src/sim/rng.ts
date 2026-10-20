/** Small seeded PRNG (mulberry32) so simulated rooms are reproducible. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Float in [min, max). */
  range(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  weighted<T>(items: readonly (readonly [T, number])[]): T
  hex(bytes: number): string
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from empty list')
      return items[Math.floor(next() * items.length)] as never
    },
    weighted: (items) => {
      const total = items.reduce((acc, [, w]) => acc + w, 0)
      let r = next() * total
      for (const [item, w] of items) {
        r -= w
        if (r < 0) return item
      }
      return (items[items.length - 1] as readonly [never, number])[0]
    },
    hex: (bytes) => {
      let out = ''
      for (let i = 0; i < bytes; i++)
        out += Math.floor(next() * 256)
          .toString(16)
          .padStart(2, '0')
      return out
    },
  }
  return rng
}
