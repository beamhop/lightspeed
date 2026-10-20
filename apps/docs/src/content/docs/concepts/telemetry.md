---
title: Telemetry
description: The telemetry bus that powers the demo's Debug drawer and Studio.
sidebar:
  order: 7
---

:::caution[0.x, subject to change]
:::

Every room has a local **telemetry bus**. It is off in production unless you enable it, costs
nothing when nobody subscribes, and never leaves the device unless a peer with the `debug`
capability (Studio) asks for it.

```ts
const room = await createRoom({ /* … */ telemetry: true })

const stop = room.telemetry.subscribe((event) => {
  if (event.type === 'path') console.log(event.peer, 'now on', event.path)
})
```

## Events

```ts
type TelemetryEvent =
  | { type: 'signal'; at; direction: 'in' | 'out'; kind; peer? }       // announces, offers, ICE…
  | { type: 'connection'; at; peer; state; path? }                     // connecting → connected, away, back
  | { type: 'path'; at; peer; path: 'direct' | 'turn' | 'relay' | 'memory'; candidatePair? }
  | { type: 'bytes'; at; peer; channel; sent; received }               // cumulative per channel
  | { type: 'rtt'; at; peer; ms }
  | { type: 'message'; at; peer; direction; action; size; payload? }   // payload only with debug
  | { type: 'progress'; at; peer; streamId; sent; total }              // chunked transfers
  | { type: 'peer'; at; peer; event: 'join' | 'leave' }
```

`at` is milliseconds since the epoch. The shapes are defined in `packages/p2p/src/types.ts`.

## Who reads it

- **The demo's Debug drawer** shows connection type per peer, bytes per channel, RTT and the last
  signaling events.
- **Studio** renders the topology graph, the message inspector and the timeline from the same
  events. It attaches either in-page (`room.devtools()` exposes a `BroadcastChannel`) or as an
  observer peer that receives telemetry on the reserved `__beamhop/telemetry` channel.
- **Your own dashboards**: forward selected events to your analytics. Do not forward `message`
  payloads; they contain user data.

## Privacy

`message` events include payloads only when telemetry runs with `{ payloads: true }` (Studio sets
this in development). Remote telemetry requires a capability token with `debug` signed by the app
key, unless the room runs with `dev: true`.
