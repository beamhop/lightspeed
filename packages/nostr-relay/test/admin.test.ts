import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNostrRelay, type Nip11Info, staticPolicy } from '../src/index'
import { Client, genKeys, manage, nip98Header, sign, startRelay, type TestRelay } from './helpers'

let t: TestRelay | undefined
const clients: Client[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  t?.close()
  t = undefined
})

describe('NIP-11 relay information', () => {
  test('serves the document with CORS and per-realm merge', async () => {
    t = startRelay({
      info: { name: 'Beamhop', description: 'public', contact: 'ops@example.com' },
      policy: staticPolicy({
        global: { minPow: 4, maxSubscriptions: 20 },
        realms: { app1: { authRequired: true, info: { name: 'App One', description: 'realm' } } },
      }),
    })
    const res = await fetch(`${t.httpUrl}/`, { headers: { accept: 'application/nostr+json' } })
    expect(res.headers.get('content-type')).toBe('application/nostr+json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const doc = (await res.json()) as Nip11Info
    expect(doc.name).toBe('Beamhop')
    expect(doc.supported_nips).toEqual([1, 9, 11, 13, 40, 42, 45, 50, 70, 77, 86])
    expect(doc.limitation?.min_pow_difficulty).toBe(4)
    expect(doc.limitation?.max_subscriptions).toBe(20)
    expect(doc.limitation?.auth_required).toBe(false)

    const r = (await (
      await fetch(`${t.httpUrl}/a/app1`, { headers: { accept: 'application/nostr+json' } })
    ).json()) as Nip11Info
    expect(r.name).toBe('App One')
    expect(r.description).toBe('realm')
    expect(r.contact).toBe('ops@example.com')
    expect(r.limitation?.auth_required).toBe(true)

    const pre = await fetch(`${t.httpUrl}/`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
  })
})

describe('NIP-86 management with NIP-98 auth', () => {
  const admin = genKeys()

  test('rejects missing, forged and non-admin auth', async () => {
    t = startRelay({ admins: [admin.pk] })
    const url = `${t.httpUrl}/`
    const body = JSON.stringify({ method: 'supportedmethods', params: [] })
    const post = (headers: Record<string, string>, b = body) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/nostr+json+rpc', ...headers },
        body: b,
      })
    expect((await post({})).status).toBe(401)
    // wrong url
    expect(
      (await post({ authorization: nip98Header(admin, 'http://other.example/', 'POST', body) }))
        .status,
    ).toBe(401)
    // payload mismatch
    const other = JSON.stringify({ method: 'banpubkey', params: ['0'.repeat(64)] })
    const res = await post({ authorization: nip98Header(admin, url, 'POST', body) }, other)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe(
      'NIP-98 payload tag does not match the body',
    )
    // valid auth but not an admin
    const r = await manage(t, genKeys(), 'supportedmethods')
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('not an admin')
    // admin
    const ok = await manage(t, admin, 'supportedmethods')
    expect(ok.status).toBe(200)
    expect(ok.body.result).toContain('banpubkey')
  })

  test('ban/allow pubkeys, ban events, kinds, IPs and relay metadata', async () => {
    t = startRelay({ admins: [admin.pk] })
    const c = await Client.connect(t.url)
    clients.push(c)
    const spammer = genKeys()
    const user = genKeys()

    expect((await manage(t, admin, 'banpubkey', [spammer.pk, 'spam'])).body.result).toBe(true)
    expect((await manage(t, admin, 'listbannedpubkeys')).body.result).toEqual([
      { pubkey: spammer.pk, reason: 'spam' },
    ])
    expect(await c.publish(sign(spammer))).toEqual({
      ok: false,
      message: 'blocked: pubkey is banned',
    })
    await manage(t, admin, 'unbanpubkey', [spammer.pk])
    expect((await c.publish(sign(spammer))).ok).toBe(true)

    // banevent deletes and blocks re-publish
    const e = sign(user, { content: 'bad' })
    await c.publish(e)
    await manage(t, admin, 'banevent', [e.id, 'illegal'])
    expect(await c.query({ ids: [e.id] })).toEqual([])
    expect((await c.publish(e)).message).toBe('blocked: this event is banned')
    expect((await manage(t, admin, 'listbannedevents')).body.result).toEqual([
      { id: e.id, reason: 'illegal' },
    ])
    await manage(t, admin, 'allowevent', [e.id])
    expect((await c.publish(e)).ok).toBe(true)

    // allowkind turns the relay into a kind allowlist; disallowkind blocks a kind
    await manage(t, admin, 'allowkind', [1])
    expect((await manage(t, admin, 'listallowedkinds')).body.result).toEqual([1])
    expect((await c.publish(sign(user, { kind: 7 }))).message).toBe(
      'blocked: kind 7 is not allowed',
    )
    await manage(t, admin, 'disallowkind', [1])
    expect((await c.publish(sign(user, { kind: 1 }))).message).toBe(
      'blocked: kind 1 is not allowed',
    )

    // allowpubkey turns on the write allowlist
    await manage(t, admin, 'disallowkind', [1])
    t.relay.moderation.allowKind(null, 1)
    await manage(t, admin, 'allowpubkey', [user.pk])
    expect((await c.publish(sign(user, { content: 'allowed' }))).ok).toBe(true)
    expect((await c.publish(sign(genKeys()))).message).toBe(
      'restricted: this pubkey is not allowed to write here',
    )
    expect((await manage(t, admin, 'listallowedpubkeys')).body.result).toEqual([
      { pubkey: user.pk, reason: '' },
    ])

    // relay metadata flows into NIP-11
    await manage(t, admin, 'changerelayname', ['Renamed'])
    await manage(t, admin, 'changerelaydescription', ['New description'])
    await manage(t, admin, 'changerelayicon', ['https://example.com/i.png'])
    const doc = (await (
      await fetch(`${t.httpUrl}/`, { headers: { accept: 'application/nostr+json' } })
    ).json()) as Record<string, string>
    expect(doc.name).toBe('Renamed')
    expect(doc.description).toBe('New description')
    expect(doc.icon).toBe('https://example.com/i.png')

    // IP blocks apply to new events from that IP
    await manage(t, admin, 'blockip', ['127.0.0.1', 'abuse'])
    expect((await manage(t, admin, 'listblockedips')).body.result).toEqual([
      { ip: '127.0.0.1', reason: 'abuse' },
    ])
    expect((await c.publish(sign(user))).message).toBe('blocked: your IP address is blocked')
    await manage(t, admin, 'unblockip', ['127.0.0.1'])
    expect((await c.publish(sign(user))).ok).toBe(true)

    // errors come back in the RPC envelope
    const bad = await manage(t, admin, 'nosuchmethod')
    expect(bad.body).toEqual({ result: null, error: 'unsupported method: nosuchmethod' })
  })

  test('management is scoped per realm and realm admins come from policy', async () => {
    const realmAdmin = genKeys()
    t = startRelay({ policy: staticPolicy({ realms: { app1: { admins: [realmAdmin.pk] } } }) })
    const victim = genKeys()
    expect((await manage(t, realmAdmin, 'banpubkey', [victim.pk], '/a/app1')).status).toBe(200)
    expect((await manage(t, realmAdmin, 'banpubkey', [victim.pk], '/')).status).toBe(401)
    expect((await t.relay.publish(sign(victim), 'app1')).message).toBe('blocked: pubkey is banned')
    expect((await t.relay.publish(sign(victim), null)).ok).toBe(true)
    expect((await t.relay.publish(sign(victim), 'app2')).ok).toBe(true)
  })
})

describe('storage', () => {
  test('WAL mode, migrations table, persistence and backup via VACUUM INTO', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nostr-relay-'))
    try {
      const dbPath = join(dir, 'nostr.db')
      const r1 = createNostrRelay({ dbPath, info: {}, sweepIntervalMs: 0 })
      const e = sign(genKeys(), { content: 'persist me' })
      await r1.publish(e)
      r1.moderation.banPubkey(null, 'f'.repeat(64))
      const backupPath = join(dir, 'backup.db')
      r1.backup(backupPath)
      r1.close()

      const raw = new Database(dbPath)
      expect(
        (raw.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('wal')
      expect(raw.query('SELECT version FROM migrations').all()).toEqual([{ version: 1 }])
      raw.close()

      const r2 = createNostrRelay({ dbPath, info: {}, sweepIntervalMs: 0 })
      expect(r2.query([{ ids: [e.id] }])).toEqual([e])
      expect(r2.moderation.listBannedPubkeys(null).length).toBe(1)
      r2.close()

      const r3 = createNostrRelay({ dbPath: backupPath, info: {}, sweepIntervalMs: 0 })
      expect(r3.query([{ search: 'persist' }]).map((x) => x.id)).toEqual([e.id])
      r3.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteEvent removes stored events (admin)', async () => {
    const r = createNostrRelay({ dbPath: ':memory:', info: {}, sweepIntervalMs: 0 })
    const e = sign(genKeys())
    await r.publish(e, 'x')
    expect(r.deleteEvent(e.id, null)).toBe(false)
    expect(r.deleteEvent(e.id, 'x')).toBe(true)
    expect(r.query([{}], 'x')).toEqual([])
    r.close()
  })
})
