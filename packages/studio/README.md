# @beamhop/studio

The Beamhop developer Studio: a local web app that attaches to a room and renders its telemetry
bus — topology, messages, timeline with replay, connection internals, fault injection, a peer
spawner, relay health and an identity switcher. MIT.

```sh
bunx beamhop studio                     # via the CLI
bun run --cwd packages/studio build     # build the app into dist/
bun packages/studio/src/server.ts       # serve dist/ on http://127.0.0.1:4710 and open the browser
bun packages/studio/src/server.ts --port 0 --no-open
```

The server binds to `127.0.0.1` by default because the spawner runs local scripts. Mutating API
calls require the `x-beamhop-studio: 1` header (cross-site pages cannot send it without a
preflight the server never approves).

## Attach modes

| Mode | Status | How it works |
|---|---|---|
| **Simulated** (default) | done | `SimulatedRoom` drives a seeded `SimEngine`: N fake peers with announce/offer/answer/candidate signaling, direct/TURN/relay paths (and `relayFirst` migration), ICE-restart path changes, away/back resumes, RTT, per-channel bytes, chat/cursor/presence/state/file messages with progress. Same seed + same calls ⇒ identical telemetry. Mesh or star (host, handoff when the host dies). |
| **In-page bridge** | done | `BridgeRoom` listens on `BroadcastChannel("beamhop-devtools:<roomId>")`. Accepts bare `TelemetryEvent`s or `{ type: 'telemetry', source, event }`, plus `{ type: 'hello', self, peers? }`, `{ type: 'peers', peers }`, `{ type: 'connection-info', source, peer, info }`. Posts `{ type: 'studio-hello' }`, `{ type: 'fault', id, fault }`, `{ type: 'clear-fault', id }`, `{ type: 'identity', identity }`, `{ type: 'connection-info?', source, peer }` back for the page's dev hook. |
| **Observer peer** | placeholder | `ObserverRoom` reports itself unavailable. See the TODO in `src/adapters/observer.ts`: join with `createRoom` + a `debug` capability token and read `__beamhop/telemetry`. |

Every mode implements the narrow `StudioRoom` interface in `src/room-adapter.ts` (join/leave,
history/subscribe to `StudioEvent { seq, source, event: TelemetryEvent }`, peers, inject/clear
faults, connection info, set identity). Wiring the real `Room` means writing one more adapter.

## Views

- **Topology** — SVG force layout; links coloured and badged by path (direct / TURN / relay) with
  RTT and bytes, away links blink, the star host is marked; side panel with path counts, average
  RTT, resumes and a message-rate sparkline.
- **Messages** — inspector filtered by peer, action, direction and payload text; payloads decoded
  to JSON (bytes, bigint, maps and cycles handled).
- **Timeline** — signaling, connection and message lanes; click the timeline or drag the global
  scrubber to replay any instant. Replay is `replayAt(events, t)`, a pure reducer over the log;
  every view (topology, inspector, connection detail) follows the cursor.
- **Connections** — per-side state machine with visit counts, state history, path / candidate
  pairs, channel buffer levels and resume (away → back) history.
- **Faults** — latency, loss, partition (pick side B) and kill → `StudioRoom.injectFault`;
  active faults can be cleared (clearing a kill revives the simulated peer).
- **Spawner** — spawn into the simulation, or launch N headless Bun peers through the server:
  `POST /api/spawn { script, count, room, app, relay, env?, args? }` runs
  `bun run <script>` with `ROOM`, `APP`, `RELAY`, `BEAMHOP_PEER_INDEX`, `BEAMHOP_PEER_COUNT`.
  `GET /api/spawn` lists processes with their last output lines, `DELETE /api/spawn[/:id]` kills.
- **Relay health** — NIP-11 fetch, NIP-42 AUTH challenge, signaling RTT (REQ → EOSE), TURN
  credential mint (`POST /a/<app>/turn-credentials`) and, in the browser, a TURN allocation test
  (relay-only ICE gathering). Runs server-side via `POST /api/health` when available (no CORS),
  otherwise in the browser. Failures are reported per check, never thrown.
- **Identity** — anonymous (fresh session key), Nostr (nsec/hex signs a session attestation
  locally; npub or NIP-07 gives an unsigned one) and OIDC (decodes the attestation JWS) → the
  room's admission decision. The simulated room has a configurable admission policy.

## Library API

`import { … } from '@beamhop/studio'` exposes the adapters, `SimEngine` / `generateEvents`,
the reducers (`reduceTopology`, `buildTopology`, `replayAt`, `buildTracks`, `filterMessages`,
`connectionHistory`, `forceLayout`), the health checks and identity helpers.
`import { startStudioServer, main } from '@beamhop/studio/server'` for the CLI.

## Development

```sh
bun test packages/studio              # reducers, simulator determinism, bridge, spawner, server, app smoke test
bunx tsc --noEmit -p packages/studio
cd packages/studio && bunx vite build # or `bunx vite` with the server running for /api
```

Tests bind local servers on port 0 (a fake relay for health checks and the Studio server, which
spawns real `bun` subprocesses).
