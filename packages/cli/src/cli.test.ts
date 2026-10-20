import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdminAuth, AdminDb, parseToml } from '@beamhop/relay'
import { type Io, run, studioEntry } from './cli'

function io(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = []
  const err: string[] = []
  const i: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd, env }
  return { i, out, err }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'beamhop-cli-'))

describe('beamhop CLI', () => {
  test('help, version, unknown command', async () => {
    const a = io(tmp())
    expect(await run(['--help'], a.i)).toBe(0)
    expect(a.out.join('\n')).toContain('beamhop relay init')
    const b = io(tmp())
    expect(await run(['--version'], b.i)).toBe(0)
    expect(b.out[0]).toMatch(/^\d+\.\d+\.\d+/)
    const c = io(tmp())
    expect(await run(['nope'], c.i)).toBe(2)
  })

  test('relay init writes config, unit, data dir and prints a bootstrap token that works', async () => {
    const dir = tmp()
    const a = io(dir)
    expect(await run(['relay', 'init', '--domain', 'relay.test'], a.i)).toBe(0)
    const toml = parseToml(readFileSync(join(dir, 'beamhop-relay.toml'), 'utf8')) as {
      publicUrl: string
      dataDir: string
      http: { port: number }
    }
    expect(toml.publicUrl).toBe('https://relay.test')
    expect(toml.dataDir).toBe(join(dir, 'data'))
    expect(toml.http.port).toBe(443)
    const unit = readFileSync(join(dir, 'beamhop-relay.service'), 'utf8')
    expect(unit).toContain(`--config ${join(dir, 'beamhop-relay.toml')}`)
    expect(unit).toContain('NoNewPrivileges=true')
    expect(existsSync(join(dir, 'data', 'admin.db'))).toBe(true)
    const token = a.out.find((l) => l.trim().startsWith('bht_'))?.trim() as string
    expect(token).toMatch(/^bht_[0-9a-f]{40}$/)

    const adb = new AdminDb(join(dir, 'data', 'admin.db'))
    const auth = new AdminAuth(adb)
    const res = await auth.bootstrap({ token, pubkey: 'a'.repeat(64) })
    expect(res.admin.pubkey).toBe('a'.repeat(64))
    adb.close()

    // refuses to overwrite; bootstrap-token refuses once claimed
    expect(await run(['relay', 'init', '--domain', 'relay.test'], io(dir).i)).toBe(1)
    const b = io(dir)
    expect(await run(['relay', 'bootstrap-token', '--config', 'beamhop-relay.toml'], b.i)).toBe(1)
    expect(b.err.join()).toContain('already has an admin')
  })

  test('relay init for localhost uses plain HTTP on 8080; bootstrap-token re-mints', async () => {
    const dir = tmp()
    expect(await run(['relay', 'init'], io(dir).i)).toBe(0)
    const toml = parseToml(readFileSync(join(dir, 'beamhop-relay.toml'), 'utf8')) as {
      http: { port: number; tlsCert: string }
    }
    expect(toml.http).toMatchObject({ port: 8080, tlsCert: '' })
    const b = io(dir)
    expect(await run(['relay', 'bootstrap-token', '--config', 'beamhop-relay.toml'], b.i)).toBe(0)
    expect(b.out[0]).toMatch(/^bht_/)
  })

  test('init scaffolds an app and refuses non-empty dirs', async () => {
    const dir = tmp()
    const a = io(dir)
    expect(await run(['init', 'My App', '--app-id', 'demo'], a.i)).toBe(0)
    const pkg = JSON.parse(readFileSync(join(dir, 'My App', 'package.json'), 'utf8'))
    expect(pkg.name).toBe('my-app')
    expect(pkg.dependencies['@beamhop/p2p']).toBeDefined()
    const main = readFileSync(join(dir, 'My App', 'src', 'main.ts'), 'utf8')
    expect(main).toContain('appId: "demo"')
    expect(main).toContain('createRoom')
    expect(existsSync(join(dir, 'My App', 'index.html'))).toBe(true)
    expect(await run(['init', 'My App'], io(dir).i)).toBe(1)
    expect(await run(['init', 'My App', '--force'], io(dir).i)).toBe(0)
    expect(await run(['init'], io(dir).i)).toBe(1)
  })

  test('studio spawns the studio server entry', async () => {
    const dir = tmp()
    const entry = join(dir, 'server.ts')
    const marker = join(dir, 'ran.txt')
    writeFileSync(
      entry,
      `await Bun.write(${JSON.stringify(marker)}, process.argv.slice(2).join(' '))`,
    )
    expect(studioEntry({ BEAMHOP_STUDIO_ENTRY: entry })).toBe(entry)
    expect(
      await run(
        ['studio', '--port', '0'],
        io(dir, { ...process.env, BEAMHOP_STUDIO_ENTRY: entry }).i,
      ),
    ).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('--port 0')
  })
})
