import { useState } from 'react'
import { useValue } from '@/lib/signals'
import { Async, useResource } from '../components/Async'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Stat,
  Tabs,
} from '../components/ui'
import { api } from '../ctx'
import { formatAgo, formatDate, formatSats, shortHex, shortNpub } from '../format'
import { PAGE_HELP } from '../help'
import { currentQuery, navigate } from '../router'
import { performWrite } from '../store'
import type { InvoiceStatus } from '../types'

type Tab = 'plans' | 'invoices' | 'paid' | 'wallet'

const STATUS_TONE: Record<InvoiceStatus, 'ok' | 'warn' | 'muted' | 'violet'> = {
  paid: 'ok',
  pending: 'warn',
  expired: 'muted',
  refunded: 'violet',
}

export function Payments() {
  const tab = (useValue(currentQuery).get('tab') as Tab) || 'plans'
  const invoices = useResource(() => api.payments.invoices(), [])
  const revenue = invoices.data
    ?.filter((i) => i.status === 'paid')
    .reduce((s, i) => s + i.amountSats, 0)
  const pending = invoices.data?.filter((i) => i.status === 'pending').length
  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Lightning plans for paid write access"
        intro={PAGE_HELP.payments}
      />
      <div className="grid grid-cols-2 gap-4">
        <Stat
          label="Revenue (listed)"
          value={formatSats(revenue)}
          help="Sum of paid invoices in the Invoices list, in satoshis (1 BTC = 100,000,000 sats)."
        />
        <Stat
          label="Pending invoices"
          value={pending ?? '—'}
          tone="warn"
          help="Invoices created on /pay that have not been paid yet. They expire on their own if nobody pays."
        />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={(t) => navigate(`/payments?tab=${t}`, { replace: true })}
        tabs={[
          {
            id: 'plans',
            label: 'Plans',
            description:
              'What users can buy. Each plan is a price for a period of write access to the public relay, listed on the /pay page.',
          },
          {
            id: 'invoices',
            label: 'Invoices',
            description:
              'Every Lightning invoice the relay issued, with its status. Paid invoices grant access automatically; there is nothing to approve.',
          },
          {
            id: 'paid',
            label: 'Paid pubkeys',
            description:
              'Nostr keys that bought a plan and when their access ends. Expired keys fall back to the normal public relay policy.',
          },
          {
            id: 'wallet',
            label: 'Wallet (NWC)',
            description:
              'The Lightning wallet that receives payments. The relay never holds funds itself; it asks your wallet to create invoices and watches for payment.',
          },
        ]}
      />
      <div className="flex flex-col gap-6">
        {tab === 'plans' && <Plans />}
        {tab === 'invoices' && (
          <Card title="Invoices">
            <Async res={invoices} emptyTitle="No invoices yet">
              {(list) => (
                <DataTable
                  rows={list}
                  rowKey={(i) => i.id}
                  columns={[
                    { key: 'when', label: 'Created', render: (i) => formatDate(i.createdAt) },
                    {
                      key: 'pk',
                      label: 'Pubkey',
                      help: 'The Nostr key that will get write access once this invoice is paid.',
                      render: (i) => <Mono>{shortNpub(i.pubkey)}</Mono>,
                    },
                    { key: 'plan', label: 'Plan', render: (i) => i.planId },
                    { key: 'amt', label: 'Amount', render: (i) => formatSats(i.amountSats) },
                    {
                      key: 'st',
                      label: 'Status',
                      help: 'pending: waiting for payment · paid: access granted · expired: not paid in time · refunded: money returned.',
                      render: (i) => <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>,
                    },
                  ]}
                />
              )}
            </Async>
          </Card>
        )}
        {tab === 'paid' && <Paid />}
        {tab === 'wallet' && <Wallet />}
      </div>
    </>
  )
}

function Plans() {
  const res = useResource(() => api.payments.plans(), [])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    priceSats: '5000',
    periodDays: '30',
    description: '',
  })
  const valid = form.name.trim() && Number(form.priceSats) >= 0 && Number(form.periodDays) > 0
  const create = async () => {
    setOpen(false)
    const plan = {
      name: form.name.trim(),
      priceSats: Number(form.priceSats),
      periodDays: Number(form.periodDays),
      description: form.description.trim() || undefined,
      active: true,
      appId: null,
    }
    const r = await performWrite({
      title: 'Create plan',
      action: 'Create plan',
      scope: [
        `Plan “${plan.name}”: ${formatSats(plan.priceSats)} per ${plan.periodDays} days`,
        'Listed on the public /pay page immediately',
        'Payers get write access to the public relay for the period',
      ],
      run: () => api.payments.createPlan(plan),
      success: 'Plan created',
    })
    if (r.ok) {
      setForm({ name: '', priceSats: '5000', periodDays: '30', description: '' })
      void res.reload()
    }
  }
  return (
    <Card
      title="Plans"
      description="With no active plans, writing to the public relay stays free (subject to policy). Add a plan to require payment."
      actions={
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          New plan
        </Button>
      }
    >
      <Async res={res} emptyTitle="No plans. Writes are free.">
        {(plans) => (
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plans.map((p) => (
              <li key={p.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.name}</span>
                  <Badge tone={p.active ? 'ok' : 'muted'}>{p.active ? 'active' : 'inactive'}</Badge>
                </div>
                <div className="text-xl font-semibold text-primary mt-1">
                  {formatSats(p.priceSats)}
                </div>
                <div className="text-xs text-muted-foreground">per {p.periodDays} days</div>
                {p.description && (
                  <p className="text-sm text-muted-foreground mt-2">{p.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New plan"
        description="Creates a plan users can buy on /pay. Paying it lets their pubkey publish to the public relay for the chosen number of days."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!valid} onClick={create}>
              Continue
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" hint="Shown to buyers, e.g. “Monthly” or “Supporter”.">
            <Input value={form.name} onValue={(v) => setForm({ ...form, name: v })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (sats)" help="Price in satoshis (100,000,000 sats = 1 BTC).">
              <Input
                type="number"
                min={0}
                value={form.priceSats}
                onValue={(v) => setForm({ ...form, priceSats: v })}
              />
            </Field>
            <Field label="Period (days)" help="How long write access lasts after payment.">
              <Input
                type="number"
                min={1}
                value={form.periodDays}
                onValue={(v) => setForm({ ...form, periodDays: v })}
              />
            </Field>
          </div>
          <Field label="Description" hint="Optional. What buyers get, shown on /pay.">
            <Input value={form.description} onValue={(v) => setForm({ ...form, description: v })} />
          </Field>
        </div>
      </Modal>
    </Card>
  )
}

function Paid() {
  const res = useResource(() => api.payments.paid(), [])
  return (
    <Card title="Paid pubkeys">
      <Async res={res} emptyTitle="Nobody has paid yet">
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(p) => `${p.pubkey}-${p.planId}-${p.since}`}
            columns={[
              { key: 'pk', label: 'Pubkey', render: (p) => <Mono>{shortNpub(p.pubkey)}</Mono> },
              { key: 'plan', label: 'Plan', render: (p) => p.planId },
              {
                key: 'since',
                label: 'Since',
                help: 'When the payment that started this access was received.',
                render: (p) => formatAgo(p.since),
              },
              {
                key: 'exp',
                label: 'Expires',
                help: 'When write access ends unless the user pays again.',
                render: (p) =>
                  p.expiresAt * 1000 < Date.now() ? (
                    <Badge tone="danger">expired</Badge>
                  ) : (
                    formatAgo(p.expiresAt)
                  ),
              },
            ]}
          />
        )}
      </Async>
    </Card>
  )
}

function Wallet() {
  const res = useResource(() => api.payments.nwc(), [])
  const [uri, setUri] = useState('')
  const [lnurl, setLnurl] = useState('')
  const validUri = /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?/i.test(uri.trim())
  return (
    <Async res={res} empty={() => false}>
      {(nwc) => (
        <div className="grid gap-6 md:grid-cols-2">
          <Card
            title="Nostr Wallet Connect"
            description="NWC lets the relay talk to your Lightning wallet over Nostr to create invoices and detect payments. Create a connection in your wallet (Alby Hub, Mutiny, etc.) with permission to make and look up invoices, then paste its URI here."
          >
            <div className="flex items-center gap-2 mb-3">
              <Badge tone={nwc.connected ? 'ok' : 'danger'}>
                {nwc.connected ? 'connected' : 'disconnected'}
              </Badge>
              {nwc.balanceSats != null && (
                <span className="text-sm text-muted-foreground">{formatSats(nwc.balanceSats)}</span>
              )}
            </div>
            <dl className="text-sm space-y-1 mb-4">
              {nwc.walletPubkey && (
                <div>
                  <dt className="text-xs text-muted-foreground inline">Wallet </dt>
                  <dd className="inline">
                    <Mono>{shortHex(nwc.walletPubkey, 12, 6)}</Mono>
                  </dd>
                </div>
              )}
              {nwc.relay && (
                <div>
                  <dt className="text-xs text-muted-foreground inline">Relay </dt>
                  <dd className="inline">
                    <Mono>{nwc.relay}</Mono>
                  </dd>
                </div>
              )}
            </dl>
            <Field
              label="Connection URI"
              hint="nostr+walletconnect://… from Alby Hub, Mutiny, etc. Stored encrypted."
              help="Treat this URI like a password: it contains a secret that controls the wallet connection. Give it receive-only permissions if your wallet allows."
            >
              <Input
                value={uri}
                onValue={setUri}
                type="password"
                autoComplete="off"
                placeholder="nostr+walletconnect://"
              />
            </Field>
            <div className="flex gap-2 mt-3 flex-wrap">
              <Button
                variant="primary"
                disabled={!validUri}
                onClick={async () => {
                  const r = await performWrite({
                    title: nwc.connected ? 'Reconnect wallet' : 'Connect wallet',
                    action: 'Connect',
                    scope: [
                      'Replaces the wallet used to issue invoices for every plan',
                      nwc.connected
                        ? 'Pending invoices from the old wallet can still be paid but will not be detected'
                        : 'Enables paid plans on /pay',
                    ],
                    run: () => api.payments.setNwc({ uri: uri.trim() }),
                    success: 'Wallet connected',
                  })
                  if (r.ok) {
                    setUri('')
                    res.mutate(() => r.value)
                  }
                }}
              >
                {nwc.connected ? 'Reconnect' : 'Connect'}
              </Button>
              {nwc.connected && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    const r = await performWrite({
                      title: 'Disconnect wallet',
                      action: 'Disconnect',
                      danger: true,
                      scope: [
                        'Removes the NWC connection',
                        'New invoices cannot be created; paid plans stop accepting payments',
                      ],
                      run: () => api.payments.setNwc({ uri: null }),
                    })
                    if (r.ok) res.mutate(() => r.value)
                  }}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </Card>
          <Card
            title="Lightning address / LNURL"
            description="A Lightning address (like an email address for payments) where people can send tips or pay manually. It is shown on /pay and advertised in your NIP-11 document."
          >
            <p className="text-sm text-muted-foreground mb-3">
              Current: <Mono>{nwc.lnurl ?? 'not set'}</Mono>
            </p>
            <Field label="LNURL or lightning address">
              <Input value={lnurl} onValue={setLnurl} placeholder="pay@relay.example.com" />
            </Field>
            <Button
              className="mt-3"
              disabled={!lnurl.trim()}
              onClick={async () => {
                const r = await performWrite({
                  title: 'Update LNURL',
                  action: 'Save',
                  scope: [
                    `${nwc.lnurl ?? 'none'} → ${lnurl.trim()}`,
                    'Shown on /pay and in the NIP-11 payments_url',
                  ],
                  run: () => api.payments.setNwc({ lnurl: lnurl.trim() }),
                })
                if (r.ok) {
                  setLnurl('')
                  res.mutate(() => r.value)
                }
              }}
            >
              Save
            </Button>
          </Card>
        </div>
      )}
    </Async>
  )
}
