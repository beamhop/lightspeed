---
title: Channels and the typed protocol
description: Actions, requests and streams; reliability modes, priority lanes, framing and chunking.
sidebar:
  order: 5
---

:::caution[0.x, subject to change]
:::

Your app never touches raw data channels. It declares a **protocol**, and the library maps each
entry onto a channel with the right delivery guarantees.

```ts
import { defineProtocol } from '@beamhop/p2p'
import { z } from 'zod'

export const protocol = defineProtocol({
  // Fire-and-forget messages
  chat: { schema: z.object({ text: z.string().max(2000) }), reliability: { mode: 'reliable' } },
  cursor: {
    schema: z.object({ x: z.number(), y: z.number() }),
    reliability: { mode: 'unreliable', maxRetransmits: 0 },
    priority: 'low',
  },
  // Request/response
  roll: {
    request: z.object({ sides: z.number().int().min(2) }),
    response: z.object({ value: z.number().int() }),
  },
  // Byte streams (files, recordings)
  file: { stream: true },
})
```

Schemas use [Standard Schema](https://standardschema.dev): Zod, Valibot and ArkType all work.
Incoming messages that fail validation are dropped and reported on the telemetry bus; your handler
only ever sees valid, typed data.

## Using it

```ts
const chat = room.action('chat')
chat.on((msg, peer) => render(peer, msg.text))
await chat.send({ text: 'hi' })                  // everyone
await chat.send({ text: 'psst' }, peer.pubkey)   // one peer
await chat.send({ text: 'team' }, [a, b])        // several

room.handle('roll', ({ sides }) => ({ value: 1 + Math.floor(Math.random() * sides) }))
const { value } = await room.request('roll', { sides: 20 }, hostPubkey, { timeoutMs: 5000 })

await room.stream('file').send(peer.pubkey, file.stream(), { name: file.name, size: file.size }, {
  onProgress: ({ sent, total }) => setProgress(sent / total),
})
```

## Reliability modes

| Mode | Ordering | Delivery | Use for |
|---|---|---|---|
| `{ mode: 'reliable' }` | Ordered | Guaranteed | Chat, commands, state updates |
| `{ mode: 'unordered' }` | Any order | Guaranteed | Independent messages where head-of-line blocking hurts |
| `{ mode: 'unreliable', maxRetransmits: n }` | Any order | Best effort | Cursors, positions, telemetry: only the latest value matters |

On WebRTC each mode is its own `RTCDataChannel`. On the data relay everything shares one ordered
WebSocket, so "unreliable" degrades to reliable; the API stays the same.

**Priority lanes** (`'high' | 'normal' | 'low'`) decide which queue drains first when the channel is
congested. Large transfers on `low` do not delay chat on `normal`.

## Framing

Every message is CBOR-encoded and wrapped in a 6-byte frame header
(`version · type · streamId · length`). Payloads larger than **16 KiB** are split into chunks on a
dedicated stream, so a 50 MB file never blocks a channel for other messages, and progress callbacks
fire per chunk. Senders respect `bufferedAmountLow` for backpressure instead of filling browser
buffers. Streams are WHATWG `ReadableStream`s on both ends.

The byte-level format is in the [protocol spec](../../protocol/#7-data-frames).

## Reserved names

Channel labels starting with `__beamhop/` are reserved. `__beamhop/control` carries the handshake;
`__beamhop/telemetry` carries Studio telemetry to peers holding the `debug` capability.
