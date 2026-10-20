---
title: File transfer
description: Send files of any size peer-to-peer as WHATWG streams with progress and backpressure.
sidebar:
  order: 4
---

:::caution[0.x, subject to change]
:::

Declare a stream entry in your protocol:

```ts
export const protocol = defineProtocol({
  file: { stream: true, priority: 'low' },
})
```

## Sending

```ts
const files = room.stream('file')

async function sendTo(peer: Peer, file: File) {
  await files.send(
    peer.pubkey,
    file.stream(),
    { name: file.name, size: file.size, mime: file.type },
    { onProgress: ({ sent, total }) => updateBar(peer, sent / total) },
  )
}

// To everyone, with one progress bar per peer:
await Promise.all(room.peers().map((p) => sendTo(p, file)))
```

The stream is read in 16 KiB chunks. The sender waits for the channel's `bufferedAmountLow` event
before reading more, so memory stays flat even for multi-gigabyte files, and a `priority: 'low'`
stream yields to chat and cursors.

## Receiving

```ts
files.on(async ({ meta, stream }, peer) => {
  if (!(await confirm(`${peer.meta.name} sends ${meta.name} (${meta.size} bytes). Accept?`))) {
    await stream.cancel('declined')            // the sender's send() rejects with 'declined'
    return
  }
  const blob = await new Response(stream).blob()
  download(blob, String(meta.name))
})
```

For very large files, pipe straight to disk instead of buffering a `Blob`: with the File System
Access API (`showSaveFilePicker().then((h) => h.createWritable())`) or, in Bun, `Bun.file(path).writer()`.

## Reliability

Streams run on a reliable, ordered channel. If the connection drops mid-transfer the session goes
`away`; when it comes `back` the transfer resumes from the last acknowledged chunk. If the peer
leaves for good, both sides' promises reject.

## Try it

The [demo](/lightspeed/demo/)'s **Files** screen does exactly this, with per-peer progress bars.
