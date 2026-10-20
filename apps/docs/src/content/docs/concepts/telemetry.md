---
title: Telemetry
description: The telemetry bus that powers the demo's Debug drawer and Studio.
sidebar:
  order: 7
---

:::caution[0.x, subject to change]
:::

Every room has a local **telemetry bus**. It is on by default (`telemetry: false` turns it off),
keeps a short ring buffer of recent events for late subscribers, and never leaves the device unless
a peer with the `debug` capability (Studio) asks for it.

```ts
const room = await createRoom({ /* … */ })

const stop = room.telemetry.subscribe(
  (event) => {
    if (event.type === 'path') console.log(event.peer, 'now on', event.path)
  },
  { replay: true },   // deliver the recent history first
)
```

## Events

```ts
type TelemetryEvent =
  | { type: 'signal'; at; direction: 'in' | 'out'; kind; peer? }       // announces, offers, ICE…
  | { type: 'connection'; at; peer; state; path? }                     // connecting → connected, away, back
  | { type: 'path'; at; peer; path: 'direct' | 'turn' | 'relay' | 'memory'; candidatePair? }
  | { type: 'bytes'; at; peer; channel; sent; received }               // cumulative per channel
  | { type: 'rtt'; at; peer; ms }
  | { type: 'message'; at; peer; direction; action; size; payload? }   // decoded payload (see Privacy)
  | { type: 'progress'; at; peer; streamId; sent; total }              // chunked transfers
  | { type: 'peer'; at; peer; event: 'join' | 'leave' }
  | { type: 'error'; at; peer?; code; message }                        // handshake, invalid-payload…
  | { type: 'host'; at; host }                                          // star host changes
```

`at` is milliseconds since the epoch. The shapes are defined in `packages/p2p/src/types.ts`.

## Who reads it

- **The demo's Debug drawer** shows connection type per peer, bytes per channel, RTT and the last
  signaling events.
- **Studio** renders the topology graph, the message inspector and the timeline from the same
  events. It attaches either in-page (`room.devtools()` speaks Studio's protocol on
  `BroadcastChannel('beamhop-devtools:<roomId>')`) or as an observer peer that calls
  `room.telemetry.observe()` and receives telemetry on the reserved `__beamhop/telemetry` channel
  (`room.telemetry.subscribeRemote((from, event) => …)`).
- **Your own dashboards**: forward selected events to your analytics. Do not forward `message`
  payloads; they contain user data.

## Privacy

Local `message` events include the decoded payload unless the room is created with
`telemetryPayloads: false`. Telemetry forwarded to an observer never includes payloads. Peers
honour `observe()` only from a peer whose capability token carries `debug` and verifies against
the room policy (a trusted issuer, the star host, or any signer when the room runs with
`policy.dev: true`).
