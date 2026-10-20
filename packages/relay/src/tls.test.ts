import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { loadNostrEngine, loadTurnEngine } from './engines'
import { api, bootstrapPubkeyAdmin, startTestRelay } from './testing'
import { getPublicKey, randomHex } from './util/crypto'

const hasOpenssl = Bun.which('openssl') !== null

function makeCert(dir: string, cn: string, days: number) {
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  const r = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    String(days),
    '-subj',
    `/CN=${cn}`,
  ])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return { cert, key }
}

function peerCn(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const cn = s.getPeerCertificate().subject?.CN
      s.end()
      resolve(String(cn))
    })
    s.on('error', reject)
  })
}

describe.if(hasOpenssl)('TLS', () => {
  test('serves HTTPS from cert files, reloads on change, alerts on expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-tls-'))
    const { cert, key } = makeCert(dir, 'first.test', 5)
    const t = await startTestRelay({
      http: { tlsCert: cert, tlsKey: key },
      alerts: { certDays: 14 },
    })
    try {
      const port = t.relay.port
      expect(await peerCn(port)).toBe('first.test')
      const https = `https://127.0.0.1:${port}`
      const h = await fetch(`${https}/healthz`, { tls: { rejectUnauthorized: false } })
      expect(h.status).toBe(200)

      makeCert(dir, 'second.test', 365)
      t.relay.reloadTls()
      expect(t.relay.port).toBe(port)
      expect(await peerCn(port)).toBe('second.test')

      makeCert(dir, 'third.test', 5)
      const cookie = await (async () => {
        const r = await fetch(`${https}/api/admin/auth/bootstrap`, {
          method: 'POST',
          tls: { rejectUnauthorized: false },
          headers: { 'content-type': 'application/json', origin: https },
          body: JSON.stringify({ token: t.bootstrapToken, pubkey: getPublicKey(randomHex(32)) }),
        })
        expect(r.headers.get('set-cookie')).toContain('Secure')
        return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
      })()
      expect(cookie).toContain('bh_admin=')
      const alerts = t.relay.ctx.alerts()
      expect(alerts.find((a) => a.id === 'cert-expiry')?.message).toMatch(/expires in [45] days/)
      // Secure cookie flag on HTTPS
      const login = await fetch(`${https}/api/admin/auth/challenge`, {
        method: 'POST',
        tls: { rejectUnauthorized: false },
        headers: { origin: https },
      })
      expect(login.status).toBe(200)
    } finally {
      await t.close()
    }
  })
})

describe('engine loaders', () => {
  test('return a factory or null without throwing', async () => {
    const n = await loadNostrEngine()
    const t = await loadTurnEngine()
    expect(n === null || typeof n === 'function').toBe(true)
    expect(t === null || typeof t === 'function').toBe(true)
  })
})

describe('alerts', () => {
  test('acknowledge an alert', async () => {
    const t = await startTestRelay({ alerts: { diskPercent: 0 } })
    try {
      const cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
      const a = await api(t.base, '/api/admin/alerts', { cookie })
      expect(a.body.alerts[0]).toMatchObject({ id: 'disk', acked: false })
      await api(t.base, '/api/admin/alerts/disk/ack', { cookie, body: {} })
      const b = await api(t.base, '/api/admin/alerts', { cookie })
      expect(b.body.alerts[0]).toMatchObject({ id: 'disk', acked: true })
      const metrics = await fetch(`${t.base}/metrics`).then((r) => r.text())
      expect(metrics).toContain('beamhop_alerts_active 1')
    } finally {
      await t.close()
    }
  })
})
