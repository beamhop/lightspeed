---
title: Signaling
description: How peers find each other over Nostr relays, what the relays can see, and how to plug in your own adapter.
sidebar:
  order: 2
---

:::caution[0.x, subject to change]
:::

Signaling is how two peers that know nothing about each other's addresses exchange enough to open
a connection. Beamhop uses **Nostr relays** for this by default: they are plentiful, free, speak a
simple WebSocket protocol and forward ephemeral events without storing them.

## The adapter interface

```ts
interface SignalingAdapter {
  announce(topic: Hex, content: string): Promise<void>          // room-wide, kind 20100
  send(topic: Hex, to: Hex, content: string): Promise<void>     // directed, kind 20101
  subscribe(topic: Hex, onSignal: (s: Signal) => void): Unsubscribe
  status?(): SignalingStatus[]                                   // per-relay state for UIs
  close(): Promise<void>
}
```

The room encrypts payloads before they reach the adapter, so an adapter only moves opaque strings.
That makes it easy to write one over your own WebSocket server, a MQTT broker or a test bus.

Built-in adapters:

| Adapter | Package | Use |
|---|---|---|
| `nostrSignaling({ relays })` | `@beamhop/signaling-nostr` | Default. Public relays or your own relay's realm |
| `unionSignaling(a, b, ...)` | `@beamhop/p2p` | Fans out to several adapters for redundancy; de-duplicates |
| `memorySignaling(createSignalingHub())` | `@beamhop/p2p` | Tests and the simulator |

## What goes over the relays

1. **Topic.** `sha256("beamhop/v1" ‖ appId ‖ roomId ‖ password)` in hex, carried as a `t` tag so
   every relay can index it.
2. **Announce** (kind 20100): AES-256-GCM encrypted with the **room key** (HKDF over the same
   inputs). Contains the session pubkey, attestations, `meta` and an optional capability token.
   TTL 30 seconds, re-sent every 20.
3. **Directed signal** (kind 20101): tagged with the topic and the recipient (`p`), NIP-44 encrypted
   to the recipient. Carries WebRTC offers, answers, ICE candidates, ICE restarts or
   `relay-connect`.

For each pair, the peer with the lower pubkey initiates, so two peers that discover each other at
the same time never both send offers.

A relay operator learns: that some room with this topic exists, which session pubkeys are in it, and
when and how much they signal. Not the room name, not peer metadata, not SDP.

## Choosing relays

- Use **three or more** relays. Public relays rate-limit, restart and sometimes drop ephemeral kinds;
  the adapter publishes to all and subscribes to all, so one healthy relay is enough.
- Prefer relays near your users. The demo uses `relay.damus.io`, `nos.lol` and `relay.primal.net`.
- For production, add your own relay's **realm** (`wss://relay.example/a/<appId>`). Realms can
  require NIP-42 AUTH for kinds 20100/20101, apply rate limits per pubkey and never mix your traffic
  with the public relay.

```ts
nostrSignaling({
  relays: ['wss://relay.example/a/my-app', 'wss://nos.lol', 'wss://relay.damus.io'],
})
```

## Timing

Discovery takes one announce round: a newcomer announces immediately on join and existing peers
reply with their own announce, so typical join-to-offer latency is one relay round trip. Events older
than 30 s are ignored, which requires roughly synchronized clocks (see
[Troubleshooting](../../troubleshooting/)).
