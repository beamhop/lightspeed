# @beamhop/relay-admin

Mobile-first admin SPA for the Beamhop relay, served by `@beamhop/relay` at `/admin`. AGPL-3.0-only.

Stack: Preact 11 + `@preact/signals`, Vite 8, Tailwind v4 on the `@beamhop/ui` tokens
(`tokens.css` mapped through `@theme inline`), uPlot charts. Dark by default (light theme toggle in
Settings). Bottom navigation on phones (Overview, Nostr, TURN, Apps, More sheet), sidebar on desktop.

## Commands

```sh
bun run --cwd packages/relay-admin dev           # Vite dev server, proxies /api to a relay on :8080
bun run --cwd packages/relay-admin dev:mock      # same, against the in-browser mock API
bun run --cwd packages/relay-admin build         # -> packages/relay-admin/dist (base /admin/)
bun run --cwd packages/relay-admin preview:mock  # mock build + vite preview
bun test packages/relay-admin
bunx tsc --noEmit -p packages/relay-admin
```

Mock mode: open any page with `?mock=1` (the flag sticks across in-app navigation) or build with
`VITE_MOCK=1`. Any credentials work; Nostr sign-in falls back to a throwaway local key when no NIP-07
extension is installed. The mock keeps state in memory and remembers the sign-in per tab.

The relay serves `dist/` with an SPA fallback to `index.html` for `/admin/*`. `src/index.ts` exports
`distDir`, the typed API client (`createApi`), `createMockApi` and the domain types for other packages.

## Layout

| Path | What |
| --- | --- |
| `src/api.ts`, `src/types.ts` | Typed client for `/api/admin` (CLAUDE.md contract); `ApiError`, list normalization, `normalizePolicy` |
| `src/stats.ts` | The single `/api/admin/stats` WebSocket -> signals (`latest`, `history`, `series`, `status`), reconnect with jittered backoff |
| `src/store.ts` | Session, `confirm()` / `performWrite()` (every write), toasts, reveal-once secrets |
| `src/nostr.ts` | Event hashing, NIP-07, NIP-44 v2, NIP-46 bunker client, kind 27235 auth event |
| `src/router.ts` | Signal-based history router under `/admin` |
| `src/mock/` | Deterministic fake data, fetch mock and fake stats socket |
| `src/components/` | Mascot (hand-drawn bunny: idle, spinner, smile, angry, secret), dialogs, charts, table, form primitives, layout |
| `src/screens/` | Login, Overview, Nostr, TURN, Apps (+ detail), Media, Payments, Admins, Settings |

## Behaviour

- **Login**: NIP-07 extension, NIP-46 bunker URI (`bunker://…?relay=…&secret=…`, NIP-44 encrypted,
  handles `auth_url`), username + password + TOTP, and the first-run bootstrap claim (owner = Nostr key,
  or username + password with the TOTP secret shown once). Nostr flows sign a kind 27235 event carrying
  the `/auth/challenge` value (`challenge`, `u`, `method` tags).
- **Live stats**: one WebSocket, started after sign-in and stopped on sign-out; the header shows
  Live / Reconnecting (n) / Offline. Overview, TURN and the charts read from it.
- **Writes**: every mutating call goes through `performWrite`, which opens a confirmation dialog listing
  the affected scope (realm, app, IP, field-by-field diff for policies and settings) and notes that it is
  audited as the current admin. Destructive app deletion requires typing the app name.
- **Secrets**: app creation and TURN secret / API key rotation show values in a reveal-once modal that
  needs an explicit "I saved it" acknowledgement before it closes.

## API assumptions beyond the contract

The contract in `CLAUDE.md` does not pin every shape. The client tolerates list endpoints returning a bare
array or `{ items }`. These choices are mine and may need to match the relay:

- Path parameters for deletes: `DELETE /bans/:id`, `DELETE /admins/:id`.
- Extensions used by the UI: `POST /overview/alerts/:id/ack`, `POST /admins/:id/reset-totp`,
  `GET /payments/nwc` (status), `PUT /payments/nwc` with `{ uri?: string | null, lnurl? }`
  (omitting `uri` keeps the wallet), `realm` query param on `/nostr/events`.
- `tag` filter is sent as `t:value`; `kind` as a comma list.
- Policy shape: `{ pubkeys: {allow, deny}, kinds: {allow, deny}, rateLimits: {perIp, perPubkey: {events, windowSec}},
  maxEventSize, minPow, authRequiredKinds, retention: [{kinds, maxAgeSec?, maxCount?}] }`.
- Stats frame: `{ type: 'stats', ts, nostr: {events, subscriptions, clients, eventsPerSec}, turn: {allocations,
  bytesIn, bytesOut, bps}, disk?: {usedBytes, totalBytes}, uptimeSec?, alerts? }`.

## Not done yet

- Backup restore is documented as an offline CLI step; there is no restore endpoint.
- Payments refund/extend and plan editing/deactivation, negentropy status and "test TLS" have no API yet.
- The Grafana dashboard download is generated client-side with guessed metric names.
