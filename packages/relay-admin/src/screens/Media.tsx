/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
import { Async, useResource } from '../components/Async'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Link,
  Mono,
  PageHeader,
  ProgressBar,
  Select,
  Stat,
} from '../components/ui'
import { api, isMock } from '../ctx'
import { formatAgo, formatBytes, parsePubkey, percent, shortHex, shortNpub } from '../format'
import { performWrite } from '../store'
import type { MediaBlob } from '../types'

export function Media() {
  const apps = useResource(() => api.apps.list(), [])
  const [app, setApp] = useState('')
  const [pubkey, setPubkey] = useState('')
  const [pkErr, setPkErr] = useState<string | null>(null)
  const [query, setQuery] = useState<{ app?: string; pubkey?: string }>({})
  const blobs = useResource(() => api.media.blobs(query), [query.app, query.pubkey])

  const apply = (e: Event) => {
    e.preventDefault()
    try {
      setQuery({
        ...(app ? { app } : {}),
        ...(pubkey.trim() ? { pubkey: parsePubkey(pubkey) } : {}),
      })
      setPkErr(null)
    } catch (err) {
      setPkErr((err as Error).message)
    }
  }

  const del = async (b: MediaBlob) => {
    const r = await performWrite({
      title: 'Delete blob',
      action: 'Delete blob',
      danger: true,
      scope: [
        `sha256 ${shortHex(b.sha256, 16, 6)} (${b.type}, ${formatBytes(b.size)})`,
        `Owner ${shortNpub(b.pubkey)}${b.app ? `, app ${b.app}` : ''}`,
        'GET /<sha256> returns 404 afterwards; mirrors elsewhere are unaffected',
      ],
      run: () => api.media.remove(b.sha256),
      success: 'Blob deleted',
    })
    if (r.ok) blobs.mutate((l) => l.filter((x) => x.sha256 !== b.sha256))
  }

  const appName = (id?: string) => apps.data?.find((a) => a.id === id)?.name ?? id ?? '—'
  const total = blobs.data?.reduce((s, b) => s + b.size, 0) ?? 0
  const byType = new Map<string, number>()
  for (const b of blobs.data ?? [])
    byType.set(
      b.type.split('/')[0] ?? 'other',
      (byType.get(b.type.split('/')[0] ?? 'other') ?? 0) + b.size,
    )

  return (
    <>
      <PageHeader title="Media" subtitle="Blossom blobs by app and pubkey" />
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Blobs (listed)" value={blobs.data?.length ?? '—'} />
        <Stat label="Size (listed)" value={formatBytes(total)} tone="violet" />
        {[...byType.entries()].slice(0, 2).map(([t, s]) => (
          <Stat key={t} label={t} value={formatBytes(s)} tone="ok" />
        ))}
      </div>
      <Card class="mb-4">
        <form onSubmit={apply} class="grid gap-3 pt-3 sm:grid-cols-[1fr_1fr_auto] items-end">
          <Field label="App">
            <Select
              value={app}
              onValue={setApp}
              options={[
                { value: '', label: 'All apps' },
                ...(apps.data ?? []).map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </Field>
          <Field label="Pubkey" error={pkErr}>
            <Input value={pubkey} onValue={setPubkey} placeholder="npub1… or hex" />
          </Field>
          <Button type="submit" variant="primary">
            Filter
          </Button>
        </form>
      </Card>
      <Card title="Blobs" class="mb-4">
        <Async res={blobs} emptyTitle="No blobs for this filter">
          {(list) => (
            <ul class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {list.map((b) => (
                <li
                  key={b.sha256}
                  class="rounded-md border border-line bg-midnight/40 overflow-hidden flex flex-col"
                >
                  <div class="aspect-video bg-raised flex items-center justify-center text-muted text-xs relative">
                    {b.type.startsWith('image/') && !isMock ? (
                      <img
                        src={b.url ?? `/${b.sha256}`}
                        alt=""
                        loading="lazy"
                        class="absolute inset-0 size-full object-cover"
                        onError={(e) =>
                          ((e.currentTarget as HTMLImageElement).style.display = 'none')
                        }
                      />
                    ) : null}
                    <span>{b.type}</span>
                  </div>
                  <div class="p-2 text-xs space-y-1 flex-1">
                    <Mono class="block truncate">{shortHex(b.sha256, 10, 4)}</Mono>
                    <div class="flex justify-between text-muted">
                      <span>{formatBytes(b.size)}</span>
                      <span>{formatAgo(b.uploaded)}</span>
                    </div>
                    <div class="truncate text-muted">
                      {b.app ? appName(b.app) : <Badge>no app</Badge>}
                    </div>
                  </div>
                  <div class="p-2 pt-0">
                    <Button size="sm" variant="danger" class="w-full" onClick={() => del(b)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      <Card title="Storage quotas per app">
        <Async res={apps} emptyTitle="No apps">
          {(list) => (
            <ul class="space-y-3">
              {list.map((a) => {
                const used = a.usage?.blobsBytes ?? 0
                const max = a.quotas.maxStorageBytes ?? 0
                return (
                  <li key={a.id}>
                    <div class="flex justify-between text-sm mb-1">
                      <Link to={`/apps/${a.id}?tab=quotas`} class="hover:text-teal">
                        {a.name}
                      </Link>
                      <span class="text-muted text-xs">
                        {formatBytes(used)} / {max ? formatBytes(max) : 'unlimited'}
                        {a.quotas.maxBlobBytes
                          ? ` · max blob ${formatBytes(a.quotas.maxBlobBytes)}`
                          : ''}
                      </span>
                    </div>
                    <ProgressBar value={max ? percent(used, max) : 0} />
                  </li>
                )
              })}
            </ul>
          )}
        </Async>
      </Card>
    </>
  )
}
