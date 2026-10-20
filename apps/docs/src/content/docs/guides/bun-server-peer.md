---
title: Bun server peer
description: Join rooms from a Bun process over the data relay, without WebRTC, as a host, bot or persistence layer.
sidebar:
  order: 2
---

:::caution[0.x, subject to change]
:::

A server peer is a regular room member that happens to run in Bun (or Node). Because the
[data relay](../../concepts/transports/) speaks plain WebSocket, a server peer needs **no WebRTC
polyfill**. Typical uses:

- an always-on **host** for a star room (authoritative game state, moderation),
- a **persistence** peer that snapshots shared state to disk and serves late joiners,
- a **bot** that answers requests or bridges to other systems.

## Prerequisites

A [Beamhop relay](../../relay/install/) with an app (realm), for example `my-app`. Browsers need the
relay transport too, so they can reach the server peer:

```ts
transports: [webrtcTransport({ iceServers }), relayTransport({ url: 'wss://relay.example/a/my-app/data' })]
```

## The server

```ts title="server.ts"
import { createRoom, nostr, relayTransport } from '@beamhop/p2p'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { protocol } from './protocol'

const room = await createRoom({
  appId: 'my-app',
  roomId: 'world-1',
  identity: nostr({ nsec: Bun.env.BOT_NSEC! }),   // stable pubkey so clients can trust it
  signaling: nostrSignaling({ relays: ['wss://relay.example/a/my-app'] }),
  transports: [relayTransport({ url: 'wss://relay.example/a/my-app/data' })],
  topology: { star: { host: 'self' } },
  protocol,
  meta: { name: 'world-1 host', role: 'server' },
})

const board = room.state.map<string>('board', {
  validate: (key, value, peer) => isLegalMove(key, value, peer),
})

// Persist and restore
const saved = Bun.file('board.json')
if (await saved.exists()) board.load(await saved.json())
setInterval(() => Bun.write('board.json', JSON.stringify(board.dump())), 10_000)

room.handle('roll', ({ sides }) => ({ value: 1 + Math.floor(Math.random() * sides) }))

process.on('SIGTERM', async () => {
  await room.leave()
  process.exit(0)
})
```

Run it with `bun server.ts`. Clients configure `topology: { star: { host: '<server pubkey>' } }`
so handoff never moves authority to a browser.

## Many rooms per process

`createRoom` is cheap; one process can join hundreds of rooms. Share one signaling adapter and one
relay transport across rooms to reuse WebSocket connections.

## Load testing

Studio's **peer spawner** launches N headless Bun peers over the relay transport running a script.
The same code path makes load tests realistic: see the [Studio walkthrough](../studio/).
