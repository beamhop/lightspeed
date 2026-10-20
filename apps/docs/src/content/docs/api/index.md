---
title: API reference
description: Generated API reference for @beamhop/p2p, @beamhop/signaling-nostr and @beamhop/react.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
The reference is generated from TSDoc comments in the package sources. Until 1.0, minor releases may
change it.
:::

The **Reference** section in the sidebar is generated with [TypeDoc](https://typedoc.org) through
[starlight-typedoc](https://github.com/HiDeoo/starlight-typedoc) on every docs build, from:

| Package | Entry point |
|---|---|
| `@beamhop/p2p` | `packages/p2p/src/index.ts` (plus `@beamhop/p2p/wire` and the shared types) |
| `@beamhop/signaling-nostr` | `packages/signaling-nostr/src/index.ts` |
| `@beamhop/react` | `packages/react/src/index.ts` |

If the generated section is missing, the build ran with `DOCS_TYPEDOC=0` or TypeDoc could not load
the sources. Generate the pages locally with:

```sh
bun run --cwd apps/docs api     # writes Markdown into src/content/docs/api/reference/
bun run --cwd apps/docs dev
```

## Most used entry points

| Import | What |
|---|---|
| `createRoom(options)` from `@beamhop/p2p` | Joins a room; returns the `Room` handle |
| `defineProtocol(def)`, `action(schema, opts?)`, `request(req, res)` from `@beamhop/p2p` | Declares typed actions and requests |
| `anonymous()`, `nostr()`, `oidc()` from `@beamhop/p2p` | Identity providers |
| `webrtcTransport(opts)` from `@beamhop/p2p/webrtc` | WebRTC transport (browsers) |
| `relayTransport(opts)` from `@beamhop/p2p` | Beamhop data relay transport (browsers, Bun, Node) |
| `memoryTransport(createMemoryHub())`, `memorySignaling(createSignalingHub())` from `@beamhop/p2p` | In-process transport and signaling for tests and the simulator |
| `nostrSignaling({ relays })` from `@beamhop/signaling-nostr` | Default signaling adapter |
| `roomTopic`, `roomKey`, `encodeFrame`, `turnPassword`… from `@beamhop/p2p/wire` | Wire primitives, see the [protocol spec](../protocol/) |
| `RoomProvider`, `useRoom`, `usePeers`, `useAction`, `useRequest`, `useSharedState`, `useSharedLog`, `useTelemetry` from `@beamhop/react` | React bindings |

## Shared types

The contracts every package builds against live in `packages/p2p/src/types.ts`: `Identity`,
`Attestation`, `SignalingAdapter`, `Transport`, `Connection`, `Channel`, `Reliability`, `PathType`
and `TelemetryEvent`. Implement `SignalingAdapter` or `Transport` to plug your own signaling or
transport into a room.
