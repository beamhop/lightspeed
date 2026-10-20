/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
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
  const tab = (currentQuery.value.get('tab') as Tab) || 'plans'
  const invoices = useResource(() => api.payments.invoices(), [])
  const revenue = invoices.data
    ?.filter((i) => i.status === 'paid')
    .reduce((s, i) => s + i.amountSats, 0)
  const pending = invoices.data?.filter((i) => i.status === 'pending').length
  return (
    <>
      <PageHeader title="Payments" subtitle="Lightning plans for paid write access" />
      <div class="grid grid-cols-2 gap-3 mb-4">
        <Stat label="Revenue (listed)" value={formatSats(revenue)} />
        <Stat label="Pending invoices" value={pending ?? '—'} tone="warn" />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={(t) => navigate(`/payments?tab=${t}`, { replace: true })}
        tabs={[
          { id: 'plans', label: 'Plans' },
          { id: 'invoices', label: 'Invoices' },
          { id: 'paid', label: 'Paid pubkeys' },
          { id: 'wallet', label: 'Wallet (NWC)' },
        ]}
      />
      <div class="pt-4">
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
                      render: (i) => <Mono>{shortNpub(i.pubkey)}</Mono>,
                    },
                    { key: 'plan', label: 'Plan', render: (i) => i.planId },
                    { key: 'amt', label: 'Amount', render: (i) => formatSats(i.amountSats) },
                    {
                      key: 'st',
                      label: 'Status',
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
      actions={
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          New plan
        </Button>
      }
    >
      <Async res={res} emptyTitle="No plans. Writes are free.">
        {(plans) => (
          <ul class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plans.map((p) => (
              <li key={p.id} class="rounded-md border border-line p-3">
                <div class="flex items-center justify-between">
                  <span class="font-medium">{p.name}</span>
                  <Badge tone={p.active ? 'ok' : 'muted'}>{p.active ? 'active' : 'inactive'}</Badge>
                </div>
                <div class="text-xl font-semibold text-teal mt-1">{formatSats(p.priceSats)}</div>
                <div class="text-xs text-muted">per {p.periodDays} days</div>
                {p.description && <p class="text-sm text-muted mt-2">{p.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New plan"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!valid} onClick={create}>
              Continue
            </Button>
          </>
        }
      >
        <div class="space-y-3">
          <Field label="Name">
            <Input value={form.name} onValue={(v) => setForm({ ...form, name: v })} />
          </Field>
          <div class="grid grid-cols-2 gap-3">
            <Field label="Price (sats)">
              <Input
                type="number"
                min={0}
                value={form.priceSats}
                onValue={(v) => setForm({ ...form, priceSats: v })}
              />
            </Field>
            <Field label="Period (days)">
              <Input
                type="number"
                min={1}
                value={form.periodDays}
                onValue={(v) => setForm({ ...form, periodDays: v })}
              />
            </Field>
          </div>
          <Field label="Description">
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
              { key: 'since', label: 'Since', render: (p) => formatAgo(p.since) },
              {
                key: 'exp',
                label: 'Expires',
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
        <div class="grid md:grid-cols-2 gap-4">
          <Card title="Nostr Wallet Connect">
            <div class="flex items-center gap-2 mb-3">
              <Badge tone={nwc.connected ? 'ok' : 'danger'}>
                {nwc.connected ? 'connected' : 'disconnected'}
              </Badge>
              {nwc.balanceSats != null && (
                <span class="text-sm text-muted">{formatSats(nwc.balanceSats)}</span>
              )}
            </div>
            <dl class="text-sm space-y-1 mb-4">
              {nwc.walletPubkey && (
                <div>
                  <dt class="text-xs text-muted inline">Wallet </dt>
                  <dd class="inline">
                    <Mono>{shortHex(nwc.walletPubkey, 12, 6)}</Mono>
                  </dd>
                </div>
              )}
              {nwc.relay && (
                <div>
                  <dt class="text-xs text-muted inline">Relay </dt>
                  <dd class="inline">
                    <Mono>{nwc.relay}</Mono>
                  </dd>
                </div>
              )}
            </dl>
            <Field
              label="Connection URI"
              hint="nostr+walletconnect://… from Alby Hub, Mutiny, etc. Stored encrypted."
            >
              <Input
                value={uri}
                onValue={setUri}
                type="password"
                autoComplete="off"
                placeholder="nostr+walletconnect://"
              />
            </Field>
            <div class="flex gap-2 mt-3 flex-wrap">
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
          <Card title="Lightning address / LNURL">
            <p class="text-sm text-muted mb-3">
              Current: <Mono>{nwc.lnurl ?? 'not set'}</Mono>
            </p>
            <Field label="LNURL or lightning address">
              <Input value={lnurl} onValue={setLnurl} placeholder="pay@relay.example.com" />
            </Field>
            <Button
              class="mt-3"
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
