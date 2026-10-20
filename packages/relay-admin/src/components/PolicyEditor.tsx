/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import { api } from '../ctx'
import { formatDuration, formatKinds, parseKinds, parsePubkey, shortNpub } from '../format'
import { performWrite } from '../store'
import type { Policy, RetentionRule } from '../types'
import { GLOBAL_REALM } from '../types'
import { Async, useResource } from './Async'
import { Badge, Button, Card, Field, Input } from './ui'

export function realmLabel(realm: string): string {
  return realm === GLOBAL_REALM ? 'the public relay (_global)' : `app realm ${realm}`
}

/** Describe what changed between two policies, for the confirmation scope. */
export function diffPolicy(a: Policy, b: Policy): string[] {
  const out: string[] = []
  const list = (
    name: string,
    x: (string | number)[],
    y: (string | number)[],
    fmt = (v: string | number) => String(v),
  ) => {
    const add = y.filter((v) => !x.includes(v))
    const rm = x.filter((v) => !y.includes(v))
    if (add.length) out.push(`${name}: add ${add.map(fmt).join(', ')}`)
    if (rm.length) out.push(`${name}: remove ${rm.map(fmt).join(', ')}`)
  }
  const pk = (v: string | number) => shortNpub(String(v))
  list('Allowed pubkeys', a.pubkeys.allow, b.pubkeys.allow, pk)
  list('Denied pubkeys', a.pubkeys.deny, b.pubkeys.deny, pk)
  list('Allowed kinds', a.kinds.allow, b.kinds.allow)
  list('Denied kinds', a.kinds.deny, b.kinds.deny)
  list('AUTH-required kinds', a.authRequiredKinds, b.authRequiredKinds)
  const rl = (r: Policy['rateLimits']['perIp']) =>
    r.events ? `${r.events}/${r.windowSec}s` : 'unlimited'
  if (rl(a.rateLimits.perIp) !== rl(b.rateLimits.perIp))
    out.push(`Per-IP rate limit: ${rl(a.rateLimits.perIp)} → ${rl(b.rateLimits.perIp)}`)
  if (rl(a.rateLimits.perPubkey) !== rl(b.rateLimits.perPubkey))
    out.push(`Per-pubkey rate limit: ${rl(a.rateLimits.perPubkey)} → ${rl(b.rateLimits.perPubkey)}`)
  if (a.maxEventSize !== b.maxEventSize)
    out.push(`Max event size: ${a.maxEventSize} → ${b.maxEventSize} bytes`)
  if (a.minPow !== b.minPow) out.push(`NIP-13 min PoW: ${a.minPow} → ${b.minPow} bits`)
  if (JSON.stringify(a.retention) !== JSON.stringify(b.retention))
    out.push(
      `Retention rules: ${a.retention.length} → ${b.retention.length} rules (${b.retention.map(retentionLabel).join('; ') || 'keep everything'})`,
    )
  return out
}

export function retentionLabel(r: RetentionRule): string {
  const parts = []
  if (r.maxAgeSec) parts.push(`max age ${formatDuration(r.maxAgeSec)}`)
  if (r.maxCount) parts.push(`keep ${r.maxCount}/pubkey`)
  return `kinds ${formatKinds(r.kinds)}: ${parts.join(', ') || 'forever'}`
}

function ListEditor({
  label,
  items,
  onChange,
  parse,
  render,
  placeholder,
}: {
  label: string
  items: string[]
  onChange: (v: string[]) => void
  parse: (s: string) => string
  render?: (s: string) => string
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = () => {
    try {
      const v = parse(draft)
      if (!items.includes(v)) onChange([...items, v])
      setDraft('')
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <Field label={label} error={err}>
      <div class="flex gap-2">
        <Input
          value={draft}
          onValue={setDraft}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {items.length > 0 && (
        <div class="flex flex-wrap gap-1.5 mt-2">
          {items.map((i) => (
            <span
              key={i}
              class="inline-flex items-center gap-1 rounded-full bg-raised border border-line pl-2.5 pr-1 py-0.5 text-xs font-mono"
            >
              {render ? render(i) : i}
              <button
                type="button"
                class="px-1 text-muted hover:text-danger"
                aria-label={`Remove ${i}`}
                onClick={() => onChange(items.filter((x) => x !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Field>
  )
}

function KindsInput({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: number[]
  onChange: (v: number[]) => void
  hint?: string
}) {
  const [text, setText] = useState(formatKinds(value))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setText(formatKinds(value)), [value.join(',')])
  return (
    <Field label={label} hint={hint ?? 'Comma separated, ranges like 30000-30010'} error={err}>
      <Input
        value={text}
        onValue={setText}
        onBlur={() => {
          try {
            onChange(parseKinds(text))
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        inputMode="numeric"
      />
    </Field>
  )
}

function NumberInput({
  label,
  value,
  onChange,
  hint,
  min = 0,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  hint?: string
  min?: number
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        value={String(value)}
        onValue={(v) => onChange(Math.max(min, Number(v) || 0))}
        inputMode="numeric"
      />
    </Field>
  )
}

export function PolicyEditor({
  realm = GLOBAL_REALM,
  section = 'rules',
}: {
  realm?: string
  section?: 'rules' | 'retention'
}) {
  const res = useResource(() => api.policies.get(realm), [realm])
  return (
    <Async res={res}>
      {(saved) => (
        <PolicyForm
          key={realm}
          realm={realm}
          saved={saved}
          section={section}
          onSaved={() => void res.reload()}
        />
      )}
    </Async>
  )
}

function PolicyForm({
  realm,
  saved,
  section,
  onSaved,
}: {
  realm: string
  saved: Policy
  section: 'rules' | 'retention'
  onSaved: () => void
}) {
  const [p, setP] = useState<Policy>(saved)
  useEffect(() => setP(saved), [saved])
  const changes = diffPolicy(saved, p)
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP({ ...p, [k]: v })

  const save = async () => {
    const r = await performWrite({
      title: 'Save relay policy',
      action: 'Save policy',
      scope: [
        `Applies to ${realmLabel(realm)}`,
        ...changes,
        'Hot-reloaded: takes effect for new events immediately',
      ],
      run: () => api.policies.put(realm, p),
      success: 'Policy saved',
    })
    if (r.ok) onSaved()
  }

  const footer = (
    <div class="flex items-center justify-between gap-2 sticky bottom-20 md:bottom-0 bg-surface/95 backdrop-blur py-3 -mx-4 px-4 border-t border-line mt-4">
      <span class="text-xs text-muted">
        {changes.length
          ? `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}`
          : 'No changes'}
      </span>
      <div class="flex gap-2">
        <Button variant="ghost" disabled={!changes.length} onClick={() => setP(saved)}>
          Reset
        </Button>
        <Button variant="primary" disabled={!changes.length} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )

  if (section === 'retention') {
    return (
      <Card title={`Retention · ${realmLabel(realm)}`}>
        <p class="text-sm text-muted mb-3">
          Events matching a rule are pruned by the nightly job. Kinds without a rule are kept
          forever.
        </p>
        <div class="space-y-3">
          {p.retention.map((r, i) => (
            <div
              key={i}
              class="rounded-md border border-line p-3 grid sm:grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end"
            >
              <KindsInput
                label="Kinds"
                value={r.kinds}
                onChange={(k) =>
                  set(
                    'retention',
                    p.retention.map((x, j) => (j === i ? { ...x, kinds: k } : x)),
                  )
                }
              />
              <NumberInput
                label="Max age (days)"
                value={Math.round(((r.maxAgeSec ?? 0) / 86400) * 1000) / 1000}
                onChange={(d) =>
                  set(
                    'retention',
                    p.retention.map((x, j) =>
                      j === i ? { ...x, maxAgeSec: Math.round(d * 86400) } : x,
                    ),
                  )
                }
                hint="0 = no age limit"
              />
              <NumberInput
                label="Max per pubkey"
                value={r.maxCount ?? 0}
                onChange={(n) =>
                  set(
                    'retention',
                    p.retention.map((x, j) => (j === i ? { ...x, maxCount: n || undefined } : x)),
                  )
                }
                hint="0 = unlimited"
              />
              <Button
                variant="danger"
                onClick={() =>
                  set(
                    'retention',
                    p.retention.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            onClick={() =>
              set('retention', [...p.retention, { kinds: [1], maxAgeSec: 30 * 86400 }])
            }
          >
            Add rule
          </Button>
        </div>
        {footer}
      </Card>
    )
  }

  return (
    <Card title={`Policy · ${realmLabel(realm)}`}>
      <div class="grid md:grid-cols-2 gap-4">
        <ListEditor
          label="Allowed pubkeys (empty = everyone)"
          items={p.pubkeys.allow}
          onChange={(v) => set('pubkeys', { ...p.pubkeys, allow: v })}
          parse={parsePubkey}
          render={shortNpub}
          placeholder="npub1… or hex"
        />
        <ListEditor
          label="Denied pubkeys"
          items={p.pubkeys.deny}
          onChange={(v) => set('pubkeys', { ...p.pubkeys, deny: v })}
          parse={parsePubkey}
          render={shortNpub}
          placeholder="npub1… or hex"
        />
        <KindsInput
          label="Allowed kinds (empty = all)"
          value={p.kinds.allow}
          onChange={(v) => set('kinds', { ...p.kinds, allow: v })}
        />
        <KindsInput
          label="Denied kinds"
          value={p.kinds.deny}
          onChange={(v) => set('kinds', { ...p.kinds, deny: v })}
        />
        <KindsInput
          label="Require NIP-42 AUTH for kinds"
          value={p.authRequiredKinds}
          onChange={(v) => set('authRequiredKinds', v)}
          hint="e.g. 20100, 20101 for private realms"
        />
        <div class="grid grid-cols-2 gap-3">
          <NumberInput
            label="Max event size (bytes)"
            value={p.maxEventSize}
            onChange={(v) => set('maxEventSize', v)}
            min={256}
          />
          <NumberInput
            label="NIP-13 min PoW (bits)"
            value={p.minPow}
            onChange={(v) => set('minPow', Math.min(v, 40))}
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <NumberInput
            label="Per-IP events"
            value={p.rateLimits.perIp.events}
            onChange={(v) =>
              set('rateLimits', { ...p.rateLimits, perIp: { ...p.rateLimits.perIp, events: v } })
            }
            hint="0 = unlimited"
          />
          <NumberInput
            label="Per-IP window (s)"
            value={p.rateLimits.perIp.windowSec}
            onChange={(v) =>
              set('rateLimits', { ...p.rateLimits, perIp: { ...p.rateLimits.perIp, windowSec: v } })
            }
            min={1}
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <NumberInput
            label="Per-pubkey events"
            value={p.rateLimits.perPubkey.events}
            onChange={(v) =>
              set('rateLimits', {
                ...p.rateLimits,
                perPubkey: { ...p.rateLimits.perPubkey, events: v },
              })
            }
            hint="0 = unlimited"
          />
          <NumberInput
            label="Per-pubkey window (s)"
            value={p.rateLimits.perPubkey.windowSec}
            onChange={(v) =>
              set('rateLimits', {
                ...p.rateLimits,
                perPubkey: { ...p.rateLimits.perPubkey, windowSec: v },
              })
            }
            min={1}
          />
        </div>
      </div>
      {p.retention.length > 0 && (
        <div class="mt-4 flex flex-wrap gap-1.5">
          {p.retention.map((r, i) => (
            <Badge key={i} tone="violet">
              {retentionLabel(r)}
            </Badge>
          ))}
        </div>
      )}
      {footer}
    </Card>
  )
}
