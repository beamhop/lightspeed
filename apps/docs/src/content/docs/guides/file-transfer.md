---
title: File transfer
description: Send files of any size peer-to-peer as WHATWG streams with progress and backpressure.
sidebar:
  order: 4
---

:::caution[0.x, subject to change]
:::

Files are built into every room; there is nothing to declare in your protocol. `room.sendFile`
accepts a `Blob`/`File`, a `ReadableStream<Uint8Array>` or a `Uint8Array`, and `room.onFile`
hands receivers an `IncomingFile` with a `ReadableStream`.

## Sending

```ts
async function sendTo(peer: Peer, file: File) {
  await room.sendFile(file, {
    to: peer.pubkey,                       // default: everyone
    name: file.name,                       // defaults to file.name for File
    mime: file.type,
    onProgress: (sent, total) => updateBar(peer, sent / (total ?? sent)),
  })
}

// To everyone, with one progress bar per peer:
await Promise.all(room.peers.map((p) => sendTo(p, file)))
```

The source is read in pieces and sent as low-priority chunks. Between pieces the sender waits for
the session queues to drain (they pause at 256 KiB `bufferedAmount` and resume at 64 KiB), so memory
stays flat even for multi-gigabyte files, and transfers yield to chat and cursors. `sendFile`
resolves when every recipient acknowledged every chunk.

## Receiving

```ts
room.onFile(async (file) => {
  const sender = room.peer(file.from)?.meta.name ?? file.from.slice(0, 8)
  file.onProgress((received, total) => updateBar(file.id, received / (total ?? received)))
  const bytes = await file.bytes()                // or read file.stream yourself
  download(new Blob([bytes], { type: file.mime }), file.name)
  console.log(`${sender} sent ${file.name} (${file.size ?? bytes.length} bytes)`)
})
```

For very large files, pipe `file.stream` straight to disk instead of buffering: with the File
System Access API (`file.stream.pipeTo(await handle.createWritable())`) or, in Bun, by writing each
chunk to `Bun.file(path).writer()`.

## Reliability

Chunks travel on the reliable, ordered lane. If the connection drops mid-transfer the peer goes
`away`; when the session resumes, unacknowledged chunks are re-sent and the receiver drops
duplicates, so the stream continues where it stopped. If you leave the room mid-transfer,
`sendFile` rejects with `room left`.

## Try it

The [demo](/lightspeed/demo/)'s **Files** screen does exactly this, with per-peer progress bars.
