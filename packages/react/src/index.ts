// React bindings for @beamhop/p2p.
import type {
  ActionInput,
  ActionNames,
  ActionOutput,
  Hex,
  LogItem,
  Peer,
  ProtocolDef,
  RequestInput,
  RequestNames,
  RequestOutput,
  ResponseInput,
  ResponseOutput,
  Room,
  RoomOptions,
  SendOptions,
  SharedMap,
  TelemetryEvent,
} from '@beamhop/p2p'
import { createRoom } from '@beamhop/p2p'
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

interface RoomContextValue {
  room: Room<any> | null
  error: Error | null
}

const RoomContext = createContext<RoomContextValue | null>(null)

export interface RoomProviderProps<P extends ProtocolDef> {
  /** Options for createRoom; the room is created on mount and left on unmount. */
  options?: RoomOptions<P>
  /** Or pass an existing room (the provider will not leave it). */
  room?: Room<P>
  children?: ReactNode
}

/**
 * Provides a room to its subtree. With `options`, a new room is created when the provider mounts and
 * whenever `options.appId`, `roomId` or `password` change; pass a stable `options` object otherwise.
 */
export function RoomProvider<P extends ProtocolDef>(props: RoomProviderProps<P>): ReactNode {
  const [state, setState] = useState<RoomContextValue>({ room: props.room ?? null, error: null })
  const opts = props.options
  const key = opts ? `${opts.appId}\u0000${opts.roomId}\u0000${opts.password ?? ''}` : null
  const optsRef = useRef(opts)
  optsRef.current = opts

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` (appId/roomId/password) decides when to recreate the room
  useEffect(() => {
    if (props.room) {
      setState({ room: props.room, error: null })
      return
    }
    const o = optsRef.current
    if (!o) return
    let cancelled = false
    let created: Room<P> | null = null
    createRoom(o).then(
      (room) => {
        if (cancelled) {
          void room.leave()
          return
        }
        created = room
        setState({ room, error: null })
      },
      (error: Error) => {
        if (!cancelled) setState({ room: null, error })
      },
    )
    return () => {
      cancelled = true
      setState({ room: null, error: null })
      if (created) void created.leave()
    }
  }, [key, props.room])

  return createElement(RoomContext.Provider, { value: state }, props.children)
}

function useRoomContext(): RoomContextValue {
  const ctx = useContext(RoomContext)
  if (!ctx) throw new Error('@beamhop/react: hooks must be used inside <RoomProvider>')
  return ctx
}

/** The current room, or null while it is being created. */
export function useRoom<P extends ProtocolDef = ProtocolDef>(): Room<P> | null {
  return useRoomContext().room as Room<P> | null
}

/** The error createRoom failed with, if any. */
export function useRoomError(): Error | null {
  return useRoomContext().error
}

const EMPTY: readonly Peer[] = []

/** Live peer list (join, leave, away/back, path and RTT updates). */
export function usePeers(): readonly Peer[] {
  const room = useRoom()
  const cache = useRef<{ room: Room<any> | null; peers: readonly Peer[] }>({
    room: null,
    peers: EMPTY,
  })
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!room) return () => {}
      const refresh = () => {
        cache.current = { room, peers: room.peers }
        cb()
      }
      const u = [
        room.onPeerJoin(refresh),
        room.onPeerLeave(refresh),
        room.onPeerUpdate(refresh),
        room.onHostChange(refresh),
      ]
      return () => {
        for (const f of u) f()
      }
    },
    [room],
  )
  const get = () => {
    if (!room) return EMPTY
    if (cache.current.room !== room) cache.current = { room, peers: room.peers }
    return cache.current.peers
  }
  return useSyncExternalStore(subscribe, get, get)
}

type ActionOut<P extends ProtocolDef, K extends ActionNames<P>> = ActionOutput<P, K>

/**
 * Send and receive one protocol action. Returns a stable `send`; `onMessage` always sees the latest
 * closure. `send` rejects while the room is not ready.
 */
export function useAction<
  P extends ProtocolDef = ProtocolDef,
  K extends ActionNames<P> = ActionNames<P>,
>(
  name: K,
  onMessage?: (data: ActionOut<P, K>, from: Hex) => void,
): (data: ActionInput<P, K>, opts?: SendOptions) => Promise<void> {
  const room = useRoom<P>()
  const handler = useRef(onMessage)
  handler.current = onMessage
  useEffect(() => {
    if (!room) return
    return room.action(name).onMessage((d, from) => handler.current?.(d as ActionOut<P, K>, from))
  }, [room, name])
  return useCallback(
    (data, opts) => {
      if (!room) return Promise.reject(new Error('room not ready'))
      return room.action(name).send(data as never, opts)
    },
    [room, name],
  )
}

/**
 * Call a request/response entry; with `handler`, also answer it for other peers.
 */
export function useRequest<
  P extends ProtocolDef = ProtocolDef,
  K extends RequestNames<P> = RequestNames<P>,
>(
  name: K,
  handler?: (
    input: RequestOutput<P, K>,
    from: Hex,
  ) => ResponseInput<P, K> | Promise<ResponseInput<P, K>>,
): (
  to: Hex,
  input: RequestInput<P, K>,
  opts?: { timeoutMs?: number },
) => Promise<ResponseOutput<P, K>> {
  const room = useRoom<P>()
  const h = useRef(handler)
  h.current = handler
  const hasHandler = !!handler
  useEffect(() => {
    if (!room || !hasHandler) return
    return room.request(name).handle((input, from) => {
      const fn = h.current
      if (!fn) throw new Error('no handler')
      return fn(input as never, from) as never
    })
  }, [room, name, hasHandler])
  return useCallback(
    (to, input, opts) => {
      if (!room) return Promise.reject(new Error('room not ready'))
      return room.request(name).call(to, input as never, opts) as never
    },
    [room, name],
  )
}

function readMap(room: Room<any> | null, name: string, key: string | undefined): unknown {
  if (!room) return key === undefined ? {} : undefined
  const map = room.state.map(name)
  return key === undefined ? map.toObject() : map.get(key)
}

/** A whole shared LWW map: `[object, map]`. */
export function useSharedState<V = unknown>(name: string): [Record<string, V>, SharedMap<V> | null]
/** One key of a shared LWW map: `[value, set]`. */
export function useSharedState<V = unknown>(
  name: string,
  key: string,
): [V | undefined, (value: V) => void]
export function useSharedState<V>(name: string, key?: string): unknown {
  const room = useRoom()
  const map = room ? room.state.map<V>(name) : null
  const cache = useRef<{ room: Room<any> | null; v: unknown }>({ room: null, v: undefined })
  const read = () => readMap(room, name, key)
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!room) return () => {}
      return room.state.map<V>(name).subscribe((c) => {
        if (key !== undefined && c.key !== key) return
        cache.current = { room, v: readMap(room, name, key) }
        cb()
      })
    },
    [room, name, key],
  )
  const get = () => {
    if (cache.current.room !== room) cache.current = { room, v: read() }
    return cache.current.v
  }
  const value = useSyncExternalStore(subscribe, get, get)
  const set = useCallback(
    (v: V) => {
      if (key !== undefined) room?.state.map<V>(name).set(key, v)
    },
    [room, name, key],
  )
  return key === undefined ? [value, map] : [value, set]
}

/** A shared append-only log: `[items in HLC order, append]`. */
export function useSharedLog<V = unknown>(
  name: string,
): [readonly LogItem<V>[], (value: V) => void] {
  const room = useRoom()
  const cache = useRef<{ room: Room<any> | null; v: readonly LogItem<V>[] }>({ room: null, v: [] })
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!room) return () => {}
      const log = room.state.log<V>(name)
      return log.subscribe(() => {
        cache.current = { room, v: log.entries() }
        cb()
      })
    },
    [room, name],
  )
  const get = () => {
    if (cache.current.room !== room)
      cache.current = { room, v: room ? room.state.log<V>(name).entries() : [] }
    return cache.current.v
  }
  const items = useSyncExternalStore(subscribe, get, get)
  const append = useCallback((v: V) => void room?.state.log<V>(name).append(v), [room, name])
  return [items, append]
}

export interface UseTelemetryOptions {
  /** Keep at most this many events (default 200). */
  limit?: number
  filter?: (e: TelemetryEvent) => boolean
  /** Start with the bus's recent history (default true). */
  replay?: boolean
}

/** Recent telemetry events from the room's bus, newest last. */
export function useTelemetry(opts: UseTelemetryOptions = {}): readonly TelemetryEvent[] {
  const room = useRoom()
  const [events, setEvents] = useState<readonly TelemetryEvent[]>([])
  const filter = useRef(opts.filter)
  filter.current = opts.filter
  const limit = opts.limit ?? 200
  const replay = opts.replay !== false
  useEffect(() => {
    setEvents([])
    if (!room) return
    let buf: TelemetryEvent[] = []
    let scheduled = false
    const flush = () => {
      scheduled = false
      setEvents(buf.slice(-limit))
    }
    return room.telemetry.subscribe(
      (e) => {
        if (filter.current && !filter.current(e)) return
        buf = [...buf, e].slice(-limit)
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      },
      { replay },
    )
  }, [room, limit, replay])
  return events
}

export type { Peer, Room, RoomOptions }
