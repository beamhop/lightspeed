import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBackups, msUntilHour, pruneBackups, runBackup } from './backups'
import { AdminDb, DowngradeError, migrate, SCHEMA_VERSION } from './db'

describe('admin.db', () => {
  test('migrates to the latest version and is idempotent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bh-db-')), 'admin.db')
    const a = new AdminDb(path)
    expect(a.version).toBe(SCHEMA_VERSION)
    a.close()
    const b = new AdminDb(path)
    expect(b.version).toBe(SCHEMA_VERSION)
    b.close()
  })

  test('refuses to downgrade', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bh-db-')), 'admin.db')
    const raw = new Database(path)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    expect(() => new AdminDb(path)).toThrow(DowngradeError)
  })

  test('applies only pending migrations', () => {
    const db = new Database(':memory:')
    migrate(db, ['CREATE TABLE a (x)'])
    migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)'])
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
  })

  test('settings, audit and usage', () => {
    let now = 1_700_000_000
    const a = new AdminDb(':memory:', () => now)
    a.setSetting('k', { x: 1 })
    expect(a.getSetting('k')).toEqual({ x: 1 })
    a.setSetting('k', undefined)
    expect(a.getSetting('k')).toBeUndefined()
    a.audit('pubkey:ab', 'app.create', 'app:x', { name: 'X' }, '1.2.3.4')
    a.audit('user:bob', 'app.delete', 'app:x')
    expect(a.auditLog().map((e) => e.action)).toEqual(['app.delete', 'app.create'])
    expect(a.auditLog({ actor: 'pubkey:ab' })[0]?.details).toEqual({ name: 'X' })
    a.addUsage('x', 'turn_bytes_in', 100)
    a.addUsage('x', 'turn_bytes_in', 50)
    now += 86400
    a.addUsage('x', 'turn_bytes_out', 7)
    expect(a.monthUsage('x', ['turn_bytes_in', 'turn_bytes_out'])).toBe(157)
    expect(a.usage('x').length).toBe(2)
  })

  test('VACUUM INTO backups with retention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-bak-'))
    const a = new AdminDb(join(dir, 'admin.db'))
    a.setSetting('hello', 'world')
    const files = runBackup(
      join(dir, 'backups'),
      { admin: a.db, nostr: join(dir, 'missing.db') },
      new Date('2026-01-01T03:00:00Z'),
    )
    expect(files.map((f) => f.name)).toEqual(['admin-20260101T030000Z.db'])
    const copy = new Database(join(dir, 'backups', files[0]?.name as string), { readonly: true })
    expect(copy.query("SELECT value FROM settings WHERE key = 'hello'").get()).toEqual({
      value: '"world"',
    })
    copy.close()
    expect(listBackups(join(dir, 'backups')).length).toBe(1)
    expect(
      pruneBackups(join(dir, 'backups'), 14, Math.floor(Date.now() / 1000) + 15 * 86400),
    ).toEqual([files[0]?.name as string])
    expect(listBackups(join(dir, 'backups')).length).toBe(0)
    const at = new Date(2026, 0, 1, 2, 30)
    expect(msUntilHour(3, at)).toBe(30 * 60_000)
    expect(msUntilHour(2, at)).toBe(23.5 * 3600_000)
  })
})
