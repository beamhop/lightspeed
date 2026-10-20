import { describe, expect, test } from 'bun:test'
import {
  buildSpawnPlans,
  MAX_SPAWN,
  PeerSpawner,
  type ProcessHandle,
  validateSpawnRequest,
} from './spawner'

const base = {
  script: 'peers/bot.ts',
  count: 3,
  room: 'lobby',
  app: 'demo',
  relay: 'wss://relay.example',
}

describe('spawner arg building', () => {
  test('one plan per peer with ROOM/APP/RELAY env and index', () => {
    const plans = buildSpawnPlans(
      { ...base, env: { DEBUG: '1' }, args: ['--fast'] },
      {
        bun: '/usr/local/bin/bun',
        baseEnv: { PATH: '/bin', UNSET: undefined },
      },
    )
    expect(plans.length).toBe(3)
    expect(plans[0]).toEqual({
      index: 0,
      cmd: ['/usr/local/bin/bun', 'run', 'peers/bot.ts', '--fast'],
      env: {
        PATH: '/bin',
        DEBUG: '1',
        ROOM: 'lobby',
        APP: 'demo',
        RELAY: 'wss://relay.example',
        BEAMHOP_PEER_INDEX: '0',
        BEAMHOP_PEER_COUNT: '3',
      },
    })
    expect(plans.map((p) => p.env.BEAMHOP_PEER_INDEX)).toEqual(['0', '1', '2'])
  })

  test('room coordinates override inherited env', () => {
    const [plan] = buildSpawnPlans({ ...base, count: 1 }, { baseEnv: { ROOM: 'stale' } })
    expect(plan?.env.ROOM).toBe('lobby')
    expect(plan?.cmd[0]).toBe('bun')
  })

  test('validation', () => {
    expect(validateSpawnRequest(base)).toMatchObject({ ok: true })
    expect(validateSpawnRequest({ ...base, count: '2' })).toMatchObject({
      ok: true,
      value: { count: 2 },
    })
    const bad: [unknown, string][] = [
      [null, 'object'],
      [{ ...base, script: '' }, 'script'],
      [{ ...base, script: 'run.sh' }, '.ts'],
      [{ ...base, relay: 'https://x' }, 'ws://'],
      [{ ...base, count: 0 }, 'count'],
      [{ ...base, count: MAX_SPAWN + 1 }, 'count'],
      [{ ...base, count: 1.5 }, 'count'],
      [{ ...base, room: ' ' }, 'room'],
      [{ ...base, env: { ROOM: 'x' } }, 'set by the spawner'],
      [{ ...base, env: { 'bad-key': 'x' } }, 'invalid env key'],
      [{ ...base, env: { OK: 1 } }, 'must be a string'],
      [{ ...base, args: [1] }, 'args'],
    ]
    for (const [body, msg] of bad) {
      const r = validateSpawnRequest(body)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(msg)
    }
  })
})

describe('PeerSpawner', () => {
  test('tracks processes, output and kill with a fake spawn', async () => {
    const killed: number[] = []
    let pid = 100
    const spawned: { cmd: string[]; cwd: string }[] = []
    const fake = (plan: { cmd: string[] }, cwd: string): ProcessHandle => {
      const my = ++pid
      spawned.push({ cmd: plan.cmd, cwd })
      let resolveExit: (c: number | null) => void = () => {}
      const exited = new Promise<number | null>((r) => {
        resolveExit = r
      })
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`hello from ${my}\npartial`))
          c.close()
        },
      })
      return {
        pid: my,
        exited,
        stdout,
        kill: () => {
          killed.push(my)
          resolveExit(143)
        },
      }
    }
    const s = new PeerSpawner('/work', fake, 'bun')
    const peers = s.spawn({ ...base, count: 2 })
    expect(peers.map((p) => p.pid)).toEqual([101, 102])
    expect(spawned[0]).toEqual({ cmd: ['bun', 'run', 'peers/bot.ts'], cwd: '/work' })
    await new Promise((r) => setTimeout(r, 10))
    expect(s.list()[0]?.output).toEqual(['hello from 101', 'partial'])
    expect(s.kill(peers[0]?.id as string)).toBe(true)
    expect(s.kill('nope')).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(s.list()[0]?.exitCode).toBe(143)
    expect(s.killAll()).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    s.prune()
    expect(s.list()).toEqual([])
    expect(killed).toEqual([101, 102])
  })
})
