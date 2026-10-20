# Beamhop Lightspeed — monorepo guide

The full product plan is `docs/PLAN.md` (read the section for your package before coding). Wire formats
live in the "Protocols and wire formats" section of the plan and in code in `packages/p2p/src/wire.ts`.

## Rules

- Runtime and tooling: Bun (`bun install`, `bun test`, `bun build`). TypeScript strict. Biome for lint/format
  (single quotes, no semicolons, 2-space indent, width 100).
- Packages are under `packages/*`, apps under `apps/*`, scoped `@beamhop/*`. Library/Studio/UI/CLI/apps are
  MIT; `relay`, `nostr-relay`, `turn`, `relay-admin` are AGPL-3.0-only.
- Source is consumed directly as TS (`"main": "./src/index.ts"`); no build step needed inside the workspace.
- Tests are `*.test.ts` next to the code, run with `bun test`. Every feature lands with tests. Tests must
  not need the public internet; use memory transports, local servers on port 0 and fakes.
- Do not change `packages/p2p/src/types.ts` or `packages/p2p/src/wire.ts` shapes unless you own `@beamhop/p2p`;
  other packages depend on them. Additive changes only.
- Crypto: `@noble/curves` (secp256k1 schnorr), `@noble/hashes`, `@noble/ciphers`. No native addons.
- Commits: conventional commits (`feat(turn): ...`). End each message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Integration contracts between packages

### `@beamhop/nostr-relay` (engine, embeddable)

```ts
export function createNostrRelay(opts: {
  dbPath: string                      // ':memory:' allowed
  info: Nip11Info                     // NIP-11 document (merged per realm)
  policy?: PolicyProvider             // global + per-realm rules; default allow-all
  auth?: { relayUrl: string }         // NIP-42 challenge relay URL
}): NostrRelay

export interface NostrRelay {
  /** Bun WebSocket handlers. ws.data must be a NostrSocketData. */
  websocket: { open(ws), message(ws, msg), close(ws, code, reason), drain?(ws) }
  socketData(ctx: { realm: string | null; ip: string }): NostrSocketData   // realm null = public relay
  handleInfo(req: Request, realm: string | null): Response                 // NIP-11 (Accept: application/nostr+json)
  handleManagement(req: Request, realm: string | null): Promise<Response>  // NIP-86 + NIP-98
  publish(event: NostrEvent, realm?: string | null): Promise<{ ok: boolean; message: string }>
  query(filters: Filter[], realm?: string | null): NostrEvent[]
  stats(): { events: number; subscriptions: number; clients: number; eventsPerSec: number }
  onEvent(cb: (e: NostrEvent, realm: string | null) => void): () => void
  close(): void
}
```
`PolicyProvider` is `{ get(realm: string | null): Policy }` where Policy covers: pubkey allow/deny, kind
allow/deny, rate limits per IP/pubkey, max event size, NIP-13 min PoW, auth-required kinds, retention per kind,
writeAllowed(pubkey) hook (used by payments).

### `@beamhop/turn` (engine, standalone-capable)

```ts
export function createTurnServer(opts: {
  realm: string
  listen: { udp?: number; tcp?: number; tls?: { port: number; cert: string; key: string } }
  host?: string                       // bind address, default 0.0.0.0
  externalIp?: string                 // advertised relayed address
  relayPorts: [number, number]        // allocation port range
  /** Long-term credential lookup; return null to reject. key = MD5(username:realm:password) or pass password. */
  credentials(username: string): { password: string } | null
  quota?(username: string): { maxAllocations?: number; maxBps?: number; allowed?: boolean }
  onUsage?(u: { username: string; allocationId: string; bytesIn: number; bytesOut: number }): void
}): TurnServer

export interface TurnServer {
  start(): Promise<{ udp?: number; tcp?: number; tls?: number }>  // actual bound ports (port 0 allowed)
  stop(): Promise<void>
  allocations(): AllocationInfo[]   // id, username, transport, client 5-tuple, relayed addr, bytes, createdAt, expiresAt
  kill(id: string): boolean
  stats(): { allocations: number; bytesIn: number; bytesOut: number; bps: number }
}
```
TURN REST credentials use `turnUsername`/`turnPassword` from `@beamhop/p2p/wire`.

### `@beamhop/relay` admin API (consumed by `@beamhop/relay-admin`)

Base `/api/admin`, JSON, cookie session `bh_admin`. All writes audited.
- `POST /auth/challenge` → `{ challenge }`; `POST /auth/nostr` `{ event }` (kind 27235 signed challenge) → session
- `POST /auth/password` `{ username, password, totp }`; `POST /auth/bootstrap` `{ token, pubkey?|username+password }`
- `POST /auth/logout`; `GET /me`
- `GET /overview` → counters + alerts; WebSocket `/api/admin/stats` pushes `{ type: 'stats', ... }` every second
- `GET/POST /apps`, `GET/PATCH/DELETE /apps/:id`, `POST /apps/:id/rotate-turn-secret`, `POST /apps/:id/rotate-api-key`, `GET /apps/:id/usage`
- `GET /nostr/events?kind&author&tag&search&limit&until`, `DELETE /nostr/events/:id`, `GET /nostr/subscriptions`
- `GET/PUT /policies/:realm` (`_global` for the public relay), `GET/PUT /nip11`
- `GET /turn/allocations`, `DELETE /turn/allocations/:id`, `GET/POST/DELETE /bans`
- `GET /media/blobs?app&pubkey`, `DELETE /media/blobs/:sha256`
- `GET/POST /payments/plans`, `GET /payments/invoices`, `GET /payments/paid`, `PUT /payments/nwc`
- `GET/POST/DELETE /admins`, `GET /sessions`, `DELETE /sessions/:id`, `GET /audit`
- `GET/PUT /settings`, `POST /backups`, `GET /backups`
Errors: `{ error: { code, message } }` with 4xx/5xx.

### Relay URL map (`@beamhop/relay`)
- `wss://host/` public Nostr relay; `wss://host/a/<appId>` realm relay
- `wss://host/a/<appId>/data` data relay (see `wire.ts` RelayControl + envelope)
- `POST /a/<appId>/turn-credentials` (header `Authorization: Bearer <apiKey>` or a NIP-98 event) → `TurnCredentialsResponse`
- `/admin` SPA (static build of `@beamhop/relay-admin`), `/api/admin/*`, `/pay`, `/metrics`, `/healthz`
- Blossom: `PUT /upload`, `GET|HEAD|DELETE /<sha256>[.ext]`, `GET /list/<pubkey>`, `PUT /mirror`
