// Validates the GitHub Actions workflows and release config without network access:
// YAML parses, every job has steps that use pinned actions or run commands, and the release
// trains reference what the plan requires. Run: bun test ./.github
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicPackages } from './publish'

const root = join(import.meta.dir, '../..')
const wfDir = join(root, '.github/workflows')

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; name?: string }
type Job = { 'runs-on'?: string; steps?: Step[]; needs?: string | string[]; if?: string }
type Workflow = { name?: string; on?: unknown; jobs?: Record<string, Job>; permissions?: unknown }

function load(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(wfDir, file), 'utf8')) as Workflow
}

const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))

describe('workflows', () => {
  test('ci, release and pages exist', () => {
    expect(files.sort()).toEqual(['ci.yml', 'pages.yml', 'release.yml'])
  })

  for (const file of files) {
    test(`${file} is valid`, () => {
      const wf = load(file)
      expect(typeof wf.name).toBe('string')
      expect(wf.on).toBeDefined()
      expect(Object.keys(wf.jobs ?? {}).length).toBeGreaterThan(0)
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        expect({ id, runsOn: typeof job['runs-on'] }).toEqual({ id, runsOn: 'string' })
        expect(Array.isArray(job.steps) && job.steps.length > 0).toBe(true)
        for (const step of job.steps ?? []) {
          expect(!!step.uses !== !!step.run).toBe(true)
          if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@v\d+/)
        }
        for (const need of [job.needs ?? []].flat()) expect(wf.jobs).toHaveProperty(need)
      }
    })
  }

  test('ci runs biome, per-package tsc, bun test and Playwright', () => {
    const text = readFileSync(join(wfDir, 'ci.yml'), 'utf8')
    expect(text).toContain('bun install --frozen-lockfile')
    expect(text).toContain('biome ci')
    expect(text).toContain('tsc --noEmit -p')
    expect(text).toContain('bun test')
    expect(text).toContain('playwright install --with-deps chromium')
    expect(text).toContain('playwright test')
  })

  test('release publishes with provenance and builds relay artifacts on relay-v tags', () => {
    const wf = load('release.yml')
    const text = readFileSync(join(wfDir, 'release.yml'), 'utf8')
    expect(wf.jobs?.npm?.if).toContain('refs/heads/main')
    expect(text).toContain('changesets/action@v1')
    expect(text).toContain("NPM_CONFIG_PROVENANCE: 'true'")
    expect(text).toContain('id-token: write')
    expect(readFileSync(join(import.meta.dir, 'publish.ts'), 'utf8')).toContain('--provenance')
    expect(text).toContain("tags: ['relay-v*']")
    for (const target of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64']) {
      expect(text).toContain(target)
    }
    expect(text).toContain('ghcr.io/beamhop/relay')
    expect(text).toContain('file: ./Dockerfile')
  })

  test('pages places the demo under /demo of the docs build', () => {
    const text = readFileSync(join(wfDir, 'pages.yml'), 'utf8')
    expect(text).toContain('cp -R apps/demo/dist/. apps/docs/dist/demo/')
    expect(text).toContain('actions/deploy-pages@v4')
    const vite = readFileSync(join(root, 'apps/demo/vite.config.ts'), 'utf8')
    const astro = readFileSync(join(root, 'apps/docs/astro.config.mjs'), 'utf8')
    expect(vite).toContain("base: '/lightspeed/demo/'")
    expect(astro).toContain("base: '/lightspeed/'")
  })
})

describe('issue templates', () => {
  const dir = join(root, '.github/ISSUE_TEMPLATE')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    test(`${file} parses`, () => {
      const doc = Bun.YAML.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
      if (file === 'config.yml') expect(doc.blank_issues_enabled).toBe(false)
      else expect(Array.isArray(doc.body) && typeof doc.name === 'string').toBe(true)
    })
  }
})

describe('changesets', () => {
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as {
    access: string
    ignore: string[]
    linked: string[][]
    fixed: string[][]
  }

  test('publishes publicly and ignores the apps', () => {
    expect(config.access).toBe('public')
    expect(config.ignore.sort()).toEqual(['@beamhop/demo', '@beamhop/docs'])
  })

  test('every package referenced by the config exists', () => {
    const names = new Set(publicPackages().map((p) => p.pkg.name))
    for (const group of [...config.linked, ...config.fixed]) {
      for (const name of group)
        expect({ name, exists: names.has(name) }).toEqual({ name, exists: true })
    }
  })

  test('license files match each package license', () => {
    for (const { dir, pkg } of publicPackages()) {
      const license = (
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { license: string }
      ).license
      const file = join(dir, 'LICENSE')
      expect({ pkg: pkg.name, hasLicense: existsSync(file) }).toEqual({
        pkg: pkg.name,
        hasLicense: true,
      })
      const text = readFileSync(file, 'utf8')
      if (license === 'MIT') expect(text).toStartWith('MIT License')
      else expect(text).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    }
  })
})
