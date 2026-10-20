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
bunx beamhop studio            # opens http://localhost:4545
```

## Attaching

**In-page bridge** (fastest, same machine). Enable devtools in your app during development:

```ts
const room = await createRoom({ /* … */ telemetry: { payloads: true } })
if (import.meta.env.DEV) room.devtools()     // exposes a BroadcastChannel; no network
```

Then open Studio from the same origin (as an iframe or the dev overlay) and pick the room.

**Observer peer** (across machines and phones). Studio joins the room as a peer holding a capability
token with `debug`, and receives telemetry on the reserved `__beamhop/telemetry` channel. Sign the
token with your app key, or run the room with `dev: true` during development so any token works.
Paste the `appId`, `roomId` and signaling relays in Studio's **Attach** dialog.

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
- **Identity switcher.** Re-join as anonymous, Nostr or OIDC to test admission policies.

## Fault injection

Add latency, packet loss, partitions or kill a peer. Against the memory/simulator transport the
faults are exact and replayable from a seed; against live WebRTC they go through a dev-only hook on
the channels.

## Peer spawner

Launch N headless Bun peers over the relay transport, each running a script:

```ts title="bots/chatty.ts"
export default async function (room, { index }) {
  const chat = room.action('chat')
  setInterval(() => chat.send({ text: `bot ${index} says hi` }), 1000)
}
```

Use it for load tests (50 peers in one room is a phase gate) and chaos tests together with fault
injection.
