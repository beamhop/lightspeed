/** HTTP request counters plus a sliding 5-minute window for the error-rate alert. */
export class HttpCounters {
  readonly byClass = new Map<string, number>()
  readonly byRoute = new Map<string, number>()
  private buckets: { t: number; total: number; errors: number }[] = []

  constructor(private now: () => number = Date.now) {}

  record(route: string, status: number) {
    const cls = `${Math.floor(status / 100)}xx`
    this.byClass.set(cls, (this.byClass.get(cls) ?? 0) + 1)
    this.byRoute.set(route, (this.byRoute.get(route) ?? 0) + 1)
    const t = Math.floor(this.now() / 10_000)
    let b = this.buckets[this.buckets.length - 1]
    if (!b || b.t !== t) {
      b = { t, total: 0, errors: 0 }
      this.buckets.push(b)
      while (this.buckets.length > 30) this.buckets.shift()
    }
    b.total++
    if (status >= 500) b.errors++
  }

  /** Fraction of 5xx over the last 5 minutes; null when there were fewer than 20 requests. */
  errorRate(): number | null {
    const min = Math.floor(this.now() / 10_000) - 30
    let total = 0
    let errors = 0
    for (const b of this.buckets) {
      if (b.t <= min) continue
      total += b.total
      errors += b.errors
    }
    return total < 20 ? null : errors / total
  }
}

export interface MetricSample {
  name: string
  help: string
  type: 'gauge' | 'counter'
  values: { labels?: Record<string, string>; value: number }[]
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

/** Prometheus text exposition format 0.0.4. */
export function renderPrometheus(samples: MetricSample[]): string {
  const out: string[] = []
  for (const s of samples) {
    out.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`)
    for (const v of s.values) {
      const labels =
        v.labels && Object.keys(v.labels).length
          ? `{${Object.entries(v.labels)
              .map(([k, x]) => `${k}="${esc(x)}"`)
              .join(',')}}`
          : ''
      out.push(`${s.name}${labels} ${Number.isFinite(v.value) ? v.value : 0}`)
    }
  }
  return `${out.join('\n')}\n`
}
