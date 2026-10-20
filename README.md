# Beamhop Lightspeed

Peer-to-peer rooms for the web, plus the infrastructure to run them yourself.

| Package | What |
|---|---|
| `@beamhop/p2p` | Typed P2P rooms: identity, Nostr signaling, WebRTC/relay transports, mesh/star, channels, state sync |
| `@beamhop/signaling-nostr` | Nostr signaling adapter |
| `@beamhop/react` | React bindings: `RoomProvider`, `useRoom`, `usePeers`, `useAction`, `useRequest`, `useSharedState`, `useSharedLog`, `useTelemetry` |
| `@beamhop/relay` | One Bun process: Nostr relay, TURN, data relay, admin UI, Blossom, Lightning |
| `@beamhop/nostr-relay` | Embeddable Nostr relay engine on SQLite |
| `@beamhop/turn` | STUN/TURN server in TypeScript |
| `@beamhop/relay-admin` | Admin SPA |
| `@beamhop/studio` | Developer Studio |
| `@beamhop/ui` | Design tokens and components |
| `beamhop` | CLI: `beamhop relay`, `beamhop studio`, `beamhop init` |

See `docs/PLAN.md` for the full design. Library, Studio, UI, CLI and apps are MIT; the relay and its engines are AGPL-3.0.
