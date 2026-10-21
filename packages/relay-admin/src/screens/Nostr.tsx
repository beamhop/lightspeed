/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import { MascotMessage } from '../components/Mascot'
import { PolicyEditor } from '../components/PolicyEditor'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Mono,
  PageHeader,
  Tabs,
  TextArea,
} from '../components/ui'
import { api } from '../ctx'
import {
  formatAgo,
  formatBytes,
  formatDate,
  formatKinds,
  parseKinds,
  parsePubkey,
  shortHex,
  shortNpub,
} from '../format'
import { PAGE_HELP } from '../help'
import { currentQuery, navigate } from '../router'
import { errorMessage, performWrite } from '../store'
import type { EventQuery, Nip11Info, NostrEvent } from '../types'
import { GLOBAL_REALM } from '../types'

type Tab = 'events' | 'subs' | 'policy' | 'nip11' | 'retention' | 'backup'

const TABS: { id: Tab; label: string; description: string }[] = [
  {
    id: 'events',
    label: 'Events',
    description:
      'Browse what is stored in the relay database, newest first. Combine filters to find spam or a specific post, open the raw JSON, or delete an event.',
  },
  {
    id: 'subs',
    label: 'Live subscriptions',
    description:
      'Every open REQ right now: which client asked, in which realm, with what filters and how many events it has received. Useful for finding scrapers and clients that subscribe far more than they should.',
  },
  {
    id: 'policy',
    label: 'Policy',
    description:
      'Rules for events published to the public relay (wss://<host>/). Changes take effect for new events immediately; events already stored are not re-checked. App realms have their own policy under Apps → Policy.',
  },
  {
    id: 'nip11',
    label: 'NIP-11',
    description:
      'The relay information document clients fetch to learn your relay’s name, contact, supported NIPs and limits. It is public and also shown in relay directories.',
  },
  {
    id: 'retention',
    label: 'Retention',
    description:
      'How long the public relay keeps events. Use it to stop the database from growing forever, for example by expiring old reactions while keeping profiles.',
  },
  {
    id: 'backup',
    label: 'Backup',
    description:
      'Consistent snapshots of the relay databases. Run one before upgrades or risky policy changes; nightly backups are configured in Settings.',
  },
]

export function Nostr() {
  const tab = (currentQuery.value.get('tab') as Tab) || 'events'
  return (
    <>
      <PageHeader
        title="Nostr relay"
        subtitle="Events, subscriptions and relay policy"
        intro={PAGE_HELP.nostr}
      />
      <Tabs<Tab>
        value={tab}
        tabs={TABS}
        onChange={(t) => navigate(`/nostr?tab=${t}`, { replace: true })}
      />
      <div class="pt-4">
        {tab === 'events' && <EventExplorer />}
        {tab === 'subs' && <Subscriptions />}
        {tab === 'policy' && <PolicyEditor realm={GLOBAL_REALM} />}
        {tab === 'nip11' && <Nip11Editor />}
        {tab === 'retention' && <PolicyEditor realm={GLOBAL_REALM} section="retention" />}
        {tab === 'backup' && <Backups />}
      </div>
    </>
  )
}

const KIND_NAMES: Record<number, string> = {
  0: 'metadata',
  1: 'note',
  3: 'contacts',
  4: 'DM',
  5: 'deletion',
  7: 'reaction',
  1984: 'report',
  9735: 'zap',
  10002: 'relay list',
  20100: 'beamhop announce',
  20101: 'beamhop signal',
  24133: 'nip-46',
  27235: 'http auth',
  30023: 'article',
}

export function kindLabel(k: number): string {
  return KIND_NAMES[k] ? `${k} · ${KIND_NAMES[k]}` : String(k)
}

/** Build the API query from the filter form; throws with a friendly message on bad input. */
export function buildEventQuery(
  f: { kinds: string; author: string; tag: string; search: string; realm: string },
  limit = 50,
): EventQuery {
  const q: EventQuery = { limit }
  const kinds = f.kinds.trim() ? parseKinds(f.kinds) : []
  if (kinds.length) q.kind = kinds
  if (f.author.trim()) q.author = parsePubkey(f.author)
  if (f.tag.trim()) {
    const m = /^#?([a-zA-Z])[:=](.+)$/.exec(f.tag.trim())
    if (!m) throw new Error('Tag filter looks like t:bitcoin or p:<hex>')
    q.tag = `${m[1]}:${m[2]}`
  }
  if (f.search.trim()) q.search = f.search.trim()
  if (f.realm.trim()) q.realm = f.realm.trim()
  return q
}

function EventExplorer() {
  const [form, setForm] = useState({ kinds: '', author: '', tag: '', search: '', realm: '' })
  const [query, setQuery] = useState<EventQuery>({ limit: 50 })
  const [formErr, setFormErr] = useState<string | null>(null)
  const [events, setEvents] = useState<NostrEvent[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  const load = async (q: EventQuery, append: boolean) => {
    setLoading(true)
    try {
      const list = await api.nostr.events(q)
      setEvents((prev) => (append && prev ? [...prev, ...list] : list))
      setMore(list.length >= (q.limit ?? 50))
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => void load(query, false), [query])

  const submit = (e: Event) => {
    e.preventDefault()
    try {
      setQuery(buildEventQuery(form))
      setFormErr(null)
    } catch (err) {
      setFormErr((err as Error).message)
    }
  }
  const upd = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v })

  const del = async (ev: NostrEvent) => {
    const r = await performWrite({
      title: 'Delete event',
      action: 'Delete event',
      danger: true,
      scope: [
        `Event ${shortHex(ev.id, 12, 6)} (kind ${kindLabel(ev.kind)})`,
        `Author ${shortNpub(ev.pubkey)}`,
        'Removed from the database for every realm; clients that already have it keep their copy',
      ],
      run: () => api.nostr.deleteEvent(ev.id),
      success: 'Event deleted',
    })
    if (r.ok) setEvents((list) => list?.filter((x) => x.id !== ev.id) ?? null)
  }

  return (
    <>
      <Card class="mb-4">
        <form onSubmit={submit} class="grid gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-5 items-end">
          <Field
            label="Search (NIP-50)"
            help="Full-text search over event content using NIP-50. Matches words, not exact substrings."
          >
            <Input
              value={form.search}
              onValue={upd('search')}
              placeholder="full-text"
              type="search"
            />
          </Field>
          <Field
            label="Kinds"
            help="Event kinds are numbers that say what an event is: 0 profile, 1 note, 3 follows, 7 reaction, 30023 article. Separate with commas or use ranges like 30000-30010."
          >
            <Input
              value={form.kinds}
              onValue={upd('kinds')}
              placeholder="1, 7, 30023"
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Author"
            help="Only show events signed by this pubkey. Paste an npub or 64-character hex key."
          >
            <Input value={form.author} onValue={upd('author')} placeholder="npub1… or hex" />
          </Field>
          <Field
            label="Tag"
            help="Match a single-letter tag as letter:value, e.g. t:nostr for a hashtag, p:<hex> for mentions of a pubkey, e:<id> for replies to an event."
          >
            <Input value={form.tag} onValue={upd('tag')} placeholder="t:nostr" />
          </Field>
          <div class="flex gap-2">
            <Button type="submit" variant="primary" class="flex-1" loading={loading}>
              Filter
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm({ kinds: '', author: '', tag: '', search: '', realm: '' })
                setQuery({ limit: 50 })
              }}
            >
              Clear
            </Button>
          </div>
        </form>
        {formErr && <p class="text-sm text-danger mt-2">{formErr}</p>}
      </Card>
      {error && !events ? (
        <MascotMessage state="angry" title="Could not query events">
          {errorMessage(error)}
        </MascotMessage>
      ) : events === null ? (
        <MascotMessage state="spinner" title="Querying the relay…" compact />
      ) : events.length === 0 ? (
        <MascotMessage state="smile" title="No events match these filters" compact />
      ) : (
        <ul class="space-y-2">
          {events.map((ev) => (
            <li key={ev.id} class="rounded-md border border-line bg-surface p-3">
              <div class="flex items-center gap-2 flex-wrap text-xs">
                <Badge tone="violet">{kindLabel(ev.kind)}</Badge>
                <Mono class="text-muted">{shortNpub(ev.pubkey)}</Mono>
                <span class="text-muted" title={formatDate(ev.created_at)}>
                  {formatAgo(ev.created_at)}
                </span>
                <span class="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(open === ev.id ? null : ev.id)}
                  >
                    {open === ev.id ? 'Hide' : 'JSON'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => del(ev)}>
                    Delete
                  </Button>
                </span>
              </div>
              <p class="mt-1.5 text-sm break-words line-clamp-3">
                {ev.content || <span class="text-muted italic">(empty)</span>}
              </p>
              {ev.tags.length > 0 && (
                <div class="mt-1.5 flex flex-wrap gap-1">
                  {ev.tags.slice(0, 6).map((t, i) => (
                    <Mono key={i} class="rounded bg-raised px-1.5 py-0.5 text-muted">
                      {t[0]}:{shortHex(t[1] ?? '', 10, 4)}
                    </Mono>
                  ))}
                </div>
              )}
              {open === ev.id && (
                <pre class="mt-2 max-h-72 overflow-auto rounded bg-midnight p-2 text-[11px] font-mono text-muted">
                  {JSON.stringify(ev, null, 2)}
                </pre>
              )}
            </li>
          ))}
          {more && (
            <li class="flex justify-center pt-2">
              <Button
                loading={loading}
                onClick={() => {
                  const last = events[events.length - 1]
                  if (last) void load({ ...query, until: last.created_at }, true)
                }}
              >
                Load older
              </Button>
            </li>
          )}
        </ul>
      )}
    </>
  )
}

function Subscriptions() {
  const res = useResource(() => api.nostr.subscriptions(), [], 5000)
  return (
    <Card
      title="Live subscriptions"
      description="Use “Ban IP…” to jump to TURN → IP bans with the client’s address filled in; bans apply to every listener, not only Nostr."
      actions={<span class="text-xs text-muted">refreshes every 5s</span>}
    >
      <Async res={res} emptyTitle="No open subscriptions">
        {(subs) => (
          <DataTable
            rows={subs}
            rowKey={(s) => s.id}
            columns={[
              {
                key: 'id',
                label: 'Sub',
                help: 'The subscription ID the client chose when it sent REQ.',
                render: (s) => <Mono>{shortHex(s.id, 10, 4)}</Mono>,
              },
              { key: 'ip', label: 'Client', render: (s) => <Mono>{s.ip}</Mono> },
              {
                key: 'realm',
                label: 'Realm',
                help: '“public” is the open relay at the root URL; otherwise the ID of the app realm the client connected to.',
                render: (s) =>
                  s.realm ? (
                    <Mono>{shortHex(s.realm, 8, 0)}</Mono>
                  ) : (
                    <Badge tone="teal">public</Badge>
                  ),
              },
              {
                key: 'filters',
                label: 'Filters',
                help: 'The NIP-01 filters the client asked for (kinds, authors, tags, since/until). Very broad filters on the public relay are a sign of scraping.',
                render: (s) => (
                  <Mono class="text-muted">{JSON.stringify(s.filters).slice(0, 60)}</Mono>
                ),
                hideOnMobile: true,
              },
              {
                key: 'sent',
                label: 'Sent',
                help: 'Events delivered to this subscription so far.',
                render: (s) => s.eventsSent.toLocaleString(),
              },
              { key: 'age', label: 'Age', render: (s) => formatAgo(s.createdAt) },
            ]}
            actions={(s) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigate(`/turn?ip=${encodeURIComponent(s.ip)}`)}
              >
                Ban IP…
              </Button>
            )}
          />
        )}
      </Async>
    </Card>
  )
}

function Nip11Editor() {
  const res = useResource(() => api.nip11.get(), [])
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (res.data) setText(JSON.stringify(res.data, null, 2))
  }, [res.data])
  const parsed = (() => {
    try {
      const v = JSON.parse(text) as Nip11Info
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null
      return v
    } catch {
      return null
    }
  })()
  return (
    <Async res={res}>
      {(info) => (
        <div class="grid lg:grid-cols-[1fr_320px] gap-4">
          <Card
            title="NIP-11 document (JSON)"
            description="Edit the JSON and Publish. Common fields: name, description, pubkey (operator’s key), contact, icon, supported_nips and limitation. Every app realm serves this document merged with its own details."
          >
            <TextArea
              value={text}
              onValue={setText}
              rows={22}
              spellcheck={false}
              aria-label="NIP-11 JSON"
            />
            {!parsed && <p class="text-xs text-danger mt-1">Invalid JSON object</p>}
            {err && <p class="text-xs text-danger mt-1">{err}</p>}
            <div class="flex justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={() => setText(JSON.stringify(info, null, 2))}>
                Reset
              </Button>
              <Button
                variant="primary"
                disabled={!parsed || JSON.stringify(parsed) === JSON.stringify(info)}
                onClick={async () => {
                  if (!parsed) return
                  const changed = Object.keys({ ...info, ...parsed }).filter(
                    (k) => JSON.stringify(info[k]) !== JSON.stringify(parsed[k]),
                  )
                  const r = await performWrite({
                    title: 'Publish NIP-11 document',
                    action: 'Publish',
                    scope: [
                      'Public relay info served at / with Accept: application/nostr+json',
                      'Merged into every app realm document',
                      `Changed fields: ${changed.join(', ') || 'none'}`,
                    ],
                    run: () => api.nip11.put(parsed),
                    success: 'NIP-11 updated',
                  })
                  if (r.ok) {
                    setErr(null)
                    void res.reload()
                  }
                }}
              >
                Publish
              </Button>
            </div>
          </Card>
          <Card
            title="Preview"
            description="Roughly how relay browsers and clients will show your relay."
          >
            {parsed ? (
              <div class="space-y-2 text-sm">
                <div class="font-semibold">{parsed.name ?? 'Unnamed relay'}</div>
                <p class="text-muted">{parsed.description}</p>
                {parsed.pubkey && <Mono class="text-muted block">{shortNpub(parsed.pubkey)}</Mono>}
                {parsed.contact && <div class="text-xs">{parsed.contact}</div>}
                <div class="flex flex-wrap gap-1 pt-1">
                  {(parsed.supported_nips ?? []).map((n) => (
                    <Badge key={n} tone="teal">
                      NIP-{String(n).padStart(2, '0')}
                    </Badge>
                  ))}
                </div>
                {parsed.supported_nips && (
                  <div class="text-[11px] text-muted">{formatKinds(parsed.supported_nips)}</div>
                )}
              </div>
            ) : (
              <MascotMessage compact state="angry" title="Fix the JSON to preview" />
            )}
          </Card>
        </div>
      )}
    </Async>
  )
}

function Backups() {
  const res = useResource(() => api.backups.list(), [])
  return (
    <Card
      title="Backups"
      description="Run backup takes a consistent snapshot of nostr.db (events) and admin.db (apps, policies, admins, payments) without stopping the relay. Media blobs are not part of these snapshots."
      actions={
        <Button
          variant="primary"
          onClick={async () => {
            const r = await performWrite({
              title: 'Run backup now',
              action: 'Run backup',
              scope: [
                'VACUUM INTO snapshot of nostr.db and admin.db',
                'Writes to the backup directory on the relay server',
                'May briefly raise disk I/O',
              ],
              run: () => api.backups.run(),
              success: 'Backup started',
            })
            if (r.ok) void res.reload()
          }}
        >
          Run backup
        </Button>
      }
    >
      <Async res={res} emptyTitle="No backups yet">
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(b) => b.id}
            columns={[
              { key: 'when', label: 'Created', render: (b) => formatDate(b.createdAt) },
              { key: 'size', label: 'Size', render: (b) => formatBytes(b.sizeBytes) },
              { key: 'files', label: 'Files', render: (b) => <Mono>{b.files.join(', ')}</Mono> },
              {
                key: 'status',
                label: 'Status',
                render: (b) => (
                  <Badge
                    tone={b.status === 'done' ? 'ok' : b.status === 'failed' ? 'danger' : 'warn'}
                  >
                    {b.status}
                  </Badge>
                ),
              },
            ]}
          />
        )}
      </Async>
      <p class="text-xs text-muted mt-3">
        Restore is an offline operation: stop the relay, run{' '}
        <Mono>beamhop relay restore &lt;backup-id&gt;</Mono>, then start it again.
      </p>
    </Card>
  )
}
