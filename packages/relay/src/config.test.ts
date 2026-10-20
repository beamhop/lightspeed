import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, envOverrides, loadConfig, parseToml, toToml } from './config'
import { exampleToml, systemdUnit } from './templates'

describe('config', () => {
  test('TOML snake_case maps to camelCase and merges onto defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-cfg-'))
    const file = join(dir, 'beamhop-relay.toml')
    writeFileSync(
      file,
      'data_dir = "/srv/x"\n[http]\nport = 8443\ntls_cert = "/c.pem"\n[blossom]\nallowed_mime = ["image/*"]\n[unknown]\nx = 1\n',
    )
    const { config, path, envKeys } = loadConfig(file, {})
    expect(path).toBe(file)
    expect(config.dataDir).toBe('/srv/x')
    expect(config.http.port).toBe(8443)
    expect(config.http.tlsCert).toBe('/c.pem')
    expect(config.http.host).toBe(defaultConfig.http.host)
    expect(config.blossom.allowedMime).toEqual(['image/*'])
    expect((config as unknown as Record<string, unknown>).unknown).toBeUndefined()
    expect(envKeys).toEqual([])
  })

  test('BEAMHOP_* env overrides win and are coerced', () => {
    const env = {
      BEAMHOP_DATA_DIR: '/env',
      BEAMHOP_HTTP_PORT: '9000',
      BEAMHOP_TURN_EXTERNAL_IP: '203.0.113.7',
      BEAMHOP_PAYMENTS_REQUIRED: 'true',
      BEAMHOP_BLOSSOM_ALLOWED_MIME: 'image/png, video/*',
    }
    expect(envOverrides(env)).toEqual({
      dataDir: '/env',
      http: { port: '9000' },
      turn: { externalIp: '203.0.113.7' },
      payments: { required: 'true' },
      blossom: { allowedMime: 'image/png, video/*' },
    })
    const { config, envKeys } = loadConfig(undefined, env)
    expect(config.dataDir).toBe('/env')
    expect(config.http.port).toBe(9000)
    expect(config.payments.required).toBe(true)
    expect(config.blossom.allowedMime).toEqual(['image/png', 'video/*'])
    expect(envKeys).toContain('http.port')
    expect(() => loadConfig(undefined, { BEAMHOP_HTTP_PORT: 'abc' })).toThrow()
  })

  test('toToml round-trips and the init templates parse', () => {
    const back = parseToml(toToml(defaultConfig))
    expect(back).toEqual(JSON.parse(JSON.stringify(defaultConfig)))
    const t = parseToml(exampleToml({ domain: 'relay.test' })) as {
      publicUrl: string
      turn: { realm: string }
    }
    expect(t.publicUrl).toBe('https://relay.test')
    expect(t.turn.realm).toBe('relay.test')
    expect(systemdUnit()).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
  })
})
