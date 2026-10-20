// Peer spawner: launches N headless Bun peers running a user script. The script gets the room
// coordinates through env (ROOM, APP, RELAY) and is expected to use @beamhop/p2p's relay transport.

export const MAX_SPAWN = 64

export interface SpawnRequest {
  /** Path to the peer script (absolute, or relative to the Studio server's cwd). */
  script: string
  count: number
  room: string
  app: string
  /** Relay URL (ws:// or wss://). */
  relay: string
  /** Extra env passed to every peer. */
  env?: Record<string, string>
  /** Extra CLI args after the script path. */
  args?: string[]
}

export interface SpawnPlan {
  index: number
  cmd: string[]
  env: Record<string, string>
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/
const RESERVED = new Set(['ROOM', 'APP', 'RELAY', 'BEAMHOP_PEER_INDEX', 'BEAMHOP_PEER_COUNT'])

/** Validate an untrusted JSON body from the Studio UI. */
export function validateSpawnRequest(body: unknown): Validated<SpawnRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '')
  const script = str('script')
  const room = str('room')
  const app = str('app')
  const relay = str('relay')
  const count = typeof b.count === 'number' ? b.count : Number(b.count)
  if (!script) return { ok: false, error: 'script is required' }
  if (!/\.(m?[jt]sx?|cjs)$/.test(script))
    return { ok: false, error: 'script must be a .ts/.js/.mjs file' }
  if (!room) return { ok: false, error: 'room is required' }
  if (!app) return { ok: false, error: 'app is required' }
  if (!/^wss?:\/\/[^\s]+$/.test(relay))
    return { ok: false, error: 'relay must be a ws:// or wss:// URL' }
  if (!Number.isInteger(count) || count < 1 || count > MAX_SPAWN) {
    return { ok: false, error: `count must be an integer between 1 and ${MAX_SPAWN}` }
  }
  const env: Record<string, string> = {}
  if (b.env !== undefined) {
    if (!b.env || typeof b.env !== 'object' || Array.isArray(b.env))
      return { ok: false, error: 'env must be an object' }
    for (const [k, v] of Object.entries(b.env as Record<string, unknown>)) {
      if (!ENV_KEY.test(k)) return { ok: false, error: `invalid env key: ${k}` }
      if (RESERVED.has(k)) return { ok: false, error: `env key ${k} is set by the spawner` }
      if (typeof v !== 'string') return { ok: false, error: `env ${k} must be a string` }
      env[k] = v
    }
  }
  let args: string[] = []
  if (b.args !== undefined) {
    if (!Array.isArray(b.args) || !b.args.every((a) => typeof a === 'string')) {
      return { ok: false, error: 'args must be an array of strings' }
    }
    args = b.args as string[]
  }
  return { ok: true, value: { script, count, room, app, relay, env, args } }
}

/**
 * Build the exact commands to run. Pure: the server passes the result to Bun.spawn.
 * `bun` defaults to the running Bun binary (process.execPath) so the peers use the same version.
 */
export function buildSpawnPlans(
  req: SpawnRequest,
  opts: { bun?: string; baseEnv?: Record<string, string | undefined> } = {},
): SpawnPlan[] {
  const bun = opts.bun ?? 'bun'
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.baseEnv ?? {})) if (v !== undefined) base[k] = v
  const plans: SpawnPlan[] = []
  for (let i = 0; i < req.count; i++) {
    plans.push({
      index: i,
      cmd: [bun, 'run', req.script, ...(req.args ?? [])],
      env: {
        ...base,
        ...(req.env ?? {}),
        ROOM: req.room,
        APP: req.app,
        RELAY: req.relay,
        BEAMHOP_PEER_INDEX: String(i),
        BEAMHOP_PEER_COUNT: String(req.count),
      },
    })
  }
  return plans
}

// ------------------------------------------------------------------ process manager

export interface SpawnedPeer {
  id: string
  index: number
  pid: number
  script: string
  startedAt: number
  exitedAt?: number
  exitCode?: number | null
  /** Last lines of combined stdout/stderr. */
  output: string[]
}

export interface ProcessHandle {
  pid: number
  exited: Promise<number | null>
  kill(): void
  stdout?: ReadableStream<Uint8Array> | null
  stderr?: ReadableStream<Uint8Array> | null
}

export type SpawnFn = (plan: SpawnPlan, cwd: string) => ProcessHandle

export const bunSpawn: SpawnFn = (plan, cwd) => {
  const proc = Bun.spawn(plan.cmd, {
    cwd,
    env: plan.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: () => proc.kill(),
    stdout: proc.stdout,
    stderr: proc.stderr,
  }
}

const OUTPUT_LINES = 50

export class PeerSpawner {
  private procs = new Map<string, { info: SpawnedPeer; handle: ProcessHandle }>()
  private next = 1

  constructor(
    private readonly cwd: string,
    private readonly spawnFn: SpawnFn = bunSpawn,
    private readonly bun: string = process.execPath,
  ) {}

  spawn(req: SpawnRequest): SpawnedPeer[] {
    const plans = buildSpawnPlans(req, { bun: this.bun, baseEnv: process.env })
    return plans.map((plan) => {
      const handle = this.spawnFn(plan, this.cwd)
      const info: SpawnedPeer = {
        id: `p${this.next++}`,
        index: plan.index,
        pid: handle.pid,
        script: req.script,
        startedAt: Date.now(),
        output: [],
      }
      this.procs.set(info.id, { info, handle })
      for (const stream of [handle.stdout, handle.stderr]) if (stream) void this.pump(stream, info)
      void handle.exited.then((code) => {
        info.exitedAt = Date.now()
        info.exitCode = code
      })
      return info
    })
  }

  private async pump(stream: ReadableStream<Uint8Array>, info: SpawnedPeer): Promise<void> {
    const decoder = new TextDecoder()
    let carry = ''
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const lines = (carry + decoder.decode(chunk, { stream: true })).split('\n')
        carry = lines.pop() ?? ''
        info.output.push(...lines)
        if (info.output.length > OUTPUT_LINES)
          info.output.splice(0, info.output.length - OUTPUT_LINES)
      }
    } catch {
      // stream closed by kill
    }
    if (carry) info.output.push(carry)
  }

  list(): SpawnedPeer[] {
    return [...this.procs.values()].map((p) => p.info)
  }

  kill(id: string): boolean {
    const p = this.procs.get(id)
    if (!p) return false
    if (p.info.exitedAt === undefined) p.handle.kill()
    return true
  }

  killAll(): number {
    let n = 0
    for (const p of this.procs.values()) {
      if (p.info.exitedAt === undefined) {
        p.handle.kill()
        n++
      }
    }
    return n
  }

  /** Forget exited processes. */
  prune(): void {
    for (const [id, p] of this.procs) if (p.info.exitedAt !== undefined) this.procs.delete(id)
  }
}
