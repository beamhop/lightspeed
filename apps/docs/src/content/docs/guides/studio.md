---
title: Studio walkthrough
description: Attach Studio to a room and use the topology graph, inspector, timeline, fault injection and peer spawner.
sidebar:
  order: 6
---

:::caution[0.x, subject to change]
:::

Studio is a local web app for seeing what your room is doing. It is built on `@beamhop/p2p` itself:
every transport and relay it debugs is one it also uses.

```sh
bunx beamhop studio            # opens http://127.0.0.1:4710
```

## Attaching

**In-page bridge** (fastest, same machine). Enable devtools in your app during development:

```ts
const room = await createRoom({ /* … */ })
if (import.meta.env.DEV) room.devtools()     // BroadcastChannel('beamhop-devtools:<roomId>'); no network
```

Then open Studio from the same origin (as an iframe, the dev overlay or another tab), choose
**In-page bridge** and enter the room id. `room.devtools({ onIdentity })` lets your app react when
Studio's identity switcher asks the room to evaluate an identity.

**Observer peer** (across machines and phones). Studio joins the room as a peer through your
Beamhop relay (Nostr signaling on `<relay>/a/<appId>`, data on `<relay>/a/<appId>/data`), holding a
capability token with `debug`, calls `room.telemetry.observe()` and receives every peer's telemetry
on the reserved `__beamhop/telemetry` channel. From the **Attach** dialog Studio self-signs the
token, which rooms accept when they run with `policy: { dev: true }` during development. For other
rooms, construct `ObserverRoom` from `@beamhop/studio` with `appSecretKey` (Studio issues the token
for its own session key) or with a pre-issued `debugToken` plus that session's `secretKey`.

## Views

- **Topology graph.** Peers as nodes, links badged `direct` / `turn` / `relay` with RTT and bytes.
  The host is marked in star rooms.
- **Message inspector.** Every action, request and stream, decoded through your protocol's schemas.
  Filter by peer, action and direction.
- **Timeline.** Signaling, connection state transitions and messages on one track. Scrub to replay
  what a peer saw.
- **Connection detail.** Per-peer state machine, candidate pairs, channel buffer levels and resume
  history.
- **Relay health.** NIP-11 fetch, AUTH check, TURN credential mint plus a test allocation, and
  signaling RTT per relay.
- **Identity switcher.** Anonymous, Nostr or OIDC identities, checked against the room's admission
  policy (by the page's room over the bridge, or by re-joining as the observer).

## Fault injection

Add latency, packet loss, partitions or kill a peer. Against the memory/simulator transport the
faults are exact and replayable from a seed (the bridge applies them to the `MemoryHub`s behind the
room). Against live transports only `kill` and `partition` work: they drop the affected links and
the sessions resume afterwards.

## Peer spawner

Launch N headless Bun peers, each running `bun run <script>` with the room coordinates in the
environment (`ROOM`, `APP`, `RELAY`, `BEAMHOP_PEER_INDEX`, `BEAMHOP_PEER_COUNT`):

```ts title="bots/chatty.ts"
import { action, any, anonymous, createRoom, defineProtocol, relayTransport } from '@beamhop/p2p'
import { nostrSignaling } from '@beamhop/signaling-nostr'

const { ROOM, APP, RELAY, BEAMHOP_PEER_INDEX: index } = Bun.env
const room = await createRoom({
  appId: APP!,
  roomId: ROOM!,
  identity: anonymous(),
  signaling: nostrSignaling({ relays: [`${RELAY}/a/${APP}`] }),
  transports: [relayTransport({ url: `${RELAY}/a/${APP}/data` })],
  protocol: defineProtocol({ chat: action(any<{ text: string }>()) }),
  meta: { name: `bot ${index}` },
})
setInterval(() => void room.action('chat').send({ text: `bot ${index} says hi` }), 1000)
```

Use it for load tests (50 peers in one room is a phase gate) and chaos tests together with fault
injection.
