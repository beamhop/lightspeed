// Hybrid logical clock (Kulkarni et al.): physical ms + logical counter + node id tiebreak.

export interface Hlc {
  /** Physical component, ms since epoch. */
  t: number
  /** Logical counter. */
  c: number
  /** Node id (session pubkey) used as a final tiebreak. */
  n: string
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1
  if (a.c !== b.c) return a.c < b.c ? -1 : 1
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0
}

export class HlcClock {
  private last: Hlc

  constructor(
    readonly node: string,
    private now: () => number,
    /** Ignore remote timestamps further than this ahead of local time (ms). */
    private maxDriftMs = 60_000,
  ) {
    this.last = { t: 0, c: 0, n: node }
  }

  /** Timestamp for a local event. */
  tick(): Hlc {
    const pt = this.now()
    if (pt > this.last.t) this.last = { t: pt, c: 0, n: this.node }
    else this.last = { t: this.last.t, c: this.last.c + 1, n: this.node }
    return this.last
  }

  /** Merge a remote timestamp on receive. */
  receive(r: Hlc): void {
    const pt = this.now()
    if (r.t - pt > this.maxDriftMs) return
    const t = Math.max(pt, this.last.t, r.t)
    let c: number
    if (t === this.last.t && t === r.t) c = Math.max(this.last.c, r.c) + 1
    else if (t === this.last.t) c = this.last.c + 1
    else if (t === r.t) c = r.c + 1
    else c = 0
    this.last = { t, c, n: this.node }
  }
}

export function isHlc(v: unknown): v is Hlc {
  const h = v as Hlc
  return !!h && typeof h.t === 'number' && typeof h.c === 'number' && typeof h.n === 'string'
}
