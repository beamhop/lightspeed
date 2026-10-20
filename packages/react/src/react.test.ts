import { expect, test } from 'bun:test'
import {
  action,
  anonymous,
  any,
  createMemoryHub,
  createRoom,
  createSignalingHub,
  defineProtocol,
  type Hex,
  memorySignaling,
  memoryTransport,
  type Room,
  type RoomOptions,
  request,
  type TelemetryEvent,
} from '@beamhop/p2p'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  RoomProvider,
  useAction,
  usePeers,
  useRequest,
  useRoom,
  useSharedLog,
  useSharedState,
  useTelemetry,
} from './index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const proto = defineProtocol({
  chat: action(any<string>()),
  add: request(any<[number, number]>(), any<number>()),
})
type P = typeof proto

const sig = createSignalingHub({ latencyMs: 1 })
const net = createMemoryHub({ defaults: { latencyMs: 1 } })
const options = (): RoomOptions<P> => ({
  appId: 'react',
  roomId: 'test',
  identity: anonymous(),
  signaling: memorySignaling(sig),
  transports: [memoryTransport(net)],
  protocol: proto,
})

async function waitFor(pred: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await act(async () => {
      await Bun.sleep(5)
    })
  }
}

interface Snapshot {
  room: Room<P> | null
  peers: number
  chats: string[]
  score: number | undefined
  all: Record<string, number>
  log: string[]
  telemetry: readonly TelemetryEvent[]
  send?: (t: string) => Promise<void>
  call?: (to: Hex, x: [number, number]) => Promise<number>
  setScore?: (v: number) => void
  append?: (v: string) => void
}

function Probe({ out }: { out: Snapshot }) {
  const room = useRoom<P>()
  const peers = usePeers()
  const send = useAction<P, 'chat'>('chat', (text) => out.chats.push(text))
  const call = useRequest<P, 'add'>('add', ([a, b]) => a + b)
  const [score, setScore] = useSharedState<number>('scores', 'me')
  const [all] = useSharedState<number>('scores')
  const [log, append] = useSharedLog<string>('events')
  const telemetry = useTelemetry({ filter: (e) => e.type === 'peer' })
  Object.assign(out, {
    room,
    peers: peers.length,
    score,
    all,
    log: log.map((i) => i.value),
    telemetry,
    send,
    call,
    setScore,
    append,
  })
  return null
}

test('RoomProvider + hooks', async () => {
  const other = await createRoom(options())
  const otherChats: string[] = []
  other.action('chat').onMessage((t) => otherChats.push(t))
  other.request('add').handle(([a, b]) => a * 100 + b)

  const out: Snapshot = {
    room: null,
    peers: 0,
    chats: [],
    score: undefined,
    all: {},
    log: [],
    telemetry: [],
  }
  let renderer!: TestRenderer.ReactTestRenderer
  const opts = options()
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(RoomProvider<P>, { options: opts }, createElement(Probe, { out })),
    )
  })
  await waitFor(() => out.room !== null && out.peers === 1)
  const me = out.room as Room<P>

  // actions both ways
  await act(async () => {
    await out.send?.('from react')
  })
  await waitFor(() => otherChats.includes('from react'))
  await other.action('chat').send('to react')
  await waitFor(() => out.chats.includes('to react'))

  // requests both ways
  let sum = 0
  await act(async () => {
    sum = (await out.call?.(other.self.pubkey, [1, 2])) ?? 0
  })
  expect(sum).toBe(102)
  expect(await other.request('add').call(me.self.pubkey, [2, 3])).toBe(5)

  // shared state re-renders on local and remote writes
  act(() => out.setScore?.(7))
  expect(out.score).toBe(7)
  other.state.map<number>('scores').set('other', 3)
  await waitFor(() => out.all.other === 3)
  expect(out.all).toEqual({ me: 7, other: 3 })
  act(() => out.append?.('hello'))
  other.state.log<string>('events').append('world')
  await waitFor(() => out.log.length === 2)

  expect(out.telemetry.some((e) => e.type === 'peer' && e.event === 'join')).toBe(true)

  // peer leaves → usePeers updates; unmount leaves the room
  await other.leave()
  await waitFor(() => out.peers === 0)
  await act(async () => {
    renderer.unmount()
  })
})

test('hooks outside a provider throw', () => {
  const Bad = () => {
    useRoom()
    return null
  }
  const orig = console.error
  console.error = () => {}
  try {
    expect(() => act(() => void TestRenderer.create(createElement(Bad)))).toThrow('RoomProvider')
  } finally {
    console.error = orig
  }
})
