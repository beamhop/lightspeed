import { afterEach, describe, expect, test } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils'
import { Negentropy, NegentropyStorageVector } from '../src/negentropy'
import { Client, genKeys, now, sign, startRelay, type TestRelay } from './helpers'

const randId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

function vector(items: [number, string][]) {
  const v = new NegentropyStorageVector()
  for (const [ts, id] of items) v.insert(ts, id)
  v.seal()
  return v
}

/** Runs a full reconciliation in-process; returns client's have/need. */
function reconcileLocal(client: [number, string][], server: [number, string][], frame = 0) {
  const c = new Negentropy(vector(client), frame)
  const s = new Negentropy(vector(server), frame)
  let msg: string | null = c.initiate()
  const have: string[] = []
  const need: string[] = []
  let rounds = 0
  while (msg !== null) {
    const [reply] = s.reconcile(msg)
    const [next, h, n] = c.reconcile(reply as string)
    have.push(...h)
    need.push(...n)
    msg = next
    rounds++
    if (rounds > 100) throw new Error('did not converge')
  }
  return { have: have.sort(), need: need.sort(), rounds }
}

describe('negentropy port (unit)', () => {
  test('identical sets reconcile in one round with nothing to transfer', () => {
    const items: [number, string][] = Array.from({ length: 500 }, (_, i) => [1000 + i, randId()])
    const r = reconcileLocal(items, items)
    expect(r).toEqual({ have: [], need: [], rounds: 1 })
  })

  test('differing sets: have/need are exactly the set differences', () => {
    for (const [nShared, nClient, nServer, frame] of [
      [0, 0, 5, 0],
      [0, 7, 0, 0],
      [10, 3, 4, 0],
      [2000, 50, 70, 0],
      [5000, 300, 1, 4096],
      [3000, 400, 400, 8192],
    ] as const) {
      const shared: [number, string][] = Array.from({ length: nShared }, (_, i) => [
        1_700_000_000 + (i % 977),
        randId(),
      ])
      const onlyC: [number, string][] = Array.from({ length: nClient }, (_, i) => [
        1_700_000_000 + (i % 13),
        randId(),
      ])
      const onlyS: [number, string][] = Array.from({ length: nServer }, (_, i) => [
        1_700_000_000 + (i % 1000),
        randId(),
      ])
      const r = reconcileLocal([...shared, ...onlyC], [...shared, ...onlyS], frame)
      expect(r.have).toEqual(onlyC.map((x) => x[1]).sort())
      expect(r.need).toEqual(onlyS.map((x) => x[1]).sort())
    }
  })

  test('rejects unsupported protocol versions as initiator, answers empty as responder', () => {
    const s = new Negentropy(vector([]))
    expect(s.reconcile('62')[0]).toBe('61')
    const c = new Negentropy(vector([]))
    c.initiate()
    expect(() => c.reconcile('62')).toThrow()
  })

  test('interoperates with the nostr-tools NIP-77 implementation', async () => {
    // nostr-tools does not export nip77 in its package map; load the built file directly.
    const path = new URL('../node_modules/nostr-tools/lib/esm/nip77.js', import.meta.url).pathname
    const nt = (await import(path)) as {
      Negentropy: new (
        s: unknown,
        frame?: number,
      ) => {
        initiate(): string
        reconcile(
          m: string,
          onhave?: (id: string) => void,
          onneed?: (id: string) => void,
        ): string | null
      }
      NegentropyStorageVector: new () => { insert(ts: number, id: string): void; seal(): void }
    }
    const shared: [number, string][] = Array.from({ length: 3000 }, (_, i) => [1000 + i, randId()])
    const onlyC: [number, string][] = Array.from({ length: 40 }, (_, i) => [1500 + i, randId()])
    const onlyS: [number, string][] = Array.from({ length: 60 }, (_, i) => [2500 + i, randId()])
    // nostr-tools client (initiator) vs our responder
    const cs = new nt.NegentropyStorageVector()
    for (const [ts, id] of [...shared, ...onlyC]) cs.insert(ts, id)
    cs.seal()
    const client = new nt.Negentropy(cs)
    const server = new Negentropy(vector([...shared, ...onlyS]), 4096)
    const have: string[] = []
    const need: string[] = []
    let msg: string | null = client.initiate()
    while (msg !== null) {
      const [reply] = server.reconcile(msg)
      msg = client.reconcile(
        reply as string,
        (id) => have.push(id),
        (id) => need.push(id),
      )
    }
    expect(have.sort()).toEqual(onlyC.map((x) => x[1]).sort())
    expect(need.sort()).toEqual(onlyS.map((x) => x[1]).sort())
  })
})

describe('NIP-77 over the wire', () => {
  let t: TestRelay
  let c: Client
  afterEach(() => {
    c?.close()
    t?.close()
  })

  async function sync(client: Client, filter: object, local: [number, string][], frame = 0) {
    const neg = new Negentropy(vector(local), frame)
    const subId = 'neg1'
    client.send(['NEG-OPEN', subId, filter, neg.initiate()])
    const have: string[] = []
    const need: string[] = []
    for (;;) {
      const m = await client.next(
        (x) => (x[0] === 'NEG-MSG' || x[0] === 'NEG-ERR') && x[1] === subId,
      )
      if (m[0] === 'NEG-ERR') throw new Error(m[2] as string)
      const [next, h, n] = neg.reconcile(m[2] as string)
      have.push(...h)
      need.push(...n)
      if (next === null) break
      client.send(['NEG-MSG', subId, next])
    }
    client.send(['NEG-CLOSE', subId])
    return { have: have.sort(), need: need.sort() }
  }

  test('client reconciles against the server across differing sets', async () => {
    t = startRelay({ negentropyFrameSizeLimit: 4096 })
    c = await Client.connect(t.url)
    const k = genKeys()
    const base = now() - 10_000
    const server = Array.from({ length: 600 }, (_, i) =>
      sign(k, { content: `e${i}`, created_at: base + i }),
    )
    for (const e of server) await t.relay.publish(e)
    // other-kind and other-realm events must not be part of the set
    await t.relay.publish(sign(k, { kind: 7, created_at: base }))
    await t.relay.publish(sign(k, { created_at: base }), 'elsewhere')
    const shared = server.slice(0, 500).map((e): [number, string] => [e.created_at, e.id])
    const onlyClient: [number, string][] = Array.from({ length: 30 }, (_, i) => [
      base + i,
      randId(),
    ])
    const r = await sync(c, { kinds: [1] }, [...shared, ...onlyClient], 4096)
    expect(r.have).toEqual(onlyClient.map((x) => x[1]).sort())
    expect(r.need).toEqual(
      server
        .slice(500)
        .map((e) => e.id)
        .sort(),
    )
    // and a fully-synced client needs nothing
    const all = server.map((e): [number, string] => [e.created_at, e.id])
    expect(await sync(c, { kinds: [1] }, all)).toEqual({ have: [], need: [] })
  })

  test('NEG-ERR on too many records and on unknown sessions', async () => {
    const { staticPolicy } = await import('../src/index')
    t = startRelay({ policy: staticPolicy({ global: { maxNegentropyRecords: 5 } }) })
    c = await Client.connect(t.url)
    const k = genKeys()
    for (let i = 0; i < 6; i++) await t.relay.publish(sign(k, { content: String(i) }))
    const neg = new Negentropy(vector([]))
    c.send(['NEG-OPEN', 'n', {}, neg.initiate()])
    const m = await c.next((x) => x[0] === 'NEG-ERR')
    expect(m).toEqual(['NEG-ERR', 'n', 'blocked: too many records'])
    c.send(['NEG-MSG', 'zzz', '61'])
    expect(await c.next((x) => x[0] === 'NEG-ERR')).toEqual([
      'NEG-ERR',
      'zzz',
      'closed: unknown subscription',
    ])
  })
})
