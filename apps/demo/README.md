# Beamhop demo (`apps/demo`)

Preact + Vite demo client for `@beamhop/p2p`, published at `/lightspeed/demo/` on GitHub Pages.

Screens: **Lobby** (create/join by link or QR, relay status, anonymous or NIP-07 identity),
**Room** (presence + chat on a reliable channel), **Cursors** (shared canvas on an unreliable
channel with RTT), **Files** (drag-and-drop with per-peer progress), **Call** (audio/video, mute,
camera switch, screen share, path per peer) and a **Debug drawer** (path, state, RTT and bytes per
channel per peer, last signaling events, "use your own relay").

Defaults: signaling over `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`; ICE
with `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`; no TURN.

## Library isolation

All P2P code sits behind the `DemoRoom` interface in `src/p2p.ts`. Two implementations:

- `src/net/beamhop.ts`: the real stack (`createRoom`, `anonymous`, `defineProtocol` from
  `@beamhop/p2p`, `webrtcTransport` from `@beamhop/p2p/webrtc`, `nostrSignaling` from
  `@beamhop/signaling-nostr`). Modules are loaded dynamically and checked at runtime.
- `src/net/local.ts`: a `BroadcastChannel` fallback. Tabs of the same browser that open the same
  room talk over it; calls use real `RTCPeerConnection`s with the channel as the signaling pipe.

`?local=1` forces the fallback. Without it the demo tries the real stack and falls back (with a
notice) if the library is not built yet. `vite.config.ts` stubs missing library entry points so the
build never fails on them.

## Scripts

```sh
bun run --cwd apps/demo dev        # http://localhost:5173/lightspeed/demo/?local=1
bun run --cwd apps/demo build      # dist/
bun run --cwd apps/demo test       # unit tests for the local fallback (bun test)
cd apps/demo && bunx playwright install chromium && bunx playwright test   # e2e
```

The e2e suite (`e2e/*.e2e.ts`) runs the local mode in two tabs of one browser context, because
`BroadcastChannel` does not cross browser contexts. A two-context test over the public relays runs
with `DEMO_E2E_NETWORK=1`.

MIT licensed.
