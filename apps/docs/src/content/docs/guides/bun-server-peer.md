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
import { anonymous, createRoom, getPublicKey, relayTransport } from '@beamhop/p2p'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { protocol } from './protocol'

// A fixed session key gives the server a stable pubkey, so clients can name it as the star host.
const secretKey = Bun.env.SERVER_SECRET_KEY!            // 64-char hex
const serverPubkey = getPublicKey(secretKey)

const room = await createRoom({
  appId: 'my-app',
  roomId: 'world-1',
  identity: anonymous({ secretKey }),
  signaling: nostrSignaling({ relays: ['wss://relay.example/a/my-app'] }),
  transports: [relayTransport({ url: 'wss://relay.example/a/my-app/data' })],
  topology: { star: { host: serverPubkey } },
  protocol,
  meta: { name: 'world-1 host', role: 'server' },
})

const board = room.state.map<string>('board')

// Persist and restore: replay the saved snapshot as writes, save on every change (debounced).
const saved = Bun.file('board.json')
if (await saved.exists()) {
  for (const [k, v] of Object.entries((await saved.json()) as Record<string, string>)) board.set(k, v)
}
let timer: ReturnType<typeof setTimeout> | undefined
board.subscribe(() => {
  clearTimeout(timer)
  timer = setTimeout(() => Bun.write('board.json', JSON.stringify(board.toObject())), 1000)
})

// Authoritative writes go through a request the host checks.
room.request('move').handle(({ key, value }, from) => {
  if (!isLegalMove(key, value, from)) return { ok: false }
  board.set(key, value)
  return { ok: true }
})

process.on('SIGTERM', async () => {
  await room.leave()
  process.exit(0)
})
```

Run it with `bun server.ts`. Clients configure `topology: { star: { host: '<server pubkey>' } }`
so handoff never moves authority to a browser. To vouch for the server with your Nostr key instead,
use `nostr({ nsec })`: peers then see a verified `nostr` attestation, but the session pubkey is fresh
on every start, so pin the host by attestation in `policy.admit` rather than by pubkey.

## Many rooms per process

`createRoom` is cheap; one process can join many rooms, each with its own `Room` handle.

## Load testing

Studio's **peer spawner** launches N headless Bun peers over the relay transport running a script.
The same code path makes load tests realistic: see the [Studio walkthrough](../studio/).
