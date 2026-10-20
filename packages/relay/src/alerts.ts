import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs'
import type { AdminDb } from './db'

export interface Alert {
  id: string
  severity: 'warning' | 'critical'
  kind: 'disk' | 'turn-quota' | 'error-rate' | 'cert-expiry'
  message: string
  acked: boolean
  app?: string
  // Admin SPA field names
  level: 'warning' | 'critical'
  code: string
  createdAt: number
  acknowledged: boolean
  target?: { app?: string }
}

const firstSeen = new Map<string, number>()

export function diskUsage(
  path: string,
): { usedRatio: number; freeBytes: number; totalBytes: number } | null {
  try {
    const s = statfsSync(path)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    return { usedRatio: total ? 1 - free / total : 0, freeBytes: free, totalBytes: total }
  } catch {
    return null
  }
}

const certCache = new Map<string, { mtime: number; validTo: number }>()

/** Certificate notAfter as unix seconds (null if unreadable). */
export function certExpiry(path: string): number | null {
  if (!path || !existsSync(path)) return null
  try {
    const mtime = statSync(path).mtimeMs
    const hit = certCache.get(path)
    if (hit && hit.mtime === mtime) return hit.validTo
    const cert = new X509Certificate(readFileSync(path))
    const validTo = Math.floor(new Date(cert.validTo).getTime() / 1000)
    certCache.set(path, { mtime, validTo })
    return validTo
  } catch {
    return null
  }
}

export interface AlertInputs {
  dataDir: string
  diskPercent: number
  errorRate: number | null
  errorRateThreshold: number
  certPath: string
  certDays: number
  /** Apps whose TURN monthly quota is used up. */
  turnQuotaExhausted: { app: string; used: number; quota: number }[]
}

/** Evaluate the built-in alerts and merge acknowledgements from admin.db. */
export function evaluateAlerts(adb: AdminDb, i: AlertInputs): Alert[] {
  const out: Pick<Alert, 'id' | 'severity' | 'kind' | 'message' | 'app'>[] = []
  const disk = diskUsage(i.dataDir)
  if (disk && disk.usedRatio * 100 > i.diskPercent) {
    out.push({
      id: 'disk',
      kind: 'disk',
      severity: disk.usedRatio > 0.95 ? 'critical' : 'warning',
      message: `Disk ${(disk.usedRatio * 100).toFixed(1)}% used (threshold ${i.diskPercent}%)`,
    })
  }
  for (const q of i.turnQuotaExhausted) {
    out.push({
      id: `turn-quota:${q.app}`,
      kind: 'turn-quota',
      severity: 'warning',
      app: q.app,
      message: `App ${q.app} used its monthly TURN quota (${q.used} of ${q.quota} bytes)`,
    })
  }
  if (i.errorRate !== null && i.errorRate > i.errorRateThreshold) {
    out.push({
      id: 'error-rate',
      kind: 'error-rate',
      severity: i.errorRate > 0.25 ? 'critical' : 'warning',
      message: `HTTP error rate ${(i.errorRate * 100).toFixed(1)}% over 5 minutes`,
    })
  }
  const exp = certExpiry(i.certPath)
  if (exp !== null) {
    const days = (exp - adb.now()) / 86400
    if (days < i.certDays) {
      out.push({
        id: 'cert-expiry',
        kind: 'cert-expiry',
        severity: days < 3 ? 'critical' : 'warning',
        message:
          days <= 0
            ? 'TLS certificate has expired'
            : `TLS certificate expires in ${Math.floor(days)} days`,
      })
    }
  }
  const acks = new Set(
    (adb.db.query('SELECT id FROM alert_acks').all() as { id: string }[]).map((r) => r.id),
  )
  const active = new Set(out.map((a) => a.id))
  for (const id of acks)
    if (!active.has(id)) adb.db.query('DELETE FROM alert_acks WHERE id = ?').run(id)
  for (const id of firstSeen.keys()) if (!active.has(id)) firstSeen.delete(id)
  return out.map((a) => {
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, adb.now())
    const acked = acks.has(a.id)
    return {
      ...a,
      acked,
      level: a.severity,
      code: a.kind,
      createdAt: firstSeen.get(a.id) as number,
      acknowledged: acked,
      ...(a.app ? { target: { app: a.app } } : {}),
    }
  })
}

export function ackAlert(adb: AdminDb, id: string, by: string) {
  adb.db
    .query(
      'INSERT INTO alert_acks (id, acked_at, acked_by) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET acked_at = excluded.acked_at, acked_by = excluded.acked_by',
    )
    .run(id, adb.now(), by)
}
