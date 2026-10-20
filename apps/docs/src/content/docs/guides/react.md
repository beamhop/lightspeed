---
title: React hooks
description: useRoom, usePeers, useAction and useSharedState in depth.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
:::

`@beamhop/react` is a thin layer over `@beamhop/p2p`. Everything it does you could do with
`useEffect`; the hooks just get the subscriptions and cleanup right.

## useRoom

```tsx
const { room, status, error } = useRoom(options, { enabled: true })
```

- Joins on mount, leaves on unmount and when `options.roomId`, `options.appId` or
  `options.password` change.
- `status` is `'idle' | 'joining' | 'joined' | 'error' | 'left'`; `room` is `null` until joined.
- Keep `signaling`, `transports` and `protocol` referentially stable (module scope or `useMemo`).

To share one room across a tree, put it in context:

```tsx
const RoomContext = createContext<Room<typeof protocol> | null>(null)

function App() {
  const { room } = useRoom(options)
  return <RoomContext.Provider value={room}><Game /></RoomContext.Provider>
}
```

## usePeers

```tsx
const peers = usePeers(room)                 // Peer[] excluding self, re-renders on join/leave/away/back
const self = room?.self
```

Each peer has `pubkey`, verified `attestations`, self-declared `meta`, `state`
(`'connected' | 'away'`) and `path`.

## useAction

```tsx
const send = useAction(room, 'chat', (msg, peer) => addMessage(peer, msg))
send({ text: 'hi' })               // broadcast
send({ text: 'psst' }, peer.pubkey)
```

The handler always sees the latest closure (it is stored in a ref), so you do not need to memoize
it. Omit the handler to get only `send`.

## useRequest

```tsx
const roll = useRequest(room, 'roll')
const { value } = await roll({ sides: 20 }, hostPubkey)
```

## useSharedState

```tsx
const [theme, setTheme] = useSharedState(room, 'settings', 'theme', 'dark')
```

Reads and writes a single key of a [last-writer-wins map](../../concepts/state/). Remote writes
re-render only the components that read the changed key.

## useTelemetry

```tsx
const events = useTelemetry(room, { types: ['path', 'rtt'], limit: 100 })
```

Handy for building your own connection indicator.

## Server rendering

Hooks are no-ops on the server (`room` stays `null`), so components render their joining state in
SSR and hydrate normally.
