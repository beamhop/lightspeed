// Keeps deploy/ in sync with the code: templates match, and every metric the Grafana dashboard
// queries is exported by /metrics.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exampleToml, systemdUnit } from './templates'
import { startTestRelay } from './testing'

const deploy = join(import.meta.dir, '../../../deploy')

describe('deploy/', () => {
  test('systemd unit and example config match the templates', () => {
    expect(readFileSync(join(deploy, 'systemd/beamhop-relay.service'), 'utf8')).toBe(systemdUnit())
    expect(readFileSync(join(deploy, 'beamhop-relay.example.toml'), 'utf8')).toBe(exampleToml())
  })

  test('Grafana dashboard only uses exported metrics', async () => {
    const dash = readFileSync(join(deploy, 'grafana/beamhop-relay.json'), 'utf8')
    const used = new Set(dash.match(/beamhop_[a-z_]+/g))
    const t = await startTestRelay({ http: { tlsCert: '' } })
    try {
      const text = await fetch(`${t.base}/metrics`).then((r) => r.text())
      const exported = new Set([...text.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]))
      exported.add('beamhop_tls_cert_expiry_seconds') // only present when TLS is configured
      for (const m of used) expect(exported.has(m)).toBe(true)
    } finally {
      await t.close()
    }
  })
})
