---
title: Migrating from Trystero
description: Map Trystero's joinRoom, makeAction and peer events onto Beamhop.
sidebar:
  order: 7
---

:::caution[0.x, subject to change]
:::

[Trystero](https://github.com/dmotz/trystero) pioneered serverless WebRTC rooms over public
signaling networks, and Beamhop's default Nostr strategy will feel familiar. The main differences:
Beamhop has typed, validated protocols, real identities and attestations, a transport ladder with
TURN and a data relay, star topologies, state sync and a self-hostable relay.

## Concept map

| Trystero | Beamhop |
|---|---|
| `joinRoom({ appId }, roomId)` | `createRoom({ appId, roomId, identity, signaling, transports, protocol })` |
| Strategy import (`trystero/nostr`) | `nostrSignaling({ relays })` from `@beamhop/signaling-nostr` |
| `config.password` | `password` (also changes the topic and room key) |
| `selfId` | `room.self.pubkey` (a secp256k1 pubkey, stable with `anonymous({ persist: true })`) |
| `room.onPeerJoin(id => …)` | `room.onPeerJoin(peer => …)` with `peer.pubkey`, `peer.meta`, `peer.attestations` |
| `room.onPeerLeave` | `room.onPeerLeave`, plus `onPeerUpdate` (`peer.state` is `'away'` during transient drops) |
| `room.getPeers()` | `room.peers` |
| `const [send, get] = room.makeAction('chat')` | `const chat = room.action('chat')`; `chat.send()`, `chat.onMessage((data, from) => …)` |
| `send(data, targetPeers)` | `chat.send(data, { to: pubkey \| pubkey[] })` |
| Binary + metadata actions, progress callback | `room.sendFile(blob, { to, name, onProgress })` and `room.onFile(file => …)` |
| `room.addStream(stream)` / `onPeerStream` | Not in the room API yet; see [calls](../calls/) for the `RTCPeerConnection`-over-actions pattern |
| `room.ping(id)` | `peer.rttMs`, `rtt` telemetry events, or a `request` with your own ping |
| `config.rtcConfig.iceServers` with TURN | `webrtcTransport({ iceServers })` (or `createRoom({ iceServers })`), credentials from your Beamhop relay |
| `room.leave()` | `room.leave()` |

## Step by step

1. **Declare a protocol.** List every action name you passed to `makeAction` as
   `action(schema, { reliability })`. `reliability: 'unreliable'` suits Trystero-style cursor actions;
   `any<T>()` is a pass-through schema while you migrate.
2. **Replace `joinRoom`.** Pick `anonymous({ persist: true })` to keep stable ids across reloads.
3. **Replace peer ids.** Trystero ids were random strings; Beamhop ids are 64-char hex pubkeys. If
   you stored ids, key by `peer.meta` or by a Nostr/OIDC attestation instead.
4. **Replace action tuples** with `room.action(name)` objects.
5. **Keep public relays at first,** then add your own relay realm for reliability.

Trystero and Beamhop rooms do not interoperate: topics, event kinds and encryption differ, so migrate
all clients of a room together.
