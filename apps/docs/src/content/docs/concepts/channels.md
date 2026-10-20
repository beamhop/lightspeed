---
title: Channels and the typed protocol
description: Actions and requests; reliability modes, priority lanes, framing and chunking.
sidebar:
  order: 5
---

:::caution[0.x, subject to change]
:::

Your app never touches raw data channels. It declares a **protocol**, and the library maps each
entry onto a channel with the right delivery guarantees.

```ts
import { action, any, defineProtocol, request } from '@beamhop/p2p'
import { z } from 'zod'

export const protocol = defineProtocol({
  // Fire-and-forget messages (reliable and ordered by default)
  chat: action(z.object({ text: z.string().max(2000) })),
  cursor: action(z.object({ x: z.number(), y: z.number() }), {
    reliability: 'unreliable',       // or 'reliable' | 'unordered' | { mode, maxRetransmits }
    priority: 'low',                 // 'high' | 'normal' | 'low'
  }),
  // Untyped pass-through payload
  note: action(any<{ body: string }>()),
  // Request/response
  roll: request(z.object({ sides: z.number().int().min(2) }), z.object({ value: z.number().int() }), {
    timeoutMs: 5000,
  }),
})
```

Schemas use [Standard Schema](https://standardschema.dev): Zod, Valibot and ArkType all work.
Outgoing payloads are validated before they are sent (`send` rejects with a `ValidationError`).
Incoming messages that fail validation are dropped and reported on the telemetry bus as an
`error` event; your handler only ever sees valid, typed data. Files are not protocol entries:
use `room.sendFile` and `room.onFile` (see [File transfer](../../guides/file-transfer/)).

## Using it

```ts
const chat = room.action('chat')
chat.onMessage((msg, from) => render(room.peer(from), msg.text))
await chat.send({ text: 'hi' })                       // everyone; resolves when acknowledged
await chat.send({ text: 'psst' }, { to: peer.pubkey }) // one peer
await chat.send({ text: 'team' }, { to: [a, b] })     // several

room.request('roll').handle(({ sides }, from) => ({ value: 1 + Math.floor(Math.random() * sides) }))
const { value } = await room.request('roll').call(hostPubkey, { sides: 20 }, { timeoutMs: 5000 })

await room.sendFile(file, { to: peer.pubkey, onProgress: (sent, total) => setProgress(sent / (total ?? sent)) })
```

## Reliability modes

| Mode | Ordering | Delivery | Use for |
|---|---|---|---|
| `{ mode: 'reliable' }` | Ordered | Guaranteed | Chat, commands, state updates |
| `{ mode: 'unordered' }` | Any order | Guaranteed | Independent messages where head-of-line blocking hurts |
| `{ mode: 'unreliable', maxRetransmits: n }` | Any order | Best effort | Cursors, positions, telemetry: only the latest value matters |

Each connection carries three channels: `bh/r` (reliable, ordered), `bh/u` (reliable, unordered)
and `bh/x` (unreliable, `maxRetransmits: 0`). On WebRTC these are `RTCDataChannel`s. On the data
relay everything shares one ordered WebSocket, so "unreliable" degrades to reliable; the API stays
the same. Unreliable sends resolve immediately and are dropped while a peer is away.

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

Protocol names starting with `__` are reserved (`defineProtocol` throws). The handshake runs as the
first frames on `bh/r`; the WebRTC transport uses a pre-negotiated `__beamhop/ctl` channel to open
the others; `__beamhop/telemetry` carries telemetry to peers holding the `debug` capability.
