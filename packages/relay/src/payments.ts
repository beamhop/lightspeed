import type { AdminDb } from './db'
import type { Nip11Info } from './engines'
import type { Logger } from './log'
import { type NwcClient, parseNwcUrl } from './nwc'
import { isHex64 } from './util/crypto'
import { HttpError } from './util/http'

export interface Plan {
  id: number
  name: string
  description: string
  amountSats: number
  durationDays: number
  active: boolean
  createdAt: number
}

export interface Invoice {
  paymentHash: string
  bolt11: string
  pubkey: string
  planId: number | null
  amountMsat: number
  status: 'pending' | 'paid' | 'expired'
  createdAt: number
  expiresAt: number
  paidAt: number | null
}

export interface PaidPubkey {
  pubkey: string
  planId: number | null
  expiresAt: number
  updatedAt: number
}

const planFromRow = (r: Record<string, unknown>): Plan => ({
  id: r.id as number,
  name: r.name as string,
  description: r.description as string,
  amountSats: r.amount_sats as number,
  durationDays: r.duration_days as number,
  active: !!r.active,
  createdAt: r.created_at as number,
})

const invoiceFromRow = (r: Record<string, unknown>): Invoice => ({
  paymentHash: r.payment_hash as string,
  bolt11: r.bolt11 as string,
  pubkey: r.pubkey as string,
  planId: (r.plan_id as number | null) ?? null,
  amountMsat: r.amount_msat as number,
  status: r.status as Invoice['status'],
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  paidAt: (r.paid_at as number | null) ?? null,
})

/**
 * Lightning plans via NWC: invoices per pubkey + plan, a paid-until table and the isPaid() check
 * the policy provider's writeAllowed hook consults.
 */
export class Payments {
  private nwc: NwcClient | null = null
  private nwcUrl = ''
  private paidCache = new Map<string, number>()

  constructor(
    private adb: AdminDb,
    private opts: {
      nwcFactory: (url: string) => NwcClient
      nwcUrl: string
      invoiceExpirySec: number
      logger: Logger
    },
  ) {
    const url = adb.getSetting<string>('nwc_url') ?? opts.nwcUrl
    if (url) {
      try {
        this.connect(url)
      } catch (e) {
        opts.logger.error('invalid NWC URL; payments disabled', { error: e })
      }
    }
    this.loadPaid()
  }

  private connect(url: string) {
    parseNwcUrl(url)
    this.nwc?.close()
    this.nwc = this.opts.nwcFactory(url)
    this.nwcUrl = url
  }

  /** Update the wallet connection (admin PUT /payments/nwc). Empty string disconnects. */
  setNwcUrl(url: string) {
    if (!url) {
      this.nwc?.close()
      this.nwc = null
      this.nwcUrl = ''
      this.adb.setSetting('nwc_url', '')
      return
    }
    try {
      parseNwcUrl(url)
    } catch (e) {
      throw new HttpError(400, 'invalid', (e as Error).message)
    }
    this.connect(url)
    this.adb.setSetting('nwc_url', url)
  }

  nwcStatus() {
    if (!this.nwcUrl) return { configured: false }
    const u = parseNwcUrl(this.nwcUrl)
    return {
      configured: true,
      walletPubkey: u.walletPubkey,
      relays: u.relays,
      lud16: u.lud16 ?? null,
    }
  }

  get enabled(): boolean {
    return !!this.nwc
  }

  // ------------------------------------------------------------ plans

  plans(includeInactive = false): Plan[] {
    const rows = this.adb.db
      .query(
        `SELECT * FROM plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY amount_sats, id`,
      )
      .all() as Record<string, unknown>[]
    return rows.map(planFromRow)
  }

  plan(id: number): Plan | null {
    const r = this.adb.db.query('SELECT * FROM plans WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null
    return r ? planFromRow(r) : null
  }

  /** Create a plan, or update one when `id` is given. */
  savePlan(input: Record<string, unknown>): Plan {
    const name = String(input.name ?? '').trim()
    const amountSats = Number(input.amountSats)
    const durationDays = Number(input.durationDays)
    const description = String(input.description ?? '')
    const active = input.active === undefined ? true : !!input.active
    if (!name) throw new HttpError(400, 'invalid', 'name is required')
    if (!Number.isInteger(amountSats) || amountSats <= 0)
      throw new HttpError(400, 'invalid', 'amountSats must be a positive integer')
    if (!Number.isInteger(durationDays) || durationDays <= 0)
      throw new HttpError(400, 'invalid', 'durationDays must be a positive integer')
    if (input.id !== undefined) {
      const id = Number(input.id)
      if (!this.plan(id)) throw new HttpError(404, 'not-found', 'plan not found')
      this.adb.db
        .query(
          'UPDATE plans SET name = ?, description = ?, amount_sats = ?, duration_days = ?, active = ? WHERE id = ?',
        )
        .run(name, description, amountSats, durationDays, active ? 1 : 0, id)
      return this.plan(id) as Plan
    }
    const r = this.adb.db
      .query(
        'INSERT INTO plans (name, description, amount_sats, duration_days, active, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(name, description, amountSats, durationDays, active ? 1 : 0, this.adb.now())
    return this.plan(Number(r.lastInsertRowid)) as Plan
  }

  // ------------------------------------------------------------ invoices

  async createInvoice(pubkey: string, planId: number): Promise<Invoice> {
    if (!isHex64(pubkey))
      throw new HttpError(400, 'invalid', 'pubkey must be 64 hex chars or an npub')
    const plan = this.plan(planId)
    if (!plan?.active) throw new HttpError(404, 'not-found', 'plan not found')
    if (!this.nwc) throw new HttpError(503, 'payments-disabled', 'no wallet connected')
    const amountMsat = plan.amountSats * 1000
    const made = await this.nwc
      .makeInvoice({
        amountMsat,
        description: `Beamhop relay: ${plan.name} (${plan.durationDays} days) for ${pubkey.slice(0, 12)}`,
        expirySec: this.opts.invoiceExpirySec,
      })
      .catch((e: Error) => {
        throw new HttpError(502, 'wallet-error', e.message)
      })
    const t = this.adb.now()
    this.adb.db
      .query(
        `INSERT INTO invoices (payment_hash, bolt11, pubkey, plan_id, amount_msat, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        made.paymentHash,
        made.invoice,
        pubkey,
        plan.id,
        amountMsat,
        t,
        made.expiresAt ?? t + this.opts.invoiceExpirySec,
      )
    return this.invoice(made.paymentHash) as Invoice
  }

  invoice(hash: string): Invoice | null {
    const r = this.adb.db
      .query('SELECT * FROM invoices WHERE payment_hash = ?')
      .get(hash) as Record<string, unknown> | null
    return r ? invoiceFromRow(r) : null
  }

  /** Refresh a pending invoice from the wallet; grants the plan once it is paid. */
  async checkInvoice(hash: string): Promise<Invoice | null> {
    const inv = this.invoice(hash)
    if (inv?.status !== 'pending' || !this.nwc) return inv
    const t = this.adb.now()
    const st = await this.nwc.lookupInvoice({ paymentHash: hash }).catch((e: Error) => {
      this.opts.logger.warn('NWC lookup failed', { hash, error: e })
      return null
    })
    if (st?.paid) {
      this.markPaid(inv, st.settledAt ?? t)
    } else if (st?.expired || inv.expiresAt + 300 < t) {
      this.adb.db
        .query(
          "UPDATE invoices SET status = 'expired' WHERE payment_hash = ? AND status = 'pending'",
        )
        .run(hash)
    }
    return this.invoice(hash)
  }

  private markPaid(inv: Invoice, paidAt: number) {
    this.adb.db.transaction(() => {
      const r = this.adb.db
        .query(
          "UPDATE invoices SET status = 'paid', paid_at = ? WHERE payment_hash = ? AND status = 'pending'",
        )
        .run(paidAt, inv.paymentHash)
      if (!r.changes) return
      const plan = inv.planId ? this.plan(inv.planId) : null
      this.grant(inv.pubkey, plan?.durationDays ?? 30, inv.planId)
    })()
    this.opts.logger.info('invoice paid', { pubkey: inv.pubkey, hash: inv.paymentHash })
  }

  /** Extend (or with negative days, shorten) a pubkey's paid period. */
  grant(pubkey: string, days: number, planId: number | null = null): PaidPubkey {
    if (!isHex64(pubkey)) throw new HttpError(400, 'invalid', 'pubkey must be 64 hex chars')
    const t = this.adb.now()
    const cur = this.paidCache.get(pubkey) ?? 0
    const expiresAt = Math.max(cur, t) + Math.round(days * 86400)
    this.adb.db
      .query(
        `INSERT INTO paid_pubkeys (pubkey, plan_id, expires_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET plan_id = COALESCE(excluded.plan_id, plan_id), expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(pubkey, planId, expiresAt, t)
    this.paidCache.set(pubkey, expiresAt)
    return { pubkey, planId, expiresAt, updatedAt: t }
  }

  private loadPaid() {
    this.paidCache.clear()
    for (const r of this.adb.db.query('SELECT pubkey, expires_at FROM paid_pubkeys').all() as {
      pubkey: string
      expires_at: number
    }[]) {
      this.paidCache.set(r.pubkey, r.expires_at)
    }
  }

  isPaid(pubkey: string): boolean {
    return (this.paidCache.get(pubkey) ?? 0) > this.adb.now()
  }

  paid(): PaidPubkey[] {
    return (
      this.adb.db.query('SELECT * FROM paid_pubkeys ORDER BY expires_at DESC').all() as Record<
        string,
        number | string | null
      >[]
    ).map((r) => ({
      pubkey: r.pubkey as string,
      planId: (r.plan_id as number | null) ?? null,
      expiresAt: r.expires_at as number,
      updatedAt: r.updated_at as number,
    }))
  }

  invoices(opts: { status?: string; pubkey?: string; limit?: number } = {}): Invoice[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.status) {
      where.push('status = ?')
      args.push(opts.status)
    }
    if (opts.pubkey) {
      where.push('pubkey = ?')
      args.push(opts.pubkey)
    }
    args.push(Math.min(opts.limit ?? 200, 1000))
    return (
      this.adb.db
        .query(
          `SELECT * FROM invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...args) as Record<string, unknown>[]
    ).map(invoiceFromRow)
  }

  revenueSats(): number {
    const r = this.adb.db
      .query("SELECT COALESCE(SUM(amount_msat), 0) AS m FROM invoices WHERE status = 'paid'")
      .get() as { m: number }
    return Math.floor(r.m / 1000)
  }

  /** Check every pending, unexpired invoice once (background poller). */
  async pollPending(): Promise<void> {
    if (!this.nwc) return
    const t = this.adb.now()
    const rows = this.adb.db
      .query(
        "SELECT payment_hash FROM invoices WHERE status = 'pending' AND expires_at + 300 > ? LIMIT 100",
      )
      .all(t) as { payment_hash: string }[]
    for (const r of rows) await this.checkInvoice(r.payment_hash)
    this.adb.db
      .query(
        "UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND expires_at + 300 <= ?",
      )
      .run(t)
  }

  /** NIP-11 payments_url + fees.subscription (msats) for the active plans. */
  nip11(baseUrl: string): Partial<Nip11Info> {
    const plans = this.plans()
    if (!plans.length || !this.nwc) return {}
    return {
      payments_url: `${baseUrl}/pay`,
      fees: {
        subscription: plans.map((p) => ({
          amount: p.amountSats * 1000,
          unit: 'msats',
          period: p.durationDays * 86400,
        })),
      },
    }
  }

  close() {
    this.nwc?.close()
  }
}
