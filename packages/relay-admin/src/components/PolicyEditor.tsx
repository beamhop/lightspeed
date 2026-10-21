import { useEffect, useState } from 'react'
import { api } from '../ctx'
import { formatDuration, formatKinds, parseKinds, parsePubkey, shortNpub } from '../format'
import { diffPolicy, realmLabel, retentionLabel } from '../policy'
import { performWrite } from '../store'
import type { Policy, RetentionRule } from '../types'
import { GLOBAL_REALM } from '../types'
import { Async, useResource } from './Async'
import { Badge, Button, Card, Field, Input } from './ui'

export { diffPolicy, realmLabel, retentionLabel }

function ListEditor({
  label,
  items,
  onChange,
  parse,
  render,
  placeholder,
  help,
  hint,
}: {
  label: string
  help?: string
  hint?: string
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
    <Field label={label} error={err} help={help} hint={hint}>
      <div className="flex gap-2">
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
        <div className="flex flex-wrap gap-1.5 mt-2">
          {items.map((i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full bg-muted border border-border pl-2.5 pr-1 py-0.5 text-xs font-mono"
            >
              {render ? render(i) : i}
              <button
                type="button"
                className="px-1 text-muted-foreground hover:text-destructive"
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
  help,
}: {
  label: string
  value: number[]
  onChange: (v: number[]) => void
  hint?: string
  help?: string
}) {
  const [text, setText] = useState(formatKinds(value))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setText(formatKinds(value)), [value.join(',')])
  return (
    <Field
      label={label}
      hint={hint ?? 'Comma separated, ranges like 30000-30010'}
      help={help}
      error={err}
    >
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
  help,
  min = 0,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  hint?: string
  help?: string
  min?: number
}) {
  return (
    <Field label={label} hint={hint} help={help}>
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
    <div className="flex items-center justify-between gap-2 sticky bottom-20 md:bottom-0 bg-card/95 backdrop-blur py-3 -mx-4 px-4 border-t border-border mt-4">
      <span className="text-xs text-muted-foreground">
        {changes.length
          ? `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}`
          : 'No changes'}
      </span>
      <div className="flex gap-2">
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
      <Card
        title={`Retention · ${realmLabel(realm)}`}
        description="Each rule targets some event kinds and limits how long or how many of them are kept. The nightly job deletes events that break a rule; kinds without a rule are kept forever. Example: kinds 7 (reactions) with max age 30 days."
      >
        <div className="space-y-4">
          {p.retention.map((r, i) => (
            <div
              key={i}
              className="rounded-md border border-border p-3 grid sm:grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end"
            >
              <KindsInput
                label="Kinds"
                help="Which event kinds this rule applies to, e.g. 1 for notes, 7 for reactions, 20000-29999 for ephemeral kinds."
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
                help="Delete matching events older than this many days. Decimals work (0.5 = 12 hours)."
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
                help="Keep only the newest N matching events per author; older ones are deleted. Handy for capping chatty kinds without an age limit."
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
    <Card
      title={`Policy · ${realmLabel(realm)}`}
      description="Every incoming event is checked against these rules before it is stored; rejected events get an error message back. Deny lists win over allow lists. Leave a list empty to not restrict on it."
    >
      <div className="grid md:grid-cols-2 gap-4">
        <ListEditor
          label="Allowed pubkeys (empty = everyone)"
          help="If you add any pubkey here, only these authors can publish. Use it for a private or team relay. Press Enter or Add after each key."
          items={p.pubkeys.allow}
          onChange={(v) => set('pubkeys', { ...p.pubkeys, allow: v })}
          parse={parsePubkey}
          render={shortNpub}
          placeholder="npub1… or hex"
        />
        <ListEditor
          label="Denied pubkeys"
          help="Authors whose events are always rejected, e.g. known spammers. Their already-stored events stay until you delete them in Events."
          items={p.pubkeys.deny}
          onChange={(v) => set('pubkeys', { ...p.pubkeys, deny: v })}
          parse={parsePubkey}
          render={shortNpub}
          placeholder="npub1… or hex"
        />
        <KindsInput
          label="Allowed kinds (empty = all)"
          help="If set, only these event kinds are accepted. Useful for a single-purpose relay, e.g. only Beamhop signalling (20100, 20101)."
          value={p.kinds.allow}
          onChange={(v) => set('kinds', { ...p.kinds, allow: v })}
        />
        <KindsInput
          label="Denied kinds"
          help="Event kinds that are always rejected, e.g. 4 (legacy DMs) or 1984 (reports) if you do not want to store them."
          value={p.kinds.deny}
          onChange={(v) => set('kinds', { ...p.kinds, deny: v })}
        />
        <KindsInput
          label="Require NIP-42 AUTH for kinds"
          value={p.authRequiredKinds}
          onChange={(v) => set('authRequiredKinds', v)}
          hint="e.g. 20100, 20101 for private realms"
          help="Clients must prove who they are with NIP-42 AUTH before publishing or reading these kinds. Combine with Allowed pubkeys to keep a realm private."
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Max event size (bytes)"
            value={p.maxEventSize}
            onChange={(v) => set('maxEventSize', v)}
            help="Events larger than this (in bytes of JSON) are rejected. Protects against huge payloads; 64 KB fits almost every normal event."
            min={256}
          />
          <NumberInput
            label="NIP-13 min PoW (bits)"
            value={p.minPow}
            onChange={(v) => set('minPow', Math.min(v, 40))}
            help="Require NIP-13 proof of work: the event ID must start with this many zero bits. Each extra bit doubles the work a sender must do. 0 disables it; 16–20 slows spam without bothering humans."
            hint="0 = off, max 40"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Per-IP events"
            help="How many events one IP address may publish per window. Stops a single machine from flooding the relay."
            value={p.rateLimits.perIp.events}
            onChange={(v) =>
              set('rateLimits', { ...p.rateLimits, perIp: { ...p.rateLimits.perIp, events: v } })
            }
            hint="0 = unlimited"
          />
          <NumberInput
            label="Per-IP window (s)"
            help="Length of the rate-limit window in seconds. 30 events per 60 s allows bursts but caps the average at one event every 2 s."
            value={p.rateLimits.perIp.windowSec}
            onChange={(v) =>
              set('rateLimits', { ...p.rateLimits, perIp: { ...p.rateLimits.perIp, windowSec: v } })
            }
            min={1}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Per-pubkey events"
            help="How many events one author (pubkey) may publish per window, regardless of IP. Catches spammers that rotate IP addresses."
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
            help="Length of the per-pubkey rate-limit window in seconds."
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
        <div className="mt-4 flex flex-wrap gap-1.5">
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
