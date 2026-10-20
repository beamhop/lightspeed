import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface BackupFile {
  name: string
  size: number
  createdAt: number
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

/** SQLite string literal. */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * Online backups with `VACUUM INTO` (consistent snapshot, compacted). `sources` maps a short name
 * (admin, nostr) to either an open Database or a path to open read-only.
 */
export function runBackup(
  dir: string,
  sources: Record<string, Database | string>,
  now = new Date(),
): BackupFile[] {
  mkdirSync(dir, { recursive: true })
  const out: BackupFile[] = []
  for (const [name, src] of Object.entries(sources)) {
    let db: Database
    let owned = false
    if (typeof src === 'string') {
      if (src === ':memory:' || !existsSync(src)) continue
      db = new Database(src, { readonly: true })
      owned = true
    } else {
      db = src
    }
    const file = join(dir, `${name}-${stamp(now)}.db`)
    try {
      if (existsSync(file)) rmSync(file)
      db.exec(`VACUUM INTO ${lit(file)}`)
    } finally {
      if (owned) db.close()
    }
    const st = statSync(file)
    out.push({
      name: file.split('/').pop() as string,
      size: st.size,
      createdAt: Math.floor(st.mtimeMs / 1000),
    })
  }
  return out
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((name) => {
      const st = statSync(join(dir, name))
      return { name, size: st.size, createdAt: Math.floor(st.mtimeMs / 1000) }
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name))
}

/** Delete backups older than `retentionDays`. Returns the removed file names. */
export function pruneBackups(
  dir: string,
  retentionDays: number,
  nowSec = Math.floor(Date.now() / 1000),
): string[] {
  const cutoff = nowSec - retentionDays * 86400
  const removed: string[] = []
  for (const b of listBackups(dir)) {
    if (b.createdAt < cutoff) {
      rmSync(join(dir, b.name), { force: true })
      removed.push(b.name)
    }
  }
  return removed
}

/** One backup run (admin + nostr files sharing a timestamp), in the admin SPA's `Backup` shape. */
export interface BackupRun {
  id: string
  createdAt: number
  sizeBytes: number
  files: string[]
  status: 'done'
}

export function groupBackups(files: BackupFile[]): BackupRun[] {
  const runs = new Map<string, BackupRun>()
  for (const f of files) {
    const id = f.name.replace(/^[a-z]+-/, '').replace(/\.db$/, '')
    const run = runs.get(id) ?? {
      id,
      createdAt: f.createdAt,
      sizeBytes: 0,
      files: [],
      status: 'done',
    }
    run.sizeBytes += f.size
    run.files.push(f.name)
    run.createdAt = Math.min(run.createdAt, f.createdAt)
    runs.set(id, run)
  }
  return [...runs.values()].sort((a, b) => b.id.localeCompare(a.id))
}

/** Milliseconds until the next `hour`:00 UTC. */
export function msUntilHour(hour: number, now = new Date()): number {
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}
