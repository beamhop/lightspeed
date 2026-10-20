---
title: A room in five minutes
description: Create a peer-to-peer room on public Nostr relays and public STUN, with a typed chat action.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
The API below follows the v1 design. Names and options may still change before 1.0.
:::

This page builds the smallest useful Beamhop app: every browser tab that opens the page joins the
same room, sees who else is there, and can send typed chat messages. No server of yours is involved:
peers find each other through public Nostr relays and connect directly with WebRTC.

## 1. Install

```sh
bun add @beamhop/p2p @beamhop/signaling-nostr zod
# or: npm install @beamhop/p2p @beamhop/signaling-nostr zod
```

Any [Standard Schema](https://standardschema.dev) library works for message validation; the
examples use Zod.

## 2. Declare a protocol

A protocol lists every message your peers exchange. Each entry has a schema and a reliability mode.

```ts title="protocol.ts"
import { defineProtocol } from '@beamhop/p2p'
import { z } from 'zod'

export const protocol = defineProtocol({
  chat: {
    schema: z.object({ text: z.string().min(1).max(2000) }),
    reliability: { mode: 'reliable' },
  },
})
```

## 3. Join a room

```ts title="main.ts"
import { anonymous, createRoom } from '@beamhop/p2p'
import { webrtcTransport } from '@beamhop/p2p/webrtc'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { protocol } from './protocol'

const room = await createRoom({
  appId: 'my-first-app',          // namespaces your rooms
  roomId: 'lobby',                // peers with the same appId + roomId meet
  identity: anonymous(),          // ephemeral secp256k1 session key
  signaling: nostrSignaling({
    relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
  }),
  transports: [
    webrtcTransport({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    }),
  ],
  protocol,
  meta: { name: prompt('Your name?') ?? 'anon' },
})

room.onPeerJoin((peer) => console.log(`${peer.meta.name} joined`))
room.onPeerLeave((peer) => console.log(`${peer.meta.name} left`))

const chat = room.action('chat')
chat.on(({ text }, peer) => console.log(`${peer.meta.name}: ${text}`))

document.querySelector('form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = document.querySelector('input') as HTMLInputElement
  await chat.send({ text: input.value })   // to everyone; pass a pubkey to send to one peer
  input.value = ''
})
```

Open the page in two tabs (or two devices). Within a few seconds each side logs the other's join.

## What just happened

1. `createRoom` derived a **topic** (a SHA-256 hash of `appId`, `roomId` and an optional password)
   and a **room key**. See [Signaling](../concepts/signaling/).
2. Each peer published an encrypted **announce** (Nostr kind 20100) tagged with the topic to all
   three relays, and re-announces every 20 seconds.
3. For each pair, the peer with the lower pubkey sent a WebRTC offer as a **directed signal**
   (kind 20101, NIP-44 encrypted to the other peer).
4. Once ICE found a path, the peers ran the **handshake** on the first data channel, checked each
   other's attestations against room policy and only then fired `onPeerJoin`.

## Add a password

Rooms are public to anyone who knows the `appId` and `roomId`. A password changes the topic and the
room key, so relays and strangers cannot even see the announces:

```ts
const room = await createRoom({ appId, roomId: 'team', password: 'correct horse', /* … */ })
```

For real access control, see [Identity and attestations](../concepts/identity/).

## When peers cannot connect

The setup above uses STUN only. Two peers behind symmetric NATs (some mobile carriers, many
corporate networks) cannot reach each other without a relay. Run your own
[Beamhop relay](../relay/install/) and add its TURN credentials and data relay; the
[transport ladder](../concepts/transports/) then falls back automatically.

## Next

- [Add React](./react/) with `useRoom`, `usePeers` and `useAction`.
- Read the [concepts](../concepts/identity/) to understand what the library does for you.
- Try the [live demo](/lightspeed/demo/) and open its Debug drawer.
