import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changelogPage, protocolPage } from './sync'
import { vectors } from './vectors'

const root = join(import.meta.dir, '../../..')
const protocol = readFileSync(join(root, 'docs/PROTOCOL.md'), 'utf8')

describe('docs/PROTOCOL.md', () => {
  test('quotes test vectors that match @beamhop/p2p/wire', () => {
    for (const [name, value] of Object.entries(vectors)) {
      expect({ name, found: protocol.includes(value) }).toEqual({ name, found: true })
    }
  })

  test('documents every wire.ts constant and control message', () => {
    const wire = readFileSync(join(root, 'packages/p2p/src/wire.ts'), 'utf8')
    for (const [, name] of wire.matchAll(/export const ([A-Z_]+) =/g)) {
      expect(protocol).toContain(name as string)
    }
    for (const [, type] of wire.matchAll(/\{ type: '([a-z-]+)'/g)) {
      expect(protocol).toContain(`type: '${type}'`)
    }
  })
})

describe('sync', () => {
  test('protocol page takes its title from the H1 and keeps the body', () => {
    const page = protocolPage('# Spec v1\n\nIntro\n\n## 1. Part\n')
    expect(page.startsWith('---\ntitle: "Spec v1"\n')).toBe(true)
    expect(page).toContain('Generated from docs/PROTOCOL.md')
    expect(page).toContain('Intro\n\n## 1. Part')
    expect(page).not.toContain('# Spec v1')
  })

  test('changelog page demotes package headings', () => {
    const page = changelogPage([
      {
        name: '@beamhop/p2p',
        markdown: '# @beamhop/p2p\n\n## 0.1.0\n\n### Minor Changes\n\n- x\n',
      },
    ])
    expect(page).toContain('## `@beamhop/p2p`')
    expect(page).toContain('### 0.1.0')
    expect(page).toContain('#### Minor Changes')
    expect(page).not.toContain('# @beamhop/p2p\n')
    expect(changelogPage([])).toContain('No releases yet')
  })
})
