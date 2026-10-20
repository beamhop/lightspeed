import { describe, expect, test } from 'bun:test'
import type { NostrEvent } from './engines'
import {
  createNwcClient,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  nip04Decrypt,
  nip04Encrypt,
  parseNwcUrl,
} from './nwc'
import { getPublicKey, randomHex, signEvent, tagValue } from './util/crypto'

describe('NIP-04', () => {
  test('round-trip between two keys', async () => {
    const a = randomHex(32)
    const b = randomHex(32)
    const ct = await nip04Encrypt(a, getPublicKey(b), 'hello wallet')
    expect(ct).toContain('?iv=')
    expect(await nip04Decrypt(b, getPublicKey(a), ct)).toBe('hello wallet')
  })
})

describe('NWC client', () => {
  test('parses URIs', () => {
    const u = parseNwcUrl(
      `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://r.example&relay=wss://r2.example&secret=${'1'.repeat(64)}&lud16=x@y`,
    )
    expect(u.relays).toEqual(['wss://r.example', 'wss://r2.example'])
    expect(u.lud16).toBe('x@y')
    expect(() => parseNwcUrl('https://nope')).toThrow()
    expect(() => parseNwcUrl(`nostr+walletconnect://${'a'.repeat(64)}?relay=wss://r`)).toThrow()
  })

  test('make_invoice + lookup_invoice against a local wallet relay', async () => {
    const walletSk = randomHex(32)
    const walletPk = getPublicKey(walletSk)
    const clientSk = randomHex(32)
    const settled = new Set<string>()
    const requests: string[] = []
    type S = { subs: Map<string, unknown> }
    const server = Bun.serve<S>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { data: { subs: new Map() } })
          ? undefined
          : new Response('ws only', { status: 400 })
      },
      websocket: {
        async message(ws, raw) {
          const msg = JSON.parse(String(raw))
          if (msg[0] === 'REQ') {
            ws.data.subs.set(msg[1], msg[2])
            ws.send(JSON.stringify(['EOSE', msg[1]]))
            return
          }
          if (msg[0] !== 'EVENT') return
          const ev = msg[1] as NostrEvent
          ws.send(JSON.stringify(['OK', ev.id, true, '']))
          if (ev.kind !== NWC_REQUEST_KIND || tagValue(ev, 'p') !== walletPk) return
          const { method, params } = JSON.parse(await nip04Decrypt(walletSk, ev.pubkey, ev.content))
          requests.push(method)
          let result: Record<string, unknown>
          if (method === 'make_invoice') {
            result = {
              type: 'incoming',
              invoice: `lnbc${params.amount / 1000}n1test`,
              payment_hash: 'ab'.repeat(32),
              amount: params.amount,
              expires_at: 2_000_000_000,
            }
            settled.add('ab'.repeat(32))
          } else {
            result = {
              payment_hash: params.payment_hash,
              settled_at: settled.has(params.payment_hash) ? 1_700_000_000 : null,
              preimage: 'cd'.repeat(32),
            }
          }
          const content = await nip04Encrypt(
            walletSk,
            ev.pubkey,
            JSON.stringify({ result_type: method, error: null, result }),
          )
          const res = signEvent(walletSk, {
            kind: NWC_RESPONSE_KIND,
            content,
            tags: [
              ['p', ev.pubkey],
              ['e', ev.id],
            ],
          })
          for (const sub of ws.data.subs.keys()) ws.send(JSON.stringify(['EVENT', sub, res]))
        },
      },
    })
    const client = createNwcClient(
      `nostr+walletconnect://${walletPk}?relay=${encodeURIComponent(`ws://127.0.0.1:${server.port}`)}&secret=${clientSk}`,
      { timeoutMs: 3000 },
    )
    try {
      const inv = await client.makeInvoice({
        amountMsat: 21_000,
        description: 'test',
        expirySec: 600,
      })
      expect(inv).toEqual({
        invoice: 'lnbc21n1test',
        paymentHash: 'ab'.repeat(32),
        expiresAt: 2_000_000_000,
      })
      const st = await client.lookupInvoice({ paymentHash: inv.paymentHash })
      expect(st).toMatchObject({ paid: true, settledAt: 1_700_000_000, preimage: 'cd'.repeat(32) })
      const unpaid = await client.lookupInvoice({ paymentHash: 'ef'.repeat(32) })
      expect(unpaid.paid).toBe(false)
      expect(requests).toEqual(['make_invoice', 'lookup_invoice', 'lookup_invoice'])
    } finally {
      client.close()
      server.stop(true)
    }
  })
})
