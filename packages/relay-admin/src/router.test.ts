import { describe, expect, test } from 'bun:test'
import { detectMock } from './ctx'
import { matchRoute, normalizeBase, stripBase } from './router'

describe('router', () => {
  test('matchRoute', () => {
    expect(matchRoute('/', '/')).toEqual({})
    expect(matchRoute('/apps/:id', '/apps/abc')).toEqual({ id: 'abc' })
    expect(matchRoute('/apps/:id', '/apps/a%20b?tab=keys')).toEqual({ id: 'a b' })
    expect(matchRoute('/apps/:id', '/apps')).toBeNull()
    expect(matchRoute('/apps', '/apps/abc')).toBeNull()
    expect(matchRoute('/nostr/', '/nostr')).toEqual({})
    expect(matchRoute('/files/*', '/files/a/b')).toEqual({ '*': 'a/b' })
  })

  test('base handling', () => {
    expect(normalizeBase('/admin/')).toBe('/admin')
    expect(normalizeBase('admin')).toBe('/admin')
    expect(normalizeBase('/')).toBe('')
    expect(stripBase('/admin', '/admin')).toBe('/')
    expect(stripBase('/admin/apps/x', '/admin')).toBe('/apps/x')
    expect(stripBase('/administrator', '/admin')).toBe('/administrator')
  })

  test('mock detection', () => {
    expect(detectMock('?mock=1')).toBe(true)
    expect(detectMock('?x=1&mock=true')).toBe(true)
    expect(detectMock('')).toBe(false)
    expect(detectMock('', { VITE_MOCK: '1' })).toBe(true)
  })
})
