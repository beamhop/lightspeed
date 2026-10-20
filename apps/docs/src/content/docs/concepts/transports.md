---
title: Transports and the ladder
description: WebRTC, TURN and the Beamhop data relay, and how the connection manager climbs between them.
sidebar:
  order: 3
---

:::caution[0.x, subject to change]
:::

A **transport** turns "I want to talk to pubkey X" into a `Connection` with channels. The
**connection manager** decides which transport to use for each pair of peers and keeps the session
alive across network changes.

```ts
interface Transport {
  readonly name: 'webrtc' | 'relay' | 'memory' | (string & {})
  connect(remote: Hex, opts: { initiator: boolean; pipe: SignalPipe; local: Identity }): Promise<Connection>
}
```

| Transport | Import | Runs on | Path types |
|---|---|---|---|
| `webrtcTransport({ iceServers })` | `@beamhop/p2p/webrtc` | Browsers (and Node/Bun with a WebRTC polyfill) | `direct`, `turn` |
| `relayTransport({ url })` | `@beamhop/p2p` | Everywhere with WebSocket | `relay` |
| `memoryTransport(createMemoryHub())` | `@beamhop/p2p` | In-process (tests, simulator) | `memory` |

## The ladder

For each pair the manager tries, in order:

1. **direct**: WebRTC with host and STUN (server-reflexive) candidates. Free, lowest latency.
2. **turn**: WebRTC through a TURN server. Works through symmetric NATs; costs relay bandwidth.
3. **relay**: the Beamhop data relay (`wss://relay.example/a/<appId>/data`). Works wherever HTTPS
   works, including UDP-hostile networks. Frames are end-to-end encrypted with the pair session key.

```ts
createRoom({
  // …
  transports: [
    webrtcTransport({ iceServers: [...stun, ...turnFromYourRelay] }),
    relayTransport({ url: 'wss://relay.example/a/my-app/data' }),
  ],
})
```

### relayFirst

Waiting for ICE to fail before falling back can take 10–30 seconds. With `relayFirst: true` the
manager connects through the data relay immediately (one round trip after discovery), runs ICE in
parallel, then **migrates** channels to the direct path once it is up. The application sees one
`onPeerJoin` and uninterrupted channels.

```ts
createRoom({ /* … */ relayFirst: true })
```

## Sessions, away and back

Sessions are keyed by identity, not by connection. When a connection drops (Wi-Fi to cellular, a
backgrounded tab) the peer's `state` becomes `'away'` instead of it leaving, the manager re-runs the
ladder and the peer is `'connected'` again on success (telemetry `connection` events `away` and
`back`). Messages sent on reliable channels carry sequence numbers and acknowledgements, so delivery
is at-least-once across the gap and receivers de-duplicate. A peer that stays away longer than
`timeouts.resumeWindowMs` (30 s) is reported as left.

```ts
room.onPeerUpdate((peer) => (peer.state === 'away' ? markIdle(peer) : markActive(peer)))
```

## Getting TURN credentials

A Beamhop relay mints short-lived TURN credentials per app:

```ts
const res = await fetch('https://relay.example/a/my-app/turn-credentials', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },   // from your backend, or a NIP-98 header
})
const { iceServers, ttl } = await res.json()
```

Never ship the API key to browsers. Call the endpoint from your backend, or let clients
authenticate with a NIP-98 signed event if your app's policy allows it. Username and credential
formats are in the [protocol spec](../../protocol/#10-turn-credentials).

## Which path am I on?

`room.telemetry` emits `path` events with the candidate pair type; the demo's Debug drawer and
Studio's topology graph show them per peer. See [Telemetry](../telemetry/).
