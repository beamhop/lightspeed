import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { turnPassword, turnUsername } from '@beamhop/p2p/wire'
import { TurnClient } from './client'

async function spawnBin(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'bin.ts'), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = proc.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  return { proc, first: buf.split('\n')[0] as string }
}

test('CLI serves static users and TURN REST credentials', async () => {
  const { proc, first } = await spawnBin([
    '--realm=cli.test',
    '--host=127.0.0.1',
    '--udp-port=0',
    '--tcp-port=0',
    '--relay-ports=0-0',
    '--user=alice:secret',
    '--secret=rest-secret',
  ])
  try {
    const ports = JSON.parse(first) as { event: string; udp: number; tcp: number }
    expect(ports.event).toBe('listening')
    const a = await TurnClient.connect({
      host: '127.0.0.1',
      port: ports.udp,
      username: 'alice',
      password: 'secret',
    })
    expect(await a.allocate()).toHaveLength(1)
    a.close()
    const username = turnUsername(Date.now() / 1000 + 60, 'app', 'cd'.repeat(32))
    const b = await TurnClient.connect({
      host: '127.0.0.1',
      port: ports.tcp,
      transport: 'tcp',
      username,
      password: turnPassword('rest-secret', username),
    })
    expect(await b.allocate()).toHaveLength(1)
    b.close()
  } finally {
    proc.kill()
    await proc.exited
  }
})

test('CLI refuses to start without credentials', async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'bin.ts'), '--realm=x'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {},
  })
  expect(await proc.exited).toBe(2)
})
