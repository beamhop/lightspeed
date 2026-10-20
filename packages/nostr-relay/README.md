# @beamhop/nostr-relay

Embeddable Nostr relay engine for Bun, stored in `bun:sqlite`. It brings no HTTP server of its own:
you pass its WebSocket handlers to your own `Bun.serve`, and it serves the public relay plus any
number of isolated **realms** (one per app) from one database.

License: AGPL-3.0-only.

## Supported NIPs

| NIP | What the engine does |
| --- | --- |
| 01 | Pipeline: parse → validate shape and id → policy → Schnorr verify (inline or Worker pool) → store → live matcher. Regular, replaceable (0, 3, 10000–19999), addressable (30000–39999 by `d`) and ephemeral (20000–29999, delivered but never stored) kinds. Handles `EVENT`, `REQ`, `CLOSE` and replies with `OK`, `EOSE`, `CLOSED`, `NOTICE`. Filters support `ids`, `authors`, `kinds`, `#<letter>`, `since`, `until` and `limit`. |
| 09 | Kind 5 deletions by `e` and `a` tag, from the author only. A deleted event cannot be published again. Deleting a deletion does nothing. |
| 11 | Info document merged in this order: base `info`, then `policy.info`, then NIP-86 overrides. `limitation` is filled in from the policy. CORS headers included. |
| 13 | `minPow` minimum difficulty. A `nonce` tag that commits to a target below the minimum is also rejected. |
| 40 | Expired events are rejected and hidden from queries, and the sweeper deletes them. |
| 42 | Challenge sent on connect. `authRequired` or `authRequiredKinds` trigger `auth-required:` replies. |
| 45 | `COUNT`. The union of several filters is counted without duplicates. |
| 50 | `search` on SQLite FTS5. `key:value` extensions are ignored, and words are quoted so FTS syntax is matched literally. |
| 70 | Events with a `["-"]` tag are accepted only from a connection authenticated as the event's author. |
| 77 | `NEG-OPEN`, `NEG-MSG`, `NEG-CLOSE` and `NEG-ERR`, using a TypeScript port of Negentropy v1 (exported for clients too). |
| 86 | Management RPC with NIP-98 auth (checks `u`, `method` and `payload`, and allows 60 s of clock skew). |

## Embedding

```ts
import { createNostrRelay, createPolicyStore } from '@beamhop/nostr-relay'

const policies = createPolicyStore({
  global: { rateLimits: { ip: { rate: 10, burst: 50 } }, maxEventBytes: 64 * 1024 },
  realmDefault: { kinds: { allow: [20100, 20101] }, authRequiredKinds: [] },
})

const relay = createNostrRelay({
  dbPath: '/data/nostr.db',
  info: { name: 'Beamhop relay', description: 'Public relay + app realms', contact: 'ops@example.com' },
  policy: policies,
  auth: { relayUrl: 'wss://relay.example.com' },
  admins: ['<hex pubkey of the operator>'],
  verifyWorkers: 2, // Schnorr verification on Worker threads (0 = inline)
})

Bun.serve({
  port: 443,
  fetch(req, server) {
    const url = new URL(req.url)
    const m = /^\/a\/([^/]+)$/.exec(url.pathname)
    const realm = m ? m[1]! : url.pathname === '/' ? null : undefined
    if (realm === undefined) return new Response('not found', { status: 404 })

    if (req.headers.get('upgrade') === 'websocket') {
      const ip = server.requestIP(req)?.address ?? ''
      return server.upgrade(req, { data: relay.socketData({ realm, ip }) })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    }
    if (req.headers.get('content-type')?.startsWith('application/nostr+json+rpc'))
      return relay.handleManagement(req, realm) // NIP-86
    if (req.headers.get('accept')?.includes('application/nostr+json'))
      return relay.handleInfo(req, realm) // NIP-11
    return new Response('nostr relay')
  },
  websocket: relay.websocket,
})

// Hot-swap a realm's rules (e.g. after an admin edit):
policies.set('app123', { pubkeys: { deny: ['<hex>'] }, minPow: 8 })

relay.onEvent((event, realm) => {/* metrics, webhooks, ... */})
setInterval(() => console.log(relay.stats()), 10_000)
relay.backup('/data/backups/nostr-2026-10-21.db') // VACUUM INTO
```

If the server also accepts non-Nostr WebSockets (such as the data relay), dispatch on
`ws.data.kind === 'nostr'` before calling these handlers.

## Policy

`PolicyProvider` is `{ get(realm: string | null): Policy }`. It is called on every message, so a
new policy takes effect immediately. A `Policy` is plain data (see `src/types.ts`):

- `pubkeys.allow` / `pubkeys.deny`. A non-empty allow list makes writes restricted.
- `kinds.allow` / `kinds.deny`
- `rateLimits.ip`, `rateLimits.pubkey` (EVENT) and `rateLimits.reqIp` (REQ/COUNT/NEG-OPEN). Each
  is a token bucket `{ rate, burst }`.
- `maxEventBytes`, `maxMessageBytes`, `maxEventTags`, `maxContentLength`, `maxFutureSeconds`
  (default 900), `maxPastSeconds`
- `minPow` (NIP-13), `authRequired`, `authRequiredKinds` (NIP-42, applies to both reading and
  writing those kinds)
- `retention: [{ kinds?, maxAgeSeconds?, maxCount? }]`, enforced by the sweeper
  (`sweepIntervalMs`, default 60 s; `relay.sweep()` runs it on demand)
- `maxSubscriptions`, `maxFilters`, `maxLimit` (default 5000), `maxNegentropyRecords` (default 500k)
- `admins` (NIP-86 for this realm) and `info` (NIP-11 overrides)
- `writeAllowed(pubkey, event)`, an async hook used for payments. When it is defined, a pubkey that
  is not on the allow list needs the hook to return true before it can write.

The engine keeps NIP-86 moderation state in SQLite: banned and allowed pubkeys, banned events,
allowed and disallowed kinds, blocked IPs, and name, description and icon. This state is layered on
top of the provider's policy. `relay.moderation` exposes it to code. Bans and IP blocks on the
public relay (`null`) also apply to every realm.

### OK / CLOSED messages

Every message uses a standard prefix:

- `invalid:` (bad shape, id or signature; created_at limits; expired; too large)
- `blocked:` (banned pubkey, event, kind or IP; deleted by its author)
- `restricted:` (write allowlist, payment required, protected event from another pubkey)
- `auth-required:`
- `pow:`
- `rate-limited:`
- `duplicate:` (already stored, or a newer replaceable version exists)
- `error:`

## Realms

Every row carries a `realm` column, and `''` stands for the public relay. Queries, live
subscriptions, counts, negentropy, deletions and replaceable semantics all stay inside one realm. The
same event can be stored in more than one realm.

## Storage

The database runs in WAL mode and has a `migrations` table (schema v1). It holds:

- an `events` table, indexed by `(realm, id)`, `(realm, created_at, id)` (the negentropy id/time
  index), `(realm, pubkey, kind)` and `(realm, kind)`, plus a partial index for addressable events
- a `tags` table indexed on `(realm, name, value, created_at)`
- an FTS5 table `events_fts`
- the moderation tables

`backup(path)` runs `VACUUM INTO`.

## Extra API beyond the shared contract

`count()`, `deleteEvent()`, `subscriptions()`, `moderation`, `sweep()` and `backup()` are additions.
The constructor also accepts `verifyWorkers`, `sweepIntervalMs`, `admins` and
`negentropyFrameSizeLimit`.

## Notes

- `verifyWorkers` loads `src/verify-worker.ts` with `new Worker(new URL(...))`. When you compile a
  single binary with `bun build --compile`, add that file as an extra entrypoint.
- `publish()` is trusted: it skips IP, rate-limit and AUTH checks but still enforces the shape,
  signature and content policy.

## Tests

```sh
bun test            # NIP-by-NIP conformance against a real Bun.serve on port 0, incl. load smoke
bunx tsc --noEmit -p packages/nostr-relay
```

The NIP-77 tests also reconcile against the independent `nostr-tools` Negentropy implementation,
and `test/nostr-tools.test.ts` drives the relay with the `nostr-tools` client.
