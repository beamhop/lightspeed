---
title: Add React
description: The same room as the five-minute guide, with @beamhop/react hooks.
sidebar:
  order: 2
---

:::caution[0.x, subject to change]
:::

`@beamhop/react` puts a room in context with `<RoomProvider>` and reads it with hooks: `useRoom`,
`usePeers`, `useAction`, `useRequest`, `useSharedState`, `useSharedLog` and `useTelemetry`. The
provider creates the room when it mounts and leaves it when it unmounts.

```sh
bun add @beamhop/p2p @beamhop/signaling-nostr @beamhop/react zod
```

```tsx title="App.tsx"
import { anonymous, type RoomOptions } from '@beamhop/p2p'
import { webrtcTransport } from '@beamhop/p2p/webrtc'
import { RoomProvider, useAction, usePeers, useRoom, useRoomError } from '@beamhop/react'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { useMemo, useState } from 'react'
import { protocol } from './protocol'

const signaling = nostrSignaling({
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
})
const transports = [webrtcTransport({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })]

export function App({ name, roomId }: { name: string; roomId: string }) {
  const options = useMemo<RoomOptions<typeof protocol>>(
    () => ({
      appId: 'my-first-app',
      roomId,
      identity: anonymous({ persist: true }),
      signaling,
      transports,
      protocol,
      meta: { name },
    }),
    [roomId, name],
  )
  return (
    <RoomProvider options={options}>
      <Chat />
    </RoomProvider>
  )
}

function Chat() {
  const room = useRoom<typeof protocol>()
  const error = useRoomError()
  const peers = usePeers()
  const [log, setLog] = useState<string[]>([])
  const sendChat = useAction<typeof protocol, 'chat'>('chat', ({ text }, from) =>
    setLog((l) => [...l, `${room?.peer(from)?.meta.name ?? from.slice(0, 8)}: ${text}`]),
  )

  if (error) return <p>Could not join: {error.message}</p>
  if (!room) return <p>Joining…</p>

  return (
    <>
      <p>{peers.length} peer(s): {peers.map((p) => String(p.meta.name)).join(', ')}</p>
      <ul>{log.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement
          void sendChat({ text: input.value })
          input.value = ''
        }}
      >
        <input name="text" />
      </form>
    </>
  )
}
```

## Rules of thumb

- Create signaling adapters and transports **outside** the component (or memoize them). The
  provider re-creates the room when `appId`, `roomId` or `password` change; pass a stable
  `options` object otherwise.
- `useAction(name, onMessage?)` subscribes the handler and returns a stable `send(data, { to? })`.
  The handler gets the payload and the sender's pubkey; it always sees the latest closure.
- `useSharedState(name, key)` reads and writes one key of a
  [last-writer-wins map](../../concepts/state/) and re-renders on remote changes.
- `useRoom()` is `null` while the room is being created, and sends reject until it is ready, so
  you can call the hooks unconditionally. Hooks throw outside a `<RoomProvider>`.

See the [React guide](../../guides/react/) for shared state, requests and telemetry.
