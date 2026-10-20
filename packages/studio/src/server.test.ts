import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkNip11,
  checkRelay,
  checkSocket,
  checkTurnCredentials,
  httpUrlFor,
  realmUrl,
} from './health'
import { STUDIO_HEADER, type StudioServer, startStudioServer } from './server'

// ------------------------------------------------------------------ fake relay (port 0)

type WsData = { auth: boolean }
let relay: ReturnType<typeof Bun.serve<WsData, never>>
let relayUrl = ''

beforeAll(() => {
  relay = Bun.serve<WsData, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url)
      if (req.headers.get('upgrade') === 'websocket') {
        return server.upgrade(req, { data: { auth: url.pathname.startsWith('/a/') } })
          ? undefined
          : new Response('no', { status: 400 })
      }
      if (url.pathname.endsWith('/turn-credentials') && req.method === 'POST') {
        if (req.headers.get('authorization') !== 'Bearer k1')
          return new Response('nope', { status: 401 })
        return Response.json({
          iceServers: [
            {
              urls: ['turn:127.0.0.1:3478?transport=udp', 'turns:127.0.0.1:443'],
              username: 'u',
              credential: 'p',
            },
          ],
          ttl: 600,
        })
      }
      if (req.headers.get('accept') === 'application/nostr+json') {
        return Response.json({
          name: 'test relay',
          software: 'beamhop',
          supported_nips: [1, 11, 42],
        })
      }
      return new Response('hi')
    },
    websocket: {
      open(ws) {
        if (ws.data.auth) ws.send(JSON.stringify(['AUTH', 'challenge-123456789']))
      },
      message(ws, msg) {
        const m = JSON.parse(String(msg))
        if (m[0] === 'REQ') ws.send(JSON.stringify(['EOSE', m[1]]))
      },
    },
  })
  relayUrl = `ws://127.0.0.1:${relay.port}`
})

afterAll(() => {
  relay.stop(true)
})

describe('relay health', () => {
  test('url helpers', () => {
    expect(httpUrlFor('wss://r.example/a/x')).toBe('https://r.example/a/x')
    expect(httpUrlFor('ws://r')).toBe('http://r')
    expect(realmUrl('wss://r.example/', 'my app')).toBe('wss://r.example/a/my%20app')
  })

  test('NIP-11 fetch', async () => {
    const c = await checkNip11({ relay: relayUrl })
    expect(c.ok).toBe(true)
    expect(c.detail).toContain('test relay')
    expect(c.detail).toContain('42')
  })

  test('signaling RTT and AUTH challenge on realm relay', async () => {
    const [auth, sig] = await checkSocket({ relay: relayUrl, appId: 'demo' })
    expect(sig.ok).toBe(true)
    expect(typeof sig.ms).toBe('number')
    expect(auth.ok).toBe(true)
    expect(auth.detail).toContain('AUTH challenge')
    const [openAuth] = await checkSocket({ relay: relayUrl })
    expect(openAuth.detail).toContain('no AUTH')
  })

  test('TURN mint needs app id and key', async () => {
    expect((await checkTurnCredentials({ relay: relayUrl })).check.ok).toBeNull()
    const denied = await checkTurnCredentials({ relay: relayUrl, appId: 'demo', apiKey: 'bad' })
    expect(denied.check).toMatchObject({ ok: false, detail: 'HTTP 401 (API key?)' })
    const ok = await checkTurnCredentials({ relay: relayUrl, appId: 'demo', apiKey: 'k1' })
    expect(ok.check.ok).toBe(true)
    expect(ok.check.detail).toBe('2 ICE URL(s), ttl 600s')
  })

  test('failures are reported, not thrown', async () => {
    const report = await checkRelay({ relay: 'ws://127.0.0.1:1', appId: 'x', timeoutMs: 1500 })
    const by = Object.fromEntries(report.checks.map((c) => [c.name, c]))
    expect(by.nip11?.ok).toBe(false)
    expect(by.signaling?.ok).toBe(false)
    expect(by.turn?.ok).toBe(false)
    expect(by.allocation?.ok).toBeNull()
  })

  test('full report with an allocation test hook', async () => {
    const report = await checkRelay({
      relay: relayUrl,
      appId: 'demo',
      apiKey: 'k1',
      allocationTest: async (servers) => ({
        name: 'allocation',
        ok: true,
        detail: `${servers.length} server(s)`,
      }),
    })
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ['nip11', true],
      ['auth', true],
      ['signaling', true],
      ['turn', true],
      ['allocation', true],
    ])
  })
})

// ------------------------------------------------------------------ studio server

describe('studio server', () => {
  let dir: string
  let studio: StudioServer
  const H = { [STUDIO_HEADER]: '1', 'Content-Type': 'application/json' }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bh-studio-'))
    const dist = join(dir, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Studio</title>')
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(
      join(dir, 'peer.ts'),
      'const e = process.env\nconsole.log(["peer", e.BEAMHOP_PEER_INDEX, e.ROOM, e.APP, e.RELAY].join(" "))\n',
    )
    studio = startStudioServer({ port: 0, distDir: dist, cwd: dir, log: () => {} })
  })

  afterAll(async () => {
    await studio.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('serves the app with SPA fallback and blocks traversal', async () => {
    expect(await (await fetch(studio.url)).text()).toContain('<title>Studio</title>')
    const asset = await fetch(`${studio.url}assets/app.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(await (await fetch(`${studio.url}topology`)).text()).toContain('<title>Studio</title>')
    const trav = await fetch(`${studio.url}..%2f..%2fpeer.ts`)
    expect(await trav.text()).toContain('<title>Studio</title>')
  })

  test('mutations require the studio header', async () => {
    const res = await fetch(`${studio.url}api/spawn`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
  })

  test('validates spawn requests', async () => {
    const res = await fetch(`${studio.url}api/spawn`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        script: 'missing.ts',
        count: 1,
        room: 'r',
        app: 'a',
        relay: 'ws://x',
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  test('spawns real bun peers with ROOM/APP/RELAY', async () => {
    const res = await fetch(`${studio.url}api/spawn`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        script: 'peer.ts',
        count: 2,
        room: 'lobby',
        app: 'demo',
        relay: 'ws://relay.local',
      }),
    })
    expect(res.status).toBe(201)
    const { peers } = (await res.json()) as { peers: { id: string; pid: number }[] }
    expect(peers.length).toBe(2)
    const deadline = Date.now() + 10_000
    let list: { output: string[]; exitCode?: number | null }[] = []
    while (Date.now() < deadline) {
      list = ((await (await fetch(`${studio.url}api/spawn`)).json()) as { peers: typeof list })
        .peers
      if (list.every((p) => p.exitCode !== undefined)) break
      await Bun.sleep(50)
    }
    expect(list.map((p) => p.exitCode)).toEqual([0, 0])
    expect(list.map((p) => p.output.join(''))).toEqual([
      'peer 0 lobby demo ws://relay.local',
      'peer 1 lobby demo ws://relay.local',
    ])
    const del = await fetch(`${studio.url}api/spawn/${peers[0]?.id}`, {
      method: 'DELETE',
      headers: H,
    })
    expect(del.status).toBe(200)
  }, 15_000)

  test('health endpoint runs server-side', async () => {
    const res = await fetch(`${studio.url}api/health`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ relay: relayUrl }),
    })
    const report = (await res.json()) as { checks: { name: string; ok: boolean | null }[] }
    expect(report.checks.find((c) => c.name === 'nip11')?.ok).toBe(true)
    const bad = await fetch(`${studio.url}api/health`, {
      method: 'POST',
      headers: H,
      body: '{"relay":"http://x"}',
    })
    expect(bad.status).toBe(400)
  })

  test('info and unknown endpoints', async () => {
    expect(
      ((await (await fetch(`${studio.url}api/info`)).json()) as { spawner: boolean }).spawner,
    ).toBe(true)
    expect((await fetch(`${studio.url}api/nope`)).status).toBe(404)
  })
})
