// Micro-benchmark: packet throughput of Bun.udpSocket through a TURN channel relay.
//
//   bun bench/udp.ts [--size 1200] [--seconds 3] [--inproc]
//
// Topology (all on 127.0.0.1):  client --ChannelData--> TURN server --UDP--> sink peer
// and the reverse direction:     peer --UDP--> TURN server --ChannelData--> client
// By default the server runs in its own Bun process (src/bin.ts) so the load generator and the
// relay do not share an event loop; --inproc runs everything in this process.

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { channelData, TurnClient } from '../src/client'
import { createTurnServer } from '../src/server'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    size: { type: 'string', default: '1200' },
    seconds: { type: 'string', default: '3' },
    batch: { type: 'string', default: '64' },
    inproc: { type: 'boolean', default: false },
  },
})
const SIZE = Number(values.size)
const SECONDS = Number(values.seconds)
const BATCH = Number(values.batch)

async function startServer(): Promise<{ port: number; stop: () => Promise<void> | void }> {
  const opts = {
    realm: 'bench',
    host: '127.0.0.1',
    relayPorts: [0, 0] as [number, number],
    credentials: () => ({ password: 'bench' }),
  }
  if (values.inproc) {
    const s = createTurnServer({ ...opts, listen: { udp: 0 } })
    const { udp } = await s.start()
    return { port: udp as number, stop: () => s.stop() }
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../src/bin.ts'),
      '--realm=bench',
      '--host=127.0.0.1',
      '--udp-port=0',
      '--tcp-port=-1',
      '--relay-ports=0-0',
      '--user=bench:bench',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  )
  const reader = proc.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('server exited')
    buf += new TextDecoder().decode(value)
  }
  const line = JSON.parse(buf.split('\n')[0] as string) as { udp: number }
  return { port: line.udp, stop: () => proc.kill() }
}

const server = await startServer()

let sinkPackets = 0
let sinkBytes = 0
const sink = await Bun.udpSocket({
  hostname: '127.0.0.1',
  socket: {
    data(_s, data) {
      sinkPackets++
      sinkBytes += data.length
    },
  },
})
const peer = { family: 4 as const, address: '127.0.0.1', port: sink.port }

const client = await TurnClient.connect({
  host: '127.0.0.1',
  port: server.port,
  username: 'bench',
  password: 'bench',
})
const [relayed] = await client.allocate()
await client.channelBind(0x4000, peer)
if (!relayed) throw new Error('no relayed address')

let clientPackets = 0
let clientBytes = 0
client.onData((r) => {
  clientPackets++
  clientBytes += r.data.length
})

const payload = new Uint8Array(SIZE).fill(0xab)

async function blast(
  label: string,
  send: () => number,
  counter: () => { packets: number; bytes: number },
): Promise<void> {
  const start0 = counter()
  const t0 = performance.now()
  let sent = 0
  while (performance.now() - t0 < SECONDS * 1000) {
    sent += send()
    await new Promise((r) => setImmediate(r))
  }
  await Bun.sleep(200) // let in-flight packets land
  const elapsed = (performance.now() - t0 - 200) / 1000
  const c = counter()
  const pkts = c.packets - start0.packets
  const bytes = c.bytes - start0.bytes
  const pps = pkts / elapsed
  console.log(
    `${label.padEnd(28)} sent ${(sent / elapsed).toFixed(0).padStart(8)} pps  ` +
      `relayed ${pps.toFixed(0).padStart(8)} pps  ${((bytes * 8) / elapsed / 1e6).toFixed(1).padStart(7)} Mbit/s  ` +
      `loss ${(100 * (1 - pkts / Math.max(sent, 1))).toFixed(1)}%`,
  )
}

// client -> relay: ChannelData sent from the client's own socket (the allocation's 5-tuple),
// so we have to use the TurnClient socket; build one frame and send it in batches.
const frame = channelData(0x4000, payload)
await blast(
  `client->peer ${SIZE}B`,
  () => {
    for (let i = 0; i < BATCH; i++) client.sendRaw(frame)
    return BATCH
  },
  () => ({ packets: sinkPackets, bytes: sinkBytes }),
)

// peer -> client: the sink sends to the relayed address; the server wraps it in ChannelData.
const batch: (Uint8Array | number | string)[] = []
for (let i = 0; i < BATCH; i++) batch.push(payload, relayed.port, '127.0.0.1')
await blast(
  `peer->client ${SIZE}B`,
  () => sink.sendMany(batch),
  () => ({ packets: clientPackets, bytes: clientBytes }),
)

console.log(
  `bun ${Bun.version} ${process.platform}/${process.arch} ${values.inproc ? 'in-process' : 'server in separate process'}`,
)
client.close()
sink.close()
await server.stop()
process.exit(0)
