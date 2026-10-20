import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAdminDist, serveAdmin } from './static'

describe('admin SPA static serving', () => {
  const dist = mkdtempSync(join(tmpdir(), 'bh-dist-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="app"></div>')
  writeFileSync(join(dist, 'assets', 'app-123.js'), 'console.log(1)')
  writeFileSync(join(tmpdir(), 'secret.txt'), 'nope')

  test('resolves a configured dist dir', () => {
    expect(resolveAdminDist(dist)).toBe(dist)
    expect(resolveAdminDist(join(dist, 'missing'))).toBeNull()
  })

  test('serves assets immutable and falls back to index.html', async () => {
    const asset = await serveAdmin(dist, '/admin/assets/app-123.js')
    expect(await asset.text()).toBe('console.log(1)')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    for (const path of ['/admin', '/admin/', '/admin/apps/chat', '/admin/../../secret.txt']) {
      const r = await serveAdmin(dist, path)
      expect(await r.text()).toContain('id="app"')
      expect(r.headers.get('x-frame-options')).toBe('DENY')
    }
  })
})
