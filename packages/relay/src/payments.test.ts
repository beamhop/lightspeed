import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { api, bootstrapPubkeyAdmin, startTestRelay, type TestRelay, WsClient } from './testing'
import { getPublicKey, randomHex, signEvent } from './util/crypto'

const NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Fwallet.example&secret=${'c'.repeat(64)}`

let t: TestRelay
let cookie: string
const sk = randomHex(32)
const pk = getPublicKey(sk)

beforeAll(async () => {
  t = await startTestRelay({ payments: { required: true }, publicUrl: '' })
  cookie = await bootstrapPubkeyAdmin(t, getPublicKey(randomHex(32)))
})
afterAll(() => t.close())

describe('payments', () => {
  test('without a wallet the /pay page says payments are off', async () => {
    const html = await fetch(`${t.base}/pay`).then((r) => r.text())
    expect(html).toContain('Payments are not enabled')
    const r = await api(t.base, '/pay/invoice', { body: { pubkey: pk, planId: 1 } })
    expect(r.status).toBe(404)
  })

  test('admin connects NWC and creates a plan; NIP-11 advertises payments_url + fees', async () => {
    expect(
      (
        await api(t.base, '/api/admin/payments/nwc', {
          method: 'PUT',
          cookie,
          body: { url: 'nope' },
        })
      ).status,
    ).toBe(400)
    const nwc = await api(t.base, '/api/admin/payments/nwc', {
      method: 'PUT',
      cookie,
      body: { url: NWC },
    })
    expect(nwc.body).toMatchObject({
      configured: true,
      walletPubkey: 'b'.repeat(64),
      relays: ['wss://wallet.example'],
    })
    expect(JSON.stringify(nwc.body)).not.toContain('c'.repeat(64))
    const p = await api(t.base, '/api/admin/payments/plans', {
      cookie,
      body: { name: 'Monthly', amountSats: 2100, durationDays: 30 },
    })
    expect(p.status).toBe(201)
    expect(p.body).toMatchObject({ id: 1, amountSats: 2100, active: true })
    expect(
      (
        await api(t.base, '/api/admin/payments/plans', {
          cookie,
          body: { name: 'Bad', amountSats: 0, durationDays: 1 },
        })
      ).status,
    ).toBe(400)
    const info = t.nostr().info
    expect(info.payments_url).toMatch(/\/pay$/)
    expect(info.fees?.subscription).toEqual([
      { amount: 2_100_000, unit: 'msats', period: 30 * 86400 },
    ])
    expect(info.limitation).toMatchObject({ payment_required: true })
  })

  test('unpaid pubkeys cannot write when payments are required', async () => {
    const ws = await WsClient.open(`${t.wsBase}/`)
    const e = signEvent(sk, { kind: 1, content: 'before paying', tags: [] })
    ws.send(JSON.stringify(['EVENT', e]))
    const ok = await ws.next((m) => m[0] === 'OK')
    expect(ok[2]).toBe(false)
    expect(ok[3]).toStartWith('restricted:')
    ws.close()
  })

  test('/pay page, invoice with QR, payment, then writes are allowed', async () => {
    const html = await fetch(`${t.base}/pay`).then((r) => r.text())
    expect(html).toContain('Monthly')
    expect(html).toContain('window.nostr')

    expect(
      (await api(t.base, '/pay/invoice', { body: { pubkey: 'garbage', planId: 1 } })).status,
    ).toBe(400)
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
    const viaNpub = await api(t.base, '/pay/invoice', { body: { pubkey: npub, planId: 1 } })
    expect(viaNpub.status).toBe(201)

    const inv = await api(t.base, '/pay/invoice', { body: { pubkey: pk, planId: 1 } })
    expect(inv.status).toBe(201)
    expect(inv.body.invoice).toStartWith('lnbc')
    expect(inv.body.amountSats).toBe(2100)
    expect(inv.body.qr).toContain('<svg')
    const hash = inv.body.paymentHash

    expect((await api(t.base, `/pay/invoice/${hash}`)).body.status).toBe('pending')
    t.nwc.pay(hash)
    const paid = await api(t.base, `/pay/invoice/${hash}`)
    expect(paid.body.status).toBe('paid')
    const now = Math.floor(Date.now() / 1000)
    expect(paid.body.paidUntil).toBeGreaterThan(now + 29 * 86400)
    expect((await api(t.base, `/pay/status/${pk}`)).body.paid).toBe(true)

    const ws = await WsClient.open(`${t.wsBase}/`)
    const e = signEvent(sk, { kind: 1, content: 'after paying', tags: [] })
    ws.send(JSON.stringify(['EVENT', e]))
    expect((await ws.next((m) => m[0] === 'OK'))[2]).toBe(true)
    ws.close()

    // Paying again extends from the current expiry.
    const inv2 = await api(t.base, '/pay/invoice', { body: { pubkey: pk, planId: 1 } })
    t.nwc.pay(inv2.body.paymentHash)
    const paid2 = await api(t.base, `/pay/invoice/${inv2.body.paymentHash}`)
    expect(paid2.body.paidUntil).toBeGreaterThan(now + 59 * 86400)
  })

  test('admin views invoices, paid pubkeys, revenue; can extend and revoke', async () => {
    const inv = await api(t.base, '/api/admin/payments/invoices', { cookie })
    expect(inv.body.invoices).toHaveLength(3)
    expect(inv.body.revenueSats).toBe(4200)
    const paidOnly = await api(t.base, '/api/admin/payments/invoices?status=paid', { cookie })
    expect(paidOnly.body.invoices).toHaveLength(2)
    const paid = await api(t.base, '/api/admin/payments/paid', { cookie })
    expect(paid.body.paid.map((p: { pubkey: string }) => p.pubkey)).toEqual([pk])

    const other = getPublicKey(randomHex(32))
    await api(t.base, '/api/admin/payments/paid', { cookie, body: { pubkey: other, days: 7 } })
    expect(t.nostr().opts.policy?.get(null).writeAllowed?.(other)).toBe(true)
    await api(t.base, '/api/admin/payments/paid', { cookie, body: { pubkey: other, days: -30 } })
    expect(t.nostr().opts.policy?.get(null).writeAllowed?.(other)).toBe(false)

    const overview = await api(t.base, '/api/admin/overview', { cookie })
    expect(overview.body.counters.revenueSats).toBe(4200)
    const metrics = await fetch(`${t.base}/metrics`).then((r) => r.text())
    expect(metrics).toContain('beamhop_paid_pubkeys 1')
  })

  test('realms only require payment when their policy says so', async () => {
    await api(t.base, '/api/admin/apps', { cookie, body: { name: 'Free', id: 'free' } })
    const stranger = getPublicKey(randomHex(32))
    expect(t.nostr().opts.policy?.get('free').writeAllowed?.(stranger)).toBe(true)
    await api(t.base, '/api/admin/policies/free', {
      method: 'PUT',
      cookie,
      body: { requirePayment: true },
    })
    expect(t.nostr().opts.policy?.get('free').writeAllowed?.(stranger)).toBe(false)
    expect(t.nostr().opts.policy?.get('free').writeAllowed?.(pk)).toBe(true)
  })
})
