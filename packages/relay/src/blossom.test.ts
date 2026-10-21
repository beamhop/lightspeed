import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay } from './testing'
import { getPublicKey, randomHex, sha256Hex, signEvent } from './util/crypto'

let t: TestRelay
let cookie: string
const sk = randomHex(32)
const pk = getPublicKey(sk)

beforeAll(async () => {
  t = await startTestRelay({
    apps: { open: false },
    blossom: {
      maxUploadBytes: 1000,
      perPubkeyQuotaBytes: 600,
      allowedMime: ['image/*', 'text/plain'],
    },
  })
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
  await api(t.base, '/api/admin/apps', {
    cookie,
    body: { name: 'Media', id: 'media', blossomQuotaBytes: 300 },
  })
})
afterAll(() => t.close())

function auth(verb: string, opts: { x?: string; secret?: string; expiration?: number } = {}) {
  const tags = [
    ['t', verb],
    ['expiration', String(opts.expiration ?? Math.floor(Date.now() / 1000) + 60)],
  ]
  if (opts.x) tags.push(['x', opts.x])
  const ev = signEvent(opts.secret ?? sk, { kind: 24242, content: `${verb} blob`, tags })
  return `Nostr ${btoa(JSON.stringify(ev))}`
}

const upload = (body: Uint8Array<ArrayBuffer>, type: string, authz?: string, prefix = '') =>
  fetch(`${t.base}${prefix}/upload`, {
    method: 'PUT',
    headers: { 'content-type': type, ...(authz ? { authorization: authz } : {}) },
    body,
  })

describe('Blossom', () => {
  const data = new TextEncoder().encode('hello blossom')
  const sha = sha256Hex(data)

  test('BUD-02 upload with auth returns a descriptor', async () => {
    expect((await upload(data, 'text/plain')).status).toBe(401)
    const res = await upload(data, 'text/plain', auth('upload', { x: sha }))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d).toMatchObject({
      sha256: sha,
      size: data.length,
      type: 'text/plain',
      url: `${t.base}/${sha}.txt`,
    })
    expect(existsSync(join(t.dataDir, 'blobs', sha.slice(0, 2), sha))).toBe(true)
  })

  test('BUD-01 get / head / range', async () => {
    const g = await fetch(`${t.base}/${sha}.txt`)
    expect(g.status).toBe(200)
    expect(g.headers.get('content-type')).toBe('text/plain')
    expect(await g.text()).toBe('hello blossom')
    const h = await fetch(`${t.base}/${sha}`, { method: 'HEAD' })
    expect(h.status).toBe(200)
    expect(h.headers.get('content-length')).toBe(String(data.length))
    const r = await fetch(`${t.base}/${sha}`, { headers: { range: 'bytes=6-' } })
    expect(r.status).toBe(206)
    expect(await r.text()).toBe('blossom')
    expect(r.headers.get('content-range')).toBe(`bytes 6-12/${data.length}`)
    expect((await fetch(`${t.base}/${'0'.repeat(64)}`)).status).toBe(404)
  })

  test('auth validation: wrong verb, expired, x mismatch, bad sig', async () => {
    expect((await upload(data, 'text/plain', auth('delete'))).status).toBe(401)
    expect((await upload(data, 'text/plain', auth('upload', { expiration: 1 }))).status).toBe(401)
    expect((await upload(data, 'text/plain', auth('upload', { x: '1'.repeat(64) }))).status).toBe(
      409,
    )
    const bad = await upload(data, 'text/plain', 'Nostr not-base64!')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('x-reason')).toBeTruthy()
  })

  test('mime and size limits; BUD-06 preflight', async () => {
    expect((await upload(new Uint8Array(10), 'application/zip', auth('upload'))).status).toBe(415)
    expect((await upload(new Uint8Array(1001), 'image/png', auth('upload'))).status).toBe(413)
    const pre = (headers: Record<string, string>) =>
      fetch(`${t.base}/upload`, { method: 'HEAD', headers })
    expect(
      (
        await pre({
          authorization: auth('upload'),
          'x-content-length': '10',
          'x-content-type': 'image/png',
          'x-sha-256': 'a'.repeat(64),
        })
      ).status,
    ).toBe(200)
    const tooBig = await pre({
      authorization: auth('upload'),
      'x-content-length': '5000',
      'x-content-type': 'image/png',
    })
    expect(tooBig.status).toBe(413)
    expect(tooBig.headers.get('x-reason')).toContain('exceeds')
    expect((await pre({ 'x-content-length': '10' })).status).toBe(401)
  })

  test('per-pubkey quota', async () => {
    const other = randomHex(32)
    const a = await upload(
      new Uint8Array(500).fill(1),
      'image/png',
      auth('upload', { secret: other }),
    )
    expect(a.status).toBe(200)
    const b = await upload(
      new Uint8Array(200).fill(2),
      'image/png',
      auth('upload', { secret: other }),
    )
    expect(b.status).toBe(413)
    expect(b.headers.get('x-reason')).toContain('per-pubkey')
  })

  test('per-app quota under /a/<appId>/ and app-scoped listing', async () => {
    const one = await upload(new Uint8Array(200).fill(3), 'image/png', auth('upload'), '/a/media')
    expect(one.status).toBe(200)
    const two = await upload(new Uint8Array(200).fill(4), 'image/png', auth('upload'), '/a/media')
    expect(two.status).toBe(413)
    expect(two.headers.get('x-reason')).toBe('storage quota exceeded')
    const list = await fetch(`${t.base}/a/media/list/${pk}`).then((r) => r.json())
    expect(list).toHaveLength(1)
    expect(
      (await upload(new Uint8Array(1), 'image/png', auth('upload'), '/a/unknown')).status,
    ).toBe(404)
  })

  test('BUD-02 list', async () => {
    const list = await fetch(`${t.base}/list/${pk}`).then((r) => r.json())
    expect(list.map((d: { sha256: string }) => d.sha256)).toEqual([sha])
    expect(
      await fetch(`${t.base}/list/${pk}?since=${Math.floor(Date.now() / 1000) + 100}`).then((r) =>
        r.json(),
      ),
    ).toEqual([])
    expect((await fetch(`${t.base}/list/nothex`)).status).toBe(400)
  })

  test('BUD-02 delete requires a matching x tag and the owner', async () => {
    const del = (authz?: string) =>
      fetch(`${t.base}/${sha}`, {
        method: 'DELETE',
        headers: authz ? { authorization: authz } : {},
      })
    expect((await del()).status).toBe(401)
    expect((await del(auth('delete'))).status).toBe(401)
    expect((await del(auth('delete', { x: sha, secret: randomHex(32) }))).status).toBe(404)
    expect((await del(auth('delete', { x: sha }))).status).toBe(200)
    expect((await fetch(`${t.base}/${sha}`)).status).toBe(404)
    expect(existsSync(join(t.dataDir, 'blobs', sha.slice(0, 2), sha))).toBe(false)
  })

  test('PUT /mirror fetches and verifies the hash', async () => {
    const src = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('mirrored!', { headers: { 'content-type': 'text/plain' } }),
    })
    try {
      const msha = sha256Hex('mirrored!')
      const res = await fetch(`${t.base}/mirror`, {
        method: 'PUT',
        headers: { authorization: auth('upload', { x: msha }), 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${src.port}/x` }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).sha256).toBe(msha)
      const bad = await fetch(`${t.base}/mirror`, {
        method: 'PUT',
        headers: {
          authorization: auth('upload', { x: 'f'.repeat(64) }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: `http://127.0.0.1:${src.port}/x` }),
      })
      expect(bad.status).toBe(409)
    } finally {
      src.stop(true)
    }
  })

  test('CORS preflight', async () => {
    const r = await fetch(`${t.base}/upload`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  test('admin media browser and delete', async () => {
    const l = await api(t.base, '/api/admin/media/blobs?app=media', { cookie })
    expect(l.body.blobs).toHaveLength(1)
    const all = await api(t.base, `/api/admin/media/blobs?pubkey=${pk}`, { cookie })
    expect(all.body.blobs.length).toBeGreaterThanOrEqual(2)
    const target = l.body.blobs[0].sha256
    expect(
      (await api(t.base, `/api/admin/media/blobs/${target}`, { method: 'DELETE', cookie })).status,
    ).toBe(200)
    expect((await fetch(`${t.base}/${target}`)).status).toBe(404)
    const metrics = await fetch(`${t.base}/metrics`).then((r) => r.text())
    expect(metrics).toMatch(/beamhop_blossom_blobs \d+/)
  })
})
