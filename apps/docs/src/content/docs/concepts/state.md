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
const settings = room.state.map<{ theme: string; volume: number }>('settings')

settings.set('theme', 'dark')
settings.get('theme')               // 'dark'
settings.delete('volume')
settings.entries()                  // current snapshot
settings.onChange((key, value, peer) => render(key, value))
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

moves.append({ from: 'e2', to: 'e4' })
moves.entries()                     // ordered by (HLC, author)
moves.onAppend((entry, peer) => apply(entry))
```

Every author has its own sequence numbers; peers detect gaps and ask for the missing entries. The
merged order is deterministic on all peers. Use logs for event histories, chat backlogs and game
moves.

## Late joiners

A peer that joins an existing room requests a **snapshot**: from the host in a
[star room](../topologies/), otherwise from the first peer that answers (or from a
[Bun server peer](../../guides/bun-server-peer/) if one is in the room). It then replays updates
that arrived while the snapshot was in flight. `room.state.ready` resolves when the replica is
caught up.

```ts
await room.state.ready
renderBoard(settings.entries())
```

## In a star room

With `topology: { star: {} }` the host is authoritative: writes are sent to the host, which can
validate them (`room.state.map('board', { validate: (key, value, peer) => boolean })`) before
re-broadcasting. Clients apply their own writes optimistically and roll back if the host rejects.

## Limits

- State lives in memory on each peer. Persist it yourself (or run a server peer that writes to
  disk) if it must survive everyone leaving.
- Keep values small; large blobs belong in [file transfer](../../guides/file-transfer/) or Blossom.
- Rich-text and list CRDTs are out of scope for v1; a Yjs adapter is planned for v2.
