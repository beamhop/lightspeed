
# Beamhop P2P — Build Plan
2026-10-20 · 
## Decisions
Four deliverables ship under the Beamhop brand from one monorepo at full-time pace: a Bun relay (full Nostr relay + built-in TURN + admin UI), a TypeScript P2P library, a demo client with docs on GitHub Pages, and a developer Studio.
 | 
Decision | 
Choice
 | 
Brand | 
Beamhop sub-brand; packages under @beamhop/*; Beamhop palette and mascot
 | 
Relay runtime | 
Bun; one bun build --compile binary per platform plus a Docker image
 | 
TURN engine | 
Pure TypeScript on Bun (Bun.udpSocket, Bun.listen with TLS); in-process hooks for the admin UI
 | 
Nostr relay storage | 
SQLite via bun:sqlite, WAL mode, FTS5 for search
 | 
Relay NIPs | 
Core 01/09/11/40/42/45/65/70 + NIP-50 search, NIP-77 negentropy, NIP-86 management, Blossom media, Lightning paid relay
 | 
Tenancy | 
Apps (realms) on one relay: per-app TURN secrets, quotas and Nostr policies; one admin team
 | 
Admin auth | 
Nostr login (NIP-07 / NIP-46) with an admin pubkey allowlist, plus password + TOTP fallback
 | 
Library v1 | 
Typed protocol + request/response, anonymous + Nostr + OIDC identity, mesh + host-authoritative star, reliable/unreliable channels, relay data fallback, state sync, React bindings, Bun server peer
 | 
Demo client | 
Presence + chat, live cursors, file drop, audio/video call; public STUN + public Nostr relays only
 | 
Studio | 
In v1
 | 
Repo | 
One monorepo; one GitHub Pages site serves docs + demo
 | 
License | 
MIT for the library, Studio and client; AGPL-3.0 for the relay and its engines
 | 
Capacity | 
40h+/week, solo, agent-driven in PR-sized increments
## Deliverables and naming
Ten packages, two apps, one CLI; names below are proposals to confirm before the first publish.
 | 
Deliverable | 
Package / artifact | 
What it is | 
License
 | 
Library core | 
@beamhop/p2p | 
Identity, signaling, transports, topologies, channels, typed protocol, state sync, telemetry | 
MIT
 | 
Nostr signaling | 
@beamhop/signaling-nostr | 
Default adapter; public relays or your own relay | 
MIT
 | 
React bindings | 
@beamhop/react | 
RoomProvider, useRoom, usePeers, useAction, useRequest, useSharedState, useSharedLog, useTelemetry | 
MIT
 | 
Relay server | 
@beamhop/relay, binary beamhop-relay, image ghcr.io/beamhop/relay | 
Wires the engines below with the admin UI, Blossom and payments into one process | 
AGPL-3.0
 | 
Nostr relay engine | 
@beamhop/nostr-relay | 
NIP pipeline + SQLite store, embeddable in other Bun apps | 
AGPL-3.0
 | 
TURN engine | 
@beamhop/turn | 
STUN/TURN server in TypeScript, standalone-capable | 
AGPL-3.0
 | 
Admin UI | 
@beamhop/relay-admin | 
Mobile-first SPA served by the relay at /admin | 
AGPL-3.0
 | 
Studio | 
@beamhop/studio | 
Developer tool: topology, inspector, timeline, fault injection, peer spawner | 
MIT
 | 
Shared UI | 
@beamhop/ui | 
Design tokens, components, mascot states used by admin, Studio and demo | 
MIT
 | 
CLI | 
beamhop | 
beamhop relay, beamhop studio, beamhop init (scaffolds an app) | 
MIT
 | 
Demo client | 
apps/demo → GitHub Pages /demo | 
Presence + chat, cursors, file drop, calls on public infrastructure | 
MIT
 | 
Docs | 
apps/docs → GitHub Pages root | 
Library guides, API reference, relay operator manual, Studio manual | 
MIT
The CLI is the front door: bunx beamhop relay runs the relay, bunx beamhop studio opens Studio, so the docs teach one command family.
## Relay server
One Bun process serves everything: HTTPS/WSS on 443 (Nostr, admin, Blossom, turns:), STUN/TURN on 3478 UDP+TCP, and a UDP port range for TURN allocations.
Clients enter through two listeners; the Nostr engine, admin API and Blossom persist to SQLite and disk, while TURN and the data relay only count bytes.
Listeners. Bun.serve with TLS for HTTP + WebSocket; Bun.listen for TURN over TCP/TLS; Bun.udpSocket for STUN/TURN and every relayed allocation. TLS from cert files in v1; a Caddy fronting example for ACME, with TURN always bound directly (it cannot be proxied).
Nostr relay engine. NIP-01 pipeline: parse → Schnorr verify (@noble/curves, moved to a Worker pool when CPU-bound) → policy engine → store → live subscription matcher. Kinds 20000–29999 are matched but never stored. NIP-09 deletions, NIP-40 expiry sweeper, NIP-42 AUTH challenges, NIP-45 COUNT, NIP-70 protected events, NIP-11 info document, NIP-86 management RPC with NIP-98 auth, NIP-50 search on FTS5, NIP-77 negentropy reconciliation.
Policy engine. Global and per-app rules: pubkey allow/deny, kind allow/deny, rate limits per IP and pubkey, max event size, NIP-13 PoW minimum, AUTH-required kinds, retention per kind. Rules are data in admin.db, edited from the UI, hot-reloaded.
Apps (realms). wss://relay.example/ is the public Nostr relay; wss://relay.example/a/<appId> is an app realm with its own policies, quotas and TURN secret. An app record holds: id, name, TURN shared secret (rotatable), API key for credential minting, Nostr policy, Blossom quota, plan. The library only ever uses a realm for signaling.
TURN engine. STUN binding (RFC 8489); TURN Allocate, Refresh, CreatePermission, Send/Data indications, ChannelBind + ChannelData (RFC 8656); IPv4 + IPv6 relayed addresses; long-term credentials with MESSAGE-INTEGRITY and FINGERPRINT; TURN REST ephemeral credentials (username = <expiry>:<appId>:<peer>, HMAC-SHA1 with the app secret); transports turn: UDP/TCP 3478, turns: 5349 and 443. Per-allocation byte accounting feeds quotas (max allocations, Mbps cap, GB/month per app) and the admin UI. TCP allocations (RFC 6062) are out of scope.
Data relay. wss://relay.example/a/<appId>/data forwards opaque end-to-end-encrypted frames between library peers that cannot connect directly, and lets a Bun peer join without WebRTC at all. Bytes are accounted per app like TURN.
Admin API + UI. REST at /api/admin, live stats over WebSocket, SPA at /admin. Sessions from Nostr login (NIP-07 / NIP-46 signed challenge) against the admin pubkey allowlist, or password + TOTP. First run prints a bootstrap token to claim the first admin.
Media (Blossom). BUD-01/02/06: upload, get, delete by sha256 with signed auth; per-app and per-pubkey quotas; blobs on disk under /data/blobs, S3-compatible backend later. NIP-96 compatibility only if a client you need requires it.
Payments. Lightning through NWC (NIP-47) for invoices; plans per pubkey with expiry; NIP-11 advertises payments_url and fees; a /pay page with Nostr login, invoice and QR; paid pubkeys become write-allowed by policy.
Storage. nostr.db (events, tags, FTS5 index, negentropy id/time index), admin.db (apps, admins, sessions, policies, usage counters, invoices), /data/blobs. Migrations run on boot; nightly VACUUM INTO backups with retention.
Config and observability. beamhop-relay.toml + env overrides; admin edits persist to admin.db. Prometheus /metrics, JSON logs, /healthz; the admin dashboard reads the same counters.
## Library
@beamhop/p2p is eight layers, each an interface with a default, so an app can swap signaling, transport or identity without touching the others.
Calls flow down from the typed protocol to a transport; identity and signaling feed the connection manager from the sides.
Identity. A secp256k1 keypair (BIP-340 Schnorr, NIP-44 for pairwise encryption) plus attestations of who vouches for it. Providers: anonymous() (ephemeral, optionally persisted in IndexedDB), nostr() (NIP-07 extension, nsec, NIP-46 bunker), oidc() (a short-lived cert from your backend binds the JWT sub to the session pubkey; peers verify against the issuer's JWKS). Room policy decides which attestations admit a peer.
Signaling. SignalingAdapter { announce, subscribe, send, close }. Default: Nostr ephemeral events encrypted with NIP-44, over any relay list; a union adapter fans out to several adapters for redundancy; a memory adapter for tests.
Transport. Transport.connect(peer) → Connection exposing ordered, unordered and unreliable channels plus media. Implementations: webrtc (RTCPeerConnection), relay (WebSocket to the Beamhop relay's data path, WebTransport later), memory (tests and the simulator).
Connection manager. Runs the ladder per peer pair: direct → TURN → relay. With relayFirst: true it connects through the relay in one round trip, runs ICE in parallel, then migrates channels to the direct path. Sessions are keyed by identity, so a dropped connection resumes with away/back events instead of leave + join; message ids and acks give at-least-once delivery across the gap.
Topology. mesh (full, intended for ≤ 12 peers) and star (host-authoritative: lowest pubkey or explicit host, handoff on host leave). Third-peer relaying is v2.
Channels and framing. Each protocol entry declares reliable, unordered or unreliable(maxRetransmits) and a priority lane. CBOR frames with a stream id; 16 KiB chunks for large payloads with progress callbacks; backpressure from bufferedAmountLow; file transfer as WHATWG streams.
State. room.state.map(name) is a last-writer-wins map on hybrid logical clocks; room.state.log(name) is an append-only log with per-author sequence numbers. Late joiners request a snapshot from the host or Bun server peer, then replay. A Yjs adapter is v2.
Telemetry. room.telemetry.subscribe() emits connection state transitions, candidate-pair type (direct/TURN/relay), bytes per channel, RTT and chunk progress. Studio and the demo's debug drawer read this bus; it is off in production unless enabled.
Schemas go through Standard Schema, so Zod, Valibot or ArkType all work. Runtimes: browsers, Bun, Node and workers; a Bun server peer using only the relay transport needs no WebRTC polyfill.
## Protocols and wire formats
Everything a peer sends over a Nostr relay is an ephemeral event encrypted with NIP-44; the relay learns a room topic hash and traffic volume, nothing else.
 | 
Element | 
Format
 | 
Room topic | 
sha256("beamhop/v1" ‖ appId ‖ roomId ‖ password-or-empty) hex, carried as a t tag so every relay indexes it
 | 
Room key | 
HKDF-SHA256 over the same inputs; encrypts room-wide announces (AES-256-GCM)
 | 
Announce | 
Ephemeral kind 20100, tagged t; content: session pubkey, attestations, peer.meta, capability token, TTL 30 s; re-sent every 20 s
 | 
Directed signal | 
Ephemeral kind 20101, tagged t and p (recipient); content NIP-44 to the recipient: offer, answer, ICE candidates, relay-connect
 | 
Handshake | 
First reliable channel frame: version, identity pubkey, attestations, meta, nonce, signature over the transcript; verified before onPeerJoin
 | 
Pair session key | 
NIP-44 v2 conversation key between the two identity pubkeys; ChaCha20-Poly1305 with a per-direction counter nonce for relay-path frames
 | 
Attestation cert (OIDC) | 
JWS { v: 1, iss, sub, pubkey, iat, exp } signed by the app backend; peers cache the issuer JWKS; policy attest: { oidc: { iss } }
 | 
Capability token | 
Signed by the room host or app key: { room, pubkey, caps: ['join', 'debug'], exp }; Studio joins with debug
 | 
Data frame | 
version u8 · type u8 · streamId u16 · length u16 · payload; types: hello, connect, data, close, ping; chunked at 16 KiB
 | 
Relay data path | 
wss://relay/a/<appId>/data; hello carries a signed challenge; the relay forwards ciphertext by peer pubkey and counts bytes per app
 | 
TURN credentials | 
POST https://relay/a/<appId>/turn-credentials → { iceServers, ttl }; username <expiry>:<appId>:<pubkey>, credential = base64 HMAC-SHA1 with the app secret
 | 
NIP-42 | 
Realms can require AUTH before accepting kind 20100/20101; the demo on public relays does not
The demo uses public relays and public STUN only (no TURN, no data relay), so a symmetric-NAT pair will fail there; the demo shows the failure reason and offers a field to point at your own relay.
## Admin UI
A mobile-first SPA at /admin, dark by default in the Beamhop palette (midnight indigo #0B0E1A, teal #5EEAD4, violet #8B7BFF), fed by one WebSocket stats stream so every screen is live.
Stack: React 19 + shadcn/ui, signals for app state, Vite, Tailwind with Beamhop tokens from @beamhop/ui, uPlot for charts, bottom navigation on phones. The bunny mascot states (Idle, Spinner, Smile, Angry, Secret) cover loading, empty and error states.
 | 
Area | 
Screens | 
Actions
 | 
Overview | 
Events/s, open subscriptions, connected clients, TURN allocations, relayed Mbps, disk, uptime, alerts | 
Acknowledge alerts, jump to the offending app or client
 | 
Nostr relay | 
Event explorer (kind, author, tag, NIP-50 search), live subscriptions, policy editor, NIP-11 editor, retention, negentropy status | 
Allow/deny pubkeys and kinds, set rate limits and PoW, require AUTH per kind, delete events, run backup/restore
 | 
TURN | 
Allocations (app, user, 5-tuple, bytes, age), bandwidth charts, transport/port status, IP ban list | 
Kill an allocation, set per-app quotas, rotate secrets, ban an IP
 | 
Apps | 
App list, per-app policy, quotas, API keys, usage, plan | 
Create app, rotate TURN secret and API key, edit realm policy, export usage
 | 
Media | 
Blob browser by app/pubkey, usage, mime/size limits | 
Delete blobs, set quotas
 | 
Payments | 
Plans, invoices, NWC connection, paid pubkeys, revenue | 
Create plans, refund/extend, reconnect wallet, edit LNURL
 | 
Admins | 
Admin pubkeys, password + TOTP, sessions, audit log | 
Invite/remove admins, revoke sessions, reset TOTP, view bootstrap/recovery
 | 
Settings | 
TLS cert paths, listeners and ports, logging, metrics, backups | 
Edit config, test TLS, download Grafana dashboard
Every write action has a confirmation with the affected scope spelled out and lands in the audit log with the admin's pubkey.
## Demo client and docs site
One GitHub Pages deployment: docs at the root, the demo at /demo, both built by a single Actions workflow on every push to main.
Demo (apps/demo). Preact + Vite, @beamhop/p2p with anonymous() identity by default and a "Sign in with Nostr" toggle. Signaling fans out to three public relays; ICE uses stun.l.google.com:19302 and stun.cloudflare.com:3478; no TURN. Screens:
Lobby: create or join a room by link or QR; shows which relays are connected
Room: presence list with peer.meta names, typed chat on a reliable channel
Cursors: shared canvas on the unreliable channel; cursors with names and RTT
Files: drag-and-drop transfer with per-peer progress bars, as a WHATWG stream
Call: audio/video with mute, camera switch and screen share; shows direct vs. STUN path per peer
Debug drawer: connection type per peer, bytes per channel, last signaling events; a field to point the demo at your own relay for TURN and the data relay
Docs (apps/docs). Astro Starlight: Markdown/MDX, built-in search, mobile layout, dark mode matching the brand. Sections:
Get started: five-minute room on public relays, then React
Concepts: identity and attestations, signaling, transports and the ladder, topologies, channels, state sync, telemetry
Guides: React hooks, Bun server peer, OIDC auth, file transfer, calls, Studio walkthrough, migrating from Trystero
Relay operator manual: install (binary, Docker, Compose with Caddy), config, TLS, ports and NAT, apps and realms, admin UI tour, backups, payments, Blossom, supported NIPs with per-NIP notes
API reference generated from TSDoc with TypeDoc
Protocol spec: the wire formats section of this plan, kept current
Troubleshooting: NAT types, TURN diagnosis, Safari quirks, relay reachability
Changelog from Changesets
The landing page carries the Beamhop wordmark and mascot and embeds the live demo.
## Studio
bunx beamhop studio opens a local web app that attaches to a running room as an observer peer and renders the telemetry bus; it is built on @beamhop/p2p itself, so every transport and relay it debugs is one it also uses.
Attach modes
Observer peer: joins the room with a debug capability token (signed by the app key, or any token when the app runs with dev: true) and receives telemetry on the reserved __beamhop/telemetry channel. Works across machines and phones.
In-page bridge: room.devtools() exposes a BroadcastChannel; Studio runs as a same-origin iframe or a dev-only overlay, no network needed.
Chrome DevTools panel: an extension wrapping the bridge; after v1.
Views
Topology graph: peers as nodes, links badged direct / TURN / relay with RTT and bytes; host marked in star rooms
Message inspector: every action, request and stream decoded through the app's protocol schema; filter by peer, action, direction
Timeline: signaling, connection state transitions and messages on one track; scrub to replay what a peer saw
Connection detail: per-peer state machine, candidate pairs, channel buffer levels, resume history
Fault injection: added latency, loss, partition, kill peer — real against the memory/sim transport, and via a dev hook on live WebRTC channels
Peer spawner: launch N headless Bun peers over the relay transport (no WebRTC needed) running a chosen script, for load and chaos tests
Relay health: NIP-11 fetch, AUTH check, TURN credential mint and allocation test, signaling RTT per relay
Identity switcher: swap between anonymous, Nostr and OIDC identities to test admission policies
Studio shares @beamhop/ui with the admin panel, so the two tools look like one product.
## Monorepo layout
Bun workspaces, one repo, three release trains (npm packages via Changesets, relay binaries + Docker image on tags, Pages on every push).
Build: bun build for ESM bundles, tsc --emitDeclarationOnly for types; bun build --compile --target for linux-x64, linux-arm64, darwin-arm64 relay binaries
Quality: Biome for lint and format, bun test everywhere, Playwright for e2e, typecheck in CI
Versioning: Changesets with conventional commits; 0.x while phases 1–5 land, 1.0 at phase 6
CI (GitHub Actions): ci.yml (test, typecheck, e2e on Linux), release.yml (npm publish, binaries, ghcr.io/beamhop/relay), pages.yml (docs + demo)
Working method: one PR per feature slice, agent-authored, with the gate test in the PR; CLAUDE.md holds the protocol spec links, naming rules and the testing checklist
## Roadmap
Seven phases over 20 working weeks at 40h+/week, plus a 3-week buffer for the four hard parts (TURN, negentropy, payments, WebRTC quirks): from a Nov 3, 2026 start, 1.0 lands in early April 2027. Each phase ends at a gate that is a passing test, not a feeling.
Each gate is a passing test, not a date; phase 6 carries the 3-week buffer.
The library and relay are public from phase 1 and 2 as 0.x, so feedback arrives while the hard parts are still being built; if dates slip, phase 6's extras are the first cut.
## Testing and conformance
Every phase gate is an automated test in CI; the memory transport and a NAT lab make the P2P parts testable without luck.
 | 
Layer | 
What | 
How
 | 
Unit | 
Codec round-trips, filter matching, policy engine, HLC and LWW merge, STUN/TURN parsing | 
bun test per package; STUN vectors from RFC 5769
 | 
Simulation | 
Topology, state sync, resume, chunking under latency, loss and partitions | 
Memory transport + seeded simulator; deterministic replays
 | 
Nostr conformance | 
Publish, query, replaceable semantics, AUTH, COUNT, deletion, expiry, search, negentropy | 
Own NIP-by-NIP suite against the relay, plus nak smoke runs and nostr-tools as a client
 | 
TURN interop | 
Allocation, permissions, channels, credentials over UDP, TCP, TLS | 
coturn turnutils_uclient in CI; Chromium, Firefox and WebKit with iceTransportPolicy: 'relay'
 | 
NAT lab | 
Direct vs. TURN vs. data-relay ladder under real NAT types | 
Compose with Linux network namespaces and nftables (cone and symmetric NAT); Linux CI only
 | 
E2E | 
Every demo screen with two or more peers; calls with fake media | 
Playwright, multiple browser contexts, --use-fake-device-for-media-stream
 | 
Load | 
1k subscriptions and 500 events/s on the relay; 50 TURN allocations at 2 Mbps; 50 headless peers in one room | 
Studio's peer spawner reused as a script; soak runs nightly
 | 
Security | 
Parser robustness, dependency audit, release integrity | 
fast-check fuzzing of STUN/TURN and filter parsers; signed binaries and provenance on npm
A PR is mergeable when its phase gate and the suites above pass; flaky WebRTC tests are quarantined with a ticket, never retried into green.
## Deployment and operations
The reference relay runs on one EU VPS with a public IPv4 and IPv6 (4 vCPU / 8 GB is enough to start); TURN needs that direct public address, so nothing in front of it proxies UDP.
 | 
Port | 
Protocol | 
Use
 | 
443 | 
TCP | 
HTTPS, WSS (Nostr, admin, data relay, Blossom), turns: over TLS
 | 
3478 | 
UDP + TCP | 
STUN and turn:
 | 
5349 | 
TCP | 
turns: when a proxy owns 443
 | 
50000–50100 | 
UDP | 
TURN relayed allocations (configurable range; widen for more peers)
 | 
80 | 
TCP | 
ACME challenge and redirect, only when Caddy fronts the relay
Install paths. bunx beamhop relay init writes beamhop-relay.toml, a systemd unit and the data directory, then prints the bootstrap token. Docker: docker run -p 443:443 -p 3478:3478 -p 3478:3478/udp -p 50000-50100:50000-50100/udp -v beamhop:/data ghcr.io/beamhop/relay. A Compose file with Caddy for ACME is in the docs.
TLS. v1 reads cert and key files and reloads on change; with Caddy in front, Caddy terminates 443 and the relay keeps turns: on 5349. The relay never sits behind Cloudflare's proxy.
Data. /data holds nostr.db, admin.db and blobs/; nightly VACUUM INTO backups with 14-day retention and optional upload to S3-compatible storage; migrations run on boot and refuse to downgrade.
Monitoring. /metrics for Prometheus; a Grafana dashboard JSON ships in the repo; built-in alerts for disk above 80%, TURN quota exhaustion, relay error rate and certificate expiry, surfaced in the admin overview and optionally by email.
Security. Runs as a non-root user with systemd hardening; per-IP rate limits on every listener; NIP-42 required for writes on private realms; IP bans from the admin UI; audit log for every admin action.
Upgrades. Replace the binary or pull the image and restart; config and data are forward-compatible within a major version.
## Risks and open questions
The TURN engine is the one piece that can sink the schedule; everything else is scope, and scope has a cut order.
 | 
Risk | 
Why it bites | 
Mitigation
 | 
TURN in TypeScript | 
RFC edge cases; per-packet UDP throughput in Bun is unmeasured | 
RFC 5769 vectors and coturn interop in CI; benchmark Bun.udpSocket in week 10 before building on it; fallback is pion/turn behind the same admin API
 | 
Everything in v1 | 
20 weeks assumes no surprises | 
Gates per phase; 0.x releases from phase 1; phase 6 extras are the first cut
 | 
NIP-77 negentropy | 
Fingerprint math and an id/time index that must match other relays | 
Port the reference implementation; cross-test against strfry
 | 
WebRTC quirks | 
Safari data channels, mobile backgrounding, ICE restarts | 
WebKit in Playwright; resume semantics designed in phase 1, not bolted on
 | 
Public relays for the demo | 
Rate limits, outages, relays dropping ephemeral kinds | 
Three-relay fan-out, union adapter, "use your own relay" field
 | 
Lightning payments | 
Wallet custody and NWC reliability | 
NWC to a hosted wallet; invoice state machine with retries; one plan type at launch
 | 
AGPL on the relay | 
Some teams avoid AGPL | 
MIT library keeps apps unaffected; say so plainly in the docs
Final names: @beamhop/p2p vs @beamhop/core; CLI beamhop
GitHub org and Pages domain (user site vs. project site)
Default public relays for the demo (three, EU-friendly)
Realm addressing: URL path /a/<appId> vs. a tag on events
Schema layer: Standard Schema only, or a built-in minimal codec too
Blossom only, or NIP-96 compatibility as well
Start date, and whether the Studio moves after 1.0 if phase 3 slips