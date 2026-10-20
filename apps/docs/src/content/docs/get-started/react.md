---
title: Add React
description: The same room as the five-minute guide, with @beamhop/react hooks.
sidebar:
  order: 2
---

:::caution[0.x, subject to change]
:::

`@beamhop/react` wraps a room in four hooks: `useRoom`, `usePeers`, `useAction` and
`useSharedState`. The room joins when the component mounts and leaves when it unmounts.

```sh
bun add @beamhop/p2p @beamhop/signaling-nostr @beamhop/react zod
```

```tsx title="Chat.tsx"
import { anonymous } from '@beamhop/p2p'
import { webrtcTransport } from '@beamhop/p2p/webrtc'
import { useAction, usePeers, useRoom } from '@beamhop/react'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { useState } from 'react'
import { protocol } from './protocol'

const signaling = nostrSignaling({
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
})
const transports = [webrtcTransport({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })]

export function Chat({ name, roomId }: { name: string; roomId: string }) {
  const { room, status, error } = useRoom({
    appId: 'my-first-app',
    roomId,
    identity: anonymous({ persist: true }),
    signaling,
    transports,
    protocol,
    meta: { name },
  })
  const peers = usePeers(room)
  const [log, setLog] = useState<string[]>([])
  const sendChat = useAction(room, 'chat', ({ text }, peer) =>
    setLog((l) => [...l, `${peer.meta.name}: ${text}`]),
  )

  if (error) return <p>Could not join: {error.message}</p>
  if (status !== 'joined') return <p>Joining…</p>

  return (
    <>
      <p>{peers.length} peer(s): {peers.map((p) => p.meta.name).join(', ')}</p>
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

- Create signaling adapters and transports **outside** the component (or memoize them). `useRoom`
  re-joins when its options change identity.
- `useAction(room, name, handler)` subscribes the handler and returns a stable `send` function.
  Without a handler it only returns `send`.
- `useSharedState(room, mapName, key, initial)` reads and writes one key of a
  [last-writer-wins map](../../concepts/state/) and re-renders on remote changes.
- Every hook accepts `room` as `null` while the room is joining, so you can call them
  unconditionally.

See the [React guide](../../guides/react/) for shared state, requests and Suspense-free loading
patterns.
