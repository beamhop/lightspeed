import type { AdminDb } from './db'

export type UsageMetric =
  | 'turn_bytes_in'
  | 'turn_bytes_out'
  | 'data_bytes_in'
  | 'data_bytes_out'
  | 'blossom_bytes_uploaded'
  | 'turn_credentials'

export const TURN_METRICS: UsageMetric[] = ['turn_bytes_in', 'turn_bytes_out']
export const DATA_METRICS: UsageMetric[] = ['data_bytes_in', 'data_bytes_out']

/**
 * Hot-path byte accounting: counters accumulate in memory and are flushed to admin.db's daily
 * usage table periodically. Lifetime totals per app feed /metrics.
 */
export class UsageMeter {
  private pending = new Map<string, number>()
  readonly totals = new Map<string, number>()
  private monthCache = new Map<string, { at: number; value: number }>()

  constructor(private adb: AdminDb) {}

  add(appId: string, metric: UsageMetric, value: number) {
    if (!value) return
    const k = `${appId}\u0000${metric}`
    this.pending.set(k, (this.pending.get(k) ?? 0) + value)
    this.totals.set(k, (this.totals.get(k) ?? 0) + value)
  }

  flush() {
    if (!this.pending.size) return
    const entries = [...this.pending]
    this.pending.clear()
    this.adb.db.transaction(() => {
      for (const [k, v] of entries) {
        const [appId, metric] = k.split('\u0000') as [string, string]
        this.adb.addUsage(appId, metric, v)
      }
    })()
    this.monthCache.clear()
  }

  /** Month-to-date usage including unflushed bytes. DB reads are cached for 5 s. */
  month(appId: string, metrics: UsageMetric[]): number {
    const key = `${appId}\u0000${metrics.join(',')}`
    const t = Date.now()
    let c = this.monthCache.get(key)
    if (!c || t - c.at > 5000) {
      c = { at: t, value: this.adb.monthUsage(appId, metrics) }
      this.monthCache.set(key, c)
    }
    let pending = 0
    for (const m of metrics) pending += this.pending.get(`${appId}\u0000${m}`) ?? 0
    return c.value + pending
  }

  /** Lifetime totals (since process start) as { app, metric, value } rows. */
  totalRows(): { app: string; metric: string; value: number }[] {
    return [...this.totals].map(([k, value]) => {
      const [app, metric] = k.split('\u0000') as [string, string]
      return { app, metric, value }
    })
  }
}
