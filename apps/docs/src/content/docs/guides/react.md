---
title: React hooks
description: RoomProvider, useRoom, usePeers, useAction, useRequest, useSharedState, useSharedLog and useTelemetry in depth.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
:::

`@beamhop/react` is a thin layer over `@beamhop/p2p`. Everything it does you could do with
`useEffect`; the hooks just get the subscriptions and cleanup right. `react` 18 or newer is a peer
dependency.

## RoomProvider

```tsx
<RoomProvider options={options}>{children}</RoomProvider>   // creates and leaves the room
<RoomProvider room={room}>{children}</RoomProvider>         // uses an existing room, never leaves it
```

- With `options`, the provider calls `createRoom(options)` on mount, leaves the room on unmount,
  and re-creates it when `options.appId`, `options.roomId` or `options.password` change.
- Keep `signaling`, `transports` and `protocol` referentially stable (module scope or `useMemo`).
- Every hook below reads the room from the nearest provider and throws outside one.

## useRoom and useRoomError

```tsx
const room = useRoom<typeof protocol>()   // Room | null while it is being created
const error = useRoomError()              // the createRoom error, if any
const self = room?.self.pubkey
```

## usePeers

```tsx
const peers = usePeers()   // readonly Peer[] excluding self
```

Re-renders on join, leave, away/back, path, RTT and host changes. Each peer has `pubkey`, verified
`attestations`, self-declared `meta`, `state` (`'connected' | 'away'`), `path`, `rttMs` and
`isHost`.

## useAction

```tsx
const send = useAction<typeof protocol, 'chat'>('chat', (msg, from) => addMessage(from, msg))
await send({ text: 'hi' })                        // broadcast; resolves when acknowledged
await send({ text: 'psst' }, { to: peer.pubkey }) // one peer (or an array of pubkeys)
```

The handler always sees the latest closure (it is stored in a ref), so you do not need to memoize
it. Omit the handler to get only `send`. `send` rejects while the room is not ready.

## useRequest

```tsx
// Answer requests from other peers (optional) and get a stable `call`.
const roll = useRequest<typeof protocol, 'roll'>('roll', ({ sides }) => ({
  value: 1 + Math.floor(Math.random() * sides),
}))
const { value } = await roll(hostPubkey, { sides: 20 }, { timeoutMs: 5000 })
```

## useSharedState

```tsx
const [theme, setTheme] = useSharedState<string>('settings', 'theme')   // one key: [value, set]
const [settings, map] = useSharedState<string>('settings')              // whole map: [object, SharedMap]
```

Reads and writes a [last-writer-wins map](../../concepts/state/). With a key, only changes to that
key re-render the component. The value is `undefined` until someone sets it.

## useSharedLog

```tsx
const [items, append] = useSharedLog<string>('events')
append('started')
items.map((i) => `${i.author.slice(0, 8)} #${i.seq}: ${i.value}`)
```

Items are in HLC order, identical on every peer.

## useTelemetry

```tsx
const events = useTelemetry({ filter: (e) => e.type === 'path' || e.type === 'rtt', limit: 100 })
```

Recent `TelemetryEvent`s from the room's bus, newest last, batched per microtask. `replay`
(default `true`) starts with the bus's recent history. Handy for building your own connection
indicator.

## Server rendering

On the server the provider never creates a room (`useEffect` does not run), so `useRoom()` is
`null` and components render their joining state; they hydrate normally.
