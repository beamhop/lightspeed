# @beamhop/relay

One Bun process that runs everything a Beamhop deployment needs: a public Nostr relay, per-app
realms, a data relay for peers that cannot connect directly, TURN, Blossom media, Lightning payments,
Prometheus metrics and the admin API + SPA. AGPL-3.0-only.

```sh
bunx beamhop relay init --domain relay.example.com   # writes beamhop-relay.toml + systemd unit, prints the bootstrap token
bunx beamhop relay --config beamhop-relay.toml
# or the standalone binary / Docker image (see "Install")
```

## URL map

| Path | What |
| --- | --- |
| `wss://host/` | Public Nostr relay (`@beamhop/nostr-relay`, realm `null`) |
| `wss://host/a/<appId>` | App realm relay (own policy, NIP-11 overrides) |
| `wss://host/a/<appId>/data` | Data relay: `challenge` → signed `hello` → `ready`, then binary envelopes (`wire.ts`) |
| `POST /a/<appId>/turn-credentials` | TURN REST credentials. `Authorization: Bearer <apiKey>` (body `{ pubkey? }`) or a NIP-98 event |
| `GET /` with `Accept: application/nostr+json` | NIP-11 (also under `/a/<appId>`); `POST` with `application/nostr+json+rpc` is NIP-86 |
| `/admin` | Admin SPA (`@beamhop/relay-admin` build, `index.html` fallback) |
| `/api/admin/*`, `wss://host/api/admin/stats` | Admin API and the 1 s stats stream |
| `/pay`, `/pay/invoice`, `/pay/invoice/<hash>`, `/pay/status/<pubkey>`, `/pay/plans` | Lightning payments |
| `/metrics`, `/healthz` | Prometheus text format, health JSON |
| `PUT /upload`, `HEAD /upload`, `PUT /mirror`, `GET\|HEAD\|DELETE /<sha256>[.ext]`, `GET /list/<pubkey>` | Blossom (BUD-01/02/04/06). Same routes under `/a/<appId>/…` count against that app's quota |

## Ports

| Port | Protocol | Use |
| --- | --- | --- |
| 443 | TCP | HTTPS/WSS (`http.port`) |
| 3478 | UDP + TCP | STUN / `turn:` |
| 5349 | TCP | `turns:` (`turn.tls_port`, 0 disables) |
| 50000–50100 | UDP | TURN relayed allocations (`turn.relay_port_min/max`) |

TURN cannot sit behind an HTTP proxy or Cloudflare: publish its ports directly and set
`turn.external_ip` to the host's public address when it is behind NAT (Docker, cloud VMs).

## Configuration

`beamhop-relay.toml` (snake_case keys, see `deploy/beamhop-relay.example.toml` for every key and its
default) is read from `--config`, `$BEAMHOP_CONFIG` or `./beamhop-relay.toml`. Every key has an
environment override: `BEAMHOP_<KEY>` for top-level keys and `BEAMHOP_<SECTION>_<KEY>` otherwise
(`BEAMHOP_DATA_DIR`, `BEAMHOP_HTTP_PORT=8443`, `BEAMHOP_TURN_EXTERNAL_IP=203.0.113.7`,
`BEAMHOP_BLOSSOM_ALLOWED_MIME=image/*,video/mp4`).

Precedence: defaults < TOML < settings saved from the admin UI (stored in `admin.db`) < environment.
Keys set through the environment are reported as locked by `GET /api/admin/settings` and refuse
edits. Listener ports, TLS paths and `data_dir` need a restart; the API answers `restartRequired`.

## Operator notes

**First run.** With no admin in `admin.db`, the relay mints a bootstrap token, prints it on stderr and
in the JSON log (`"msg":"no admin yet…"`). Open `/admin` → Claim, paste it and choose a Nostr pubkey
(NIP-07/NIP-46 login later) or username + password (the TOTP secret is shown once). The token is single
use and stored only as a hash. Lost it before claiming? `beamhop relay bootstrap-token --config …`
mints a new one (refused once an admin exists).

**Admin auth.** Nostr login signs a kind 27235 event carrying the `/auth/challenge` value in a
`challenge` tag (or as content), within ±120 s, from a pubkey on the admin list. Password login needs
the TOTP code (RFC 6238, SHA-1, 30 s, ±1 step, codes cannot be replayed). Sessions are an HttpOnly
`bh_admin` cookie, `SameSite=Strict`, `Secure` on HTTPS, 7 days by default (`admin.session_ttl_hours`).
Writes must come from the same origin (Origin / Sec-Fetch-Site check; add extra origins in
`admin.allowed_origins`) and carry JSON. Every write lands in the audit log with the admin's pubkey or
username, the IP and the details; failed logins are audited as `auth.failed`.

**TLS.** Set `http.tls_cert`/`http.tls_key` (PEM paths). The relay checks the files every minute and
rebinds the listener with the new certificate after a renewal (in-flight connections finish on the
old one). With certbot, the key is root-only: add a deploy hook that copies `fullchain.pem` and
`privkey.pem` to a directory readable by the `beamhop` user. `turns:` uses `turn.tls_cert/tls_key`, or
the HTTP certificate when those are empty. Behind Caddy (see `deploy/compose`), leave the HTTP TLS
paths empty, listen on 8080 and set `http.trust_proxy = true` so client IPs come from
`X-Forwarded-For`.

**Apps.** Each app (`/a/<appId>`) has a TURN shared secret, an API key (shown once; stored as
SHA-256), quotas (TURN allocations, Mbps, GB/month; data-relay GB/month; Blossom storage, max blob
size and MIME list) and its own Nostr policy. Rotating the TURN secret invalidates every credential
minted with the old one; clients just fetch new credentials. Disabling or deleting an app closes its
data-relay sockets and stops credential minting.

**TURN credentials.** `username = <expiry>:<appId>:<pubkey>`, `credential = base64(HMAC-SHA1(secret,
username))`, lifetime `turn.credential_ttl` (1 day). The relay hands the TURN engine a credential
lookup that recomputes this, rejects expired names, disabled apps and banned pubkeys, and a quota hook
that groups allocations and bandwidth per app and refuses new allocations once the monthly quota is
used. Byte deltas reported by the engine are accounted per app per day in `admin.db`.

**Policies.** Edited per realm (`_global` = public relay) in the admin shape
`{ pubkeys, kinds, rateLimits: { perIp, perPubkey: { events, windowSec } }, maxEventSize, minPow,
authRequiredKinds, authRequired, retention: [{ kinds, maxAgeSec, maxCount }], requirePayment }` and
translated for the engine (token buckets `{ rate: events/windowSec, burst: events }`, `maxEventBytes`,
`maxAgeSeconds`). Pubkey bans are merged into `pubkeys.deny`. The relay's own key (`info.self`) is a
NIP-86 admin for every realm.

**Payments.** Connect a wallet with a `nostr+walletconnect://` URI (admin → Payments, or
`payments.nwc_url`). Create plans (sats, days). `/pay` lets a user sign in with NIP-07 or paste an
npub, pick a plan and pay the invoice (QR + `lightning:` link); the page polls and the relay also
polls pending invoices every 15 s. Paid pubkeys are write-allowed until their expiry (paying again
extends it). With `payments.required = true` (or `requirePayment` in a realm policy) unpaid pubkeys
get `restricted:` from the engine through the policy's `writeAllowed` hook. NIP-11 advertises
`payments_url`, `fees.subscription` and `limitation.payment_required`.

**Blossom.** Blobs live under `<data>/blobs/<aa>/<sha256>`, metadata and ownership in `admin.db`.
Uploads need a kind 24242 event (`t` = verb, future `expiration`, `x` = hash for delete/mirror).
Limits: `blossom.max_upload_bytes`, `blossom.allowed_mime`, `blossom.default_quota_bytes` (public
scope), `blossom.per_pubkey_quota_bytes`, plus each app's own quota. A blob is deleted from disk when
its last owner deletes it. `GET` supports single byte ranges.

**Backups.** Nightly at `backups.hour` (UTC) the relay writes `VACUUM INTO` snapshots of `admin.db`
and `nostr.db` to `<data>/backups` (or `backups.dir`) and deletes ones older than
`backups.retention_days` (14). `POST /api/admin/backups` runs one now. Restore: stop the relay, copy
the snapshot files over `admin.db` / `nostr.db`, start it again. Migrations run on boot and refuse to
open a database written by a newer relay.

**Alerts.** Disk use above `alerts.disk_percent` (80), an app at its TURN quota, a 5xx ratio above
`alerts.error_rate` over 5 minutes (at least 20 requests), and a certificate expiring within
`alerts.cert_days` (14). They show in the admin overview (acknowledge until resolved), in the stats
stream count and as `beamhop_alerts_active`. Email delivery is not implemented; alert from Prometheus.

**Monitoring.** `/metrics` (on by default, `metrics.enabled`; optionally protected by `metrics.token` as a
bearer token) exports
`beamhop_*` gauges and counters for HTTP, both engines, the data relay, per-app usage, Blossom,
payments, disk, alerts and certificate expiry. `deploy/grafana/beamhop-relay.json` is a ready
dashboard. Logs are JSON lines on stdout (`log.level`).

**Rate limits and bans.** Every HTTP request counts against `http.rate_limit_per_minute` per IP
(`/healthz` and `/metrics` excluded); the data relay caps messages per socket per second
(`data.messages_per_second`). IP bans block all HTTP/WebSocket routes; pubkey bans block Nostr
writes, data-relay hello, Blossom and TURN credentials.

## Install

- **Binary:** `bun run --cwd packages/relay build` produces `dist/beamhop-relay-{linux-x64,linux-arm64,darwin-arm64}`.
  Serve the admin UI by pointing `admin.dist_dir` at a `@beamhop/relay-admin` build. Use
  `deploy/systemd/beamhop-relay.service` (non-root `beamhop` user, `CAP_NET_BIND_SERVICE`, hardening).
- **Docker:** the root `Dockerfile` builds the SPA and the binary into a slim, non-root image with a
  `/data` volume and a `--healthcheck` probe:
  `docker run -p 443:443 -p 3478:3478 -p 3478:3478/udp -p 5349:5349 -p 50000-50100:50000-50100/udp -e BEAMHOP_TURN_EXTERNAL_IP=<ip> -v beamhop:/data ghcr.io/beamhop/relay`
- **Compose + Caddy:** `deploy/compose` (Caddy for ACME on 80/443, relay on 8080 inside the network,
  TURN ports published directly, optional Prometheus profile).

## Embedding

```ts
import { createRelayServer, loadConfig } from '@beamhop/relay'

const relay = createRelayServer(loadConfig('beamhop-relay.toml'))
const { url, bootstrapToken } = await relay.start()
```

`createRelayServer(config, deps)` accepts `nostrFactory` / `turnFactory` (default: load
`@beamhop/nostr-relay` / `@beamhop/turn`; `null` runs without that engine and `/healthz` reports
`degraded`), `nwcFactory`, `logger`, `now` and `fetch`. The engine contracts the relay codes against
live in `src/engines.ts`; `src/testing.ts` has in-process fakes used by the tests.

## Development

```sh
bun test packages/relay/src          # fakes for both engines + a real-engines e2e and SPA-client contract test
bunx tsc --noEmit -p packages/relay
```
