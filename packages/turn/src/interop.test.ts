// Optional interop test against coturn's turnutils_uclient. Skipped when the binary is absent
// (install coturn: `apt install coturn` / `brew install coturn`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTurnServer, type TurnServer } from './server'

const uclient = Bun.which('turnutils_uclient')

describe.skipIf(!uclient)('coturn turnutils_uclient interop', () => {
  let server: TurnServer
  let ports: { udp?: number; tcp?: number }

  beforeAll(async () => {
    server = createTurnServer({
      realm: 'interop.test',
      host: '127.0.0.1',
      listen: { udp: 0, tcp: 0 },
      relayPorts: [0, 0],
      credentials: (u) => (u === 'alice' ? { password: 'secret' } : null),
    })
    ports = await server.start()
  })
  afterAll(() => server.stop())

  async function run(args: string[]) {
    const proc = Bun.spawn([uclient as string, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 20_000)
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    clearTimeout(timer)
    const code = await proc.exited
    return { code, text: out + err }
  }

  for (const transport of ['udp', 'tcp'] as const) {
    test(`client-to-client relay over ${transport}`, async () => {
      const port = transport === 'udp' ? ports.udp : ports.tcp
      const args = ['-y', '-n', '20', '-m', '1', '-l', '120', '-u', 'alice', '-w', 'secret']
      if (transport === 'tcp') args.push('-t')
      args.push('-p', String(port), '127.0.0.1')
      const { code, text } = await run(args)
      expect(code).toBe(0)
      const recv = /tot_recv_msgs=(\d+)/.exec(text)
      expect(recv && Number(recv[1])).toBeGreaterThan(0)
    }, 30_000)
  }
})
