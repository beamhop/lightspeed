// End-to-end against the real @beamhop/nostr-relay and @beamhop/turn engines (loaded through the
// same loaders bin.ts uses). Skipped when an engine package does not export its factory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type TurnCredentialsResponse, turnPassword } from '@beamhop/p2p/wire'
import { loadNostrEngine, loadTurnEngine } from './engines'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay, WsClient } from './testing'
import { getPublicKey, randomHex, signEvent } from './util/crypto'

const nostrFactory = await loadNostrEngine()
const turnFactory = await loadTurnEngine()

describe.if(!!nostrFactory && !!turnFactory)('real engines', () => {
  let t: TestRelay
  let cookie: string
  let apiKey: string
  let secret: string

  beforeAll(async () => {
    t = await startTestRelay(
      {
        nostr: { name: 'Real engines' },
        turn: {
          host: '127.0.0.1',
          externalIp: '127.0.0.1',
          publicHost: '127.0.0.1',
          udpPort: 0,
          tcpPort: 0,
          tlsPort: 0,
          relayPortMin: 0,
          relayPortMax: 0,
        },
      },
      { nostrFactory, turnFactory },
    )
    cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
    const r = await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Real', id: 'real' } })
    apiKey = r.body.apiKey
    secret = r.body.turnSecret
  })
  afterAll(() => t?.close())

  test('Nostr: publish/subscribe on public relay and realm, NIP-11, admin delete', async () => {
    const sk = randomHex(32)
    const info = await fetch(`${t.base}/a/real`, {
      headers: { accept: 'application/nostr+json' },
    }).then((r) => r.json())
    expect(info.name).toBe('Real engines')
    const ws = await WsClient.open(`${t.wsBase}/a/real`)
    ws.send(JSON.stringify(['REQ', 'sub', { kinds: [1] }]))
    await ws.next((m) => m[0] === 'EOSE')
    const e = signEvent(sk, { kind: 1, content: 'hello real engine', tags: [] })
    ws.send(JSON.stringify(['EVENT', e]))
    const ok = await ws.next((m) => m[0] === 'OK')
    expect(ok[2]).toBe(true)
    expect((await ws.next((m) => m[0] === 'EVENT'))[2].id).toBe(e.id)
    ws.close()

    const list = await api(t.base, '/api/admin/nostr/events?kind=1&realm=real', { cookie })
    expect(list.body.events.map((x: { id: string }) => x.id)).toEqual([e.id])
    const del = await api(t.base, `/api/admin/nostr/events/${e.id}?realm=real`, {
      method: 'DELETE',
      cookie,
    })
    expect(del.status).toBe(200)
    expect(
      (await api(t.base, '/api/admin/nostr/events?kind=1&realm=real', { cookie })).body.events,
    ).toEqual([])
  })

  test('Nostr: banned pubkeys are rejected by the engine via the policy provider', async () => {
    const sk = randomHex(32)
    await api(t.base, '/api/admin/bans', {
      cookie,
      body: { type: 'pubkey', value: getPublicKey(sk) },
    })
    const ws = await WsClient.open(`${t.wsBase}/`)
    ws.send(JSON.stringify(['EVENT', signEvent(sk, { kind: 1, content: 'nope', tags: [] })]))
    const ok = await ws.next((m) => m[0] === 'OK')
    expect(ok[2]).toBe(false)
    ws.close()
  })

  test('TURN: minted REST credentials allocate on the real TURN server', async () => {
    const { TurnClient } = (await import(['@beamhop', 'turn'].join('/'))) as {
      TurnClient: {
        connect(o: { host: string; port: number; username: string; password: string }): Promise<{
          allocate(): Promise<{ address: string; port: number }[]>
          close(): void
        }>
      }
    }
    const res = await fetch(`${t.base}/a/real/turn-credentials`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    const body = (await res.json()) as TurnCredentialsResponse
    const server = body.iceServers[1] as { urls: string[]; username: string; credential: string }
    expect(server.credential).toBe(turnPassword(secret, server.username))
    // Advertised port is the configured one (0 here); connect to the actually bound port.
    const ports = t.relay.ctx.overview().engines as { turnPorts: { udp: number } }
    const client = await TurnClient.connect({
      host: '127.0.0.1',
      port: ports.turnPorts.udp,
      username: server.username,
      password: server.credential,
    })
    try {
      const relayed = await client.allocate()
      expect(relayed.length).toBeGreaterThan(0)
      const allocs = await api(t.base, '/api/admin/turn/allocations', { cookie })
      expect(allocs.body.allocations[0]).toMatchObject({ appId: 'real', transport: 'udp' })
      expect(typeof allocs.body.allocations[0].client).toBe('string')
    } finally {
      client.close()
    }
    const bad = await TurnClient.connect({
      host: '127.0.0.1',
      port: ports.turnPorts.udp,
      username: server.username,
      password: 'wrong',
    })
    await expect(bad.allocate()).rejects.toThrow()
    bad.close()
  })
})
