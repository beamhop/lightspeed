---
title: State sync
description: Last-writer-wins maps on hybrid logical clocks, append-only logs, and snapshots for late joiners.
sidebar:
  order: 6
---

:::caution[0.x, subject to change]
:::

Most collaborative apps need some state every peer agrees on: who is ready, the board position, the
playlist. Beamhop ships two replicated structures that cover most of it without a server.

## Maps: last writer wins

```ts
const settings = room.state.map<string>('settings')

settings.set('theme', 'dark')
settings.get('theme')               // 'dark'
settings.delete('volume')
settings.toObject()                 // current snapshot ({ theme: 'dark' }); also entries(), keys(), size
settings.subscribe(({ key, value, deleted, remote }) => render(key, value))
```

Each write is stamped with a **hybrid logical clock** (HLC): wall-clock milliseconds plus a logical
counter plus the writer's pubkey as a tie-breaker. When two peers write the same key concurrently,
every peer keeps the write with the larger stamp, so all replicas converge to the same value without
coordination. Deletes are tombstones with stamps, so a late "set" cannot resurrect a newer delete.

Use maps for state where the latest value wins: settings, presence flags, positions, votes keyed by
voter.

## Logs: append-only

```ts
const moves = room.state.log<{ from: string; to: string }>('moves')

moves.append({ from: 'e2', to: 'e4' })   // returns the LogItem { author, seq, at, value }
moves.entries()                          // LogItem[] ordered by HLC (values() for just the values)
moves.subscribe((item, remote) => apply(item.value))
```

Every author has its own sequence numbers and the merged order is deterministic on all peers. Use
logs for event histories, chat backlogs and game moves.

## Late joiners

When a session first comes up, each side asks the other for a **snapshot** (in a
[star room](../topologies/) that is the host and the client), so a late joiner, or a peer
rejoining after a long partition, catches up. Ops and snapshots merge commutatively and
idempotently, so updates that arrive while the snapshot is in flight are not lost. Call
`room.state.sync()` to ask again, and compare `room.state.digest()` across peers to check that
they converged.

```ts
room.onPeerJoin(() => renderBoard(settings.toObject()))
settings.subscribe(() => renderBoard(settings.toObject()))
```

## In a star room

With `topology: { star: {} }` every client holds one session to the host, which forwards writes
to the other clients and answers snapshot requests, so the host's replica is the reference copy.
Writes still merge by HLC; there is no host-side validation hook in v1 (use a
[request](../channels/) to the host for writes that need checking).

## Limits

- State lives in memory on each peer. Persist it yourself (or run a server peer that writes to
  disk) if it must survive everyone leaving.
- Keep values small; large blobs belong in [file transfer](../../guides/file-transfer/) or Blossom.
- Rich-text and list CRDTs are out of scope for v1; a Yjs adapter is planned for v2.
