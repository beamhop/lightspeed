import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parseTurnUsername, relayHelloHash, type TurnCredentialsResponse } from '@beamhop/p2p/wire'
import { schnorr } from '@noble/curves/secp256k1'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay, WsClient } from './testing'
import { bytesToHex, getPublicKey, randomHex, signEvent } from './util/crypto'

let t: TestRelay
let cookie: string

beforeAll(async () => {
  t = await startTestRelay()
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
  await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Off', id: 'off' } })
  await api(t.base, '/api/admin/apps/off', { cookie, method: 'PATCH', body: { enabled: false } })
})
afterAll(() => t.close())

const setOpen = (open: boolean) =>
  api(t.base, '/api/admin/settings', {
    cookie,
    method: 'PUT',
    body: { config: { apps: { open } } },
  })

async function dataPeer(appId: string) {
  const sk = randomHex(32)
  const c = await WsClient.open(`${t.wsBase}/a/${appId}/data`)
  const ch = await c.next<{ challenge: string }>((m) => m.type === 'challenge')
  const sig = bytesToHex(schnorr.sign(relayHelloHash(appId, ch.challenge), sk))
  c.send(JSON.stringify({ type: 'hello', pubkey: getPublicKey(sk), sig }))
  await c.next((m) => m.type === 'ready')
  return c
}

function nip98(url: string) {
  const ev = signEvent(randomHex(32), {
    kind: 27235,
    content: '',
    tags: [
      ['u', url],
      ['method', 'POST'],
    ],
  })
  return `Nostr ${btoa(JSON.stringify(ev))}`
}

describe('open app mode', () => {
  test('is on by default and reported in settings', async () => {
    expect(t.relay.ctx.config.apps.open).toBe(true)
    const s = await api(t.base, '/api/admin/settings', { cookie })
    expect(s.body.apps).toEqual({ open: true })
  })

  test('unregistered app IDs can use the realm relay, data relay and TURN', async () => {
    const realm = await WsClient.open(`${t.wsBase}/a/freebie`)
    realm.close()
    const peer = await dataPeer('freebie')
    peer.close()

    const url = `${t.base}/a/freebie/turn-credentials`
    const res = await fetch(url, { method: 'POST', headers: { authorization: nip98(url) } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as TurnCredentialsResponse
    const turn = body.iceServers[1] as { username: string; credential: string }
    expect(parseTurnUsername(turn.username)?.appId).toBe('freebie')
    expect(t.turn().opts.credentials(turn.username)).toEqual({ password: turn.credential })

    // Unregistered apps have no API key.
    const bearer = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer bhk_x' } })
    expect(bearer.status).toBe(401)
    // Open apps are not listed as registered apps.
    const list = await api(t.base, '/api/admin/apps', { cookie })
    expect(list.body.apps.map((a: { id: string }) => a.id)).not.toContain('freebie')
  })

  test('malformed IDs and disabled registered apps stay blocked', async () => {
    expect((await fetch(`${t.base}/a/Bad.ID/turn-credentials`, { method: 'POST' })).status).toBe(
      404,
    )
    await expect(WsClient.open(`${t.wsBase}/a/off/data`)).rejects.toThrow()
    await expect(WsClient.open(`${t.wsBase}/a/off`)).rejects.toThrow()
  })

  test('turning it off refuses unregistered apps and closes their sockets', async () => {
    await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Reg', id: 'reg' } })
    const realm = await WsClient.open(`${t.wsBase}/a/freebie`)
    const peer = await dataPeer('freebie')
    const registered = await dataPeer('reg')
    const turnName = `${Math.floor(Date.now() / 1000) + 600}:freebie:anonymous`
    expect(t.turn().opts.credentials(turnName)).not.toBeNull()

    const r = await setOpen(false)
    expect(r.status).toBe(200)
    expect(r.body.apps).toEqual({ open: false })
    await realm.waitClosed()
    await peer.waitClosed()
    expect(realm.closed?.code).toBe(4002)
    expect(peer.closed?.code).toBe(4002)
    expect(registered.closed).toBeNull()

    await expect(WsClient.open(`${t.wsBase}/a/freebie`)).rejects.toThrow()
    await expect(WsClient.open(`${t.wsBase}/a/freebie/data`)).rejects.toThrow()
    const url = `${t.base}/a/freebie/turn-credentials`
    const res = await fetch(url, { method: 'POST', headers: { authorization: nip98(url) } })
    expect(res.status).toBe(404)
    expect(t.turn().opts.credentials(turnName)).toBeNull()
    registered.close()

    await setOpen(true)
    ;(await WsClient.open(`${t.wsBase}/a/freebie`)).close()
  })

  test('disabling a registered app closes its realm sockets', async () => {
    const realm = await WsClient.open(`${t.wsBase}/a/reg`)
    await api(t.base, '/api/admin/apps/reg', { cookie, method: 'PATCH', body: { enabled: false } })
    await realm.waitClosed()
    expect(realm.closed?.code).toBe(4002)
  })
})
