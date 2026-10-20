---
title: Topologies
description: Full mesh for small rooms and host-authoritative star for games and shared documents.
sidebar:
  order: 4
---

:::caution[0.x, subject to change]
:::

A topology decides **who connects to whom** and **who is authoritative**.

## Mesh

```ts
createRoom({ /* … */ topology: 'mesh' })   // default
```

Every peer connects to every other peer. Messages go straight to their recipients, there is no single
point of failure, and latency is one hop. The cost grows quadratically: `n` peers hold `n − 1`
connections each, and a broadcast is sent `n − 1` times. Mesh is intended for **up to about 12
peers**; for calls with video, fewer.

## Star (host-authoritative)

```ts
createRoom({ /* … */ topology: { star: {} } })                 // host = lowest pubkey
createRoom({ /* … */ topology: { star: { host: hostPubkey } } }) // explicit host
```

Every peer connects only to the **host**. The host relays broadcasts and is the authority for shared
state: it orders writes, answers snapshot requests from late joiners and can validate actions before
re-broadcasting them (anti-cheat in games, permission checks in documents).

- **Host election.** By default the peer with the lowest session pubkey is host. All peers compute
  the same answer from the same peer list, so no election messages are needed.
- **Handoff.** When the host leaves, the next-lowest pubkey becomes host, peers reconnect to it and
  the new host requests the latest state from whoever has it.
- **Server host.** A [Bun server peer](../../guides/bun-server-peer/) makes a stable, always-on host:
  set `host` to its pubkey.

```ts
room.host                 // current host pubkey
room.isHost               // boolean
room.onHostChange((pubkey) => { /* … */ })
```

## Choosing

| | Mesh | Star |
|---|---|---|
| Peers | ≤ 12 | Dozens (bounded by the host's uplink) |
| Latency | 1 hop | 2 hops between non-hosts |
| Authority | None (CRDT-style merge) | Host |
| Failure | Any peer can leave | Host leave triggers handoff |

Relaying through third peers (a mesh where some peers forward for others) is planned for v2.
