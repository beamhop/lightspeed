# @beamhop/react

React bindings for [`@beamhop/p2p`](../p2p). `react` (18 or newer) is a peer dependency. MIT.

```tsx
import { RoomProvider, useAction, usePeers, useRequest, useSharedState, useTelemetry } from '@beamhop/react'

const options = { appId: 'demo', roomId: 'lobby', identity: anonymous(), signaling, transports, protocol }

export const App = () => (
  <RoomProvider options={options}>
    <Chat />
  </RoomProvider>
)

function Chat() {
  const peers = usePeers()
  const [messages, setMessages] = useState<string[]>([])
  const send = useAction<typeof protocol, 'chat'>('chat', (m, from) => setMessages((xs) => [...xs, m.text]))
  const [topic, setTopic] = useSharedState<string>('room', 'topic')
  const ping = useRequest<typeof protocol, 'ping'>('ping', (n) => n + 1) // handler is optional
  const events = useTelemetry({ limit: 50 })
  ...
}
```

| Hook | Returns |
| --- | --- |
| `RoomProvider({ options } \| { room })` | Creates the room on mount with `createRoom(options)` and leaves it on unmount. It recreates the room when `appId`, `roomId` or `password` change. With `room`, it uses that room and never leaves it. |
| `useRoom()` | The `Room`, or `null` while it is being created. `useRoomError()` returns the creation error. |
| `usePeers()` | Live `Peer[]`, updated on join, leave, away/back, path and host changes |
| `useAction(name, onMessage?)` | A stable `send(data, { to?, onProgress? })`. `onMessage` always sees the latest closure. |
| `useRequest(name, handler?)` | A stable `call(to, input, { timeoutMs? })`. With `handler`, it also answers requests from other peers. |
| `useSharedState(name)` / `useSharedState(name, key)` | `[object, SharedMap]` for the whole map, or `[value, set]` for one key of an LWW map |
| `useSharedLog(name)` | `[items, append]` for an append-only log, in HLC order |
| `useTelemetry({ limit?, filter?, replay? })` | Recent `TelemetryEvent`s, newest last, batched per microtask |

Hooks throw outside a `RoomProvider`. Sends reject while the room is still being created.

```sh
bun test packages/react
bunx tsc --noEmit -p packages/react
```
