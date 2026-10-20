// `beamhop studio`: serves the built Studio app, hosts the peer spawner and a server-side relay
// health probe (no CORS limits), and opens the browser.
//
// Binds to 127.0.0.1 by default: the spawner runs local scripts, so it must never be exposed.
// Mutating endpoints also require the `x-beamhop-studio` header, which cross-site pages cannot
// send without a CORS preflight that this server never approves.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { checkRelay } from './health'
import { PeerSpawner, type SpawnFn, validateSpawnRequest } from './spawner'

export interface StudioServerOptions {
  port?: number
  hostname?: string
  /** Built app directory (vite build output). Default: <package>/dist */
  distDir?: string
  /** Working directory for spawned peers and relative script paths. Default: process.cwd() */
  cwd?: string
  /** Open the default browser after starting. Default false (the CLI passes true). */
  open?: boolean
  spawnFn?: SpawnFn
  log?: (msg: string) => void
}

export interface StudioServer {
  url: string
  port: number
  spawner: PeerSpawner
  stop(): Promise<void>
}

export const STUDIO_HEADER = 'x-beamhop-studio'
const DEFAULT_DIST = resolve(import.meta.dir, '..', 'dist')

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status)

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  } catch {
    // headless machine: the URL is printed anyway
  }
}

function serveStatic(distDir: string, pathname: string): Response {
  const index = join(distDir, 'index.html')
  if (!existsSync(index)) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Beamhop Studio</title><body style="font-family:system-ui;background:#0b0e1a;color:#e8eaf6;padding:2rem"><h1>Studio is not built</h1><p>Run <code>bun run --cwd packages/studio build</code> and reload.</p>`,
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  const file = resolve(distDir, rel)
  if (file.startsWith(resolve(distDir)) && existsSync(file) && statSync(file).isFile()) {
    const headers: Record<string, string> = {}
    if (rel.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return new Response(Bun.file(file), { headers })
  }
  // SPA fallback
  return new Response(Bun.file(index), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export function startStudioServer(opts: StudioServerOptions = {}): StudioServer {
  const cwd = opts.cwd ?? process.cwd()
  const distDir = opts.distDir ?? DEFAULT_DIST
  const log = opts.log ?? ((m: string) => console.log(m))
  const spawner = new PeerSpawner(cwd, opts.spawnFn)

  const server = Bun.serve({
    port: opts.port ?? 4710,
    hostname: opts.hostname ?? '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return apiError(405, 'method', 'method not allowed')
        return serveStatic(distDir, path)
      }
      const mutating = req.method !== 'GET' && req.method !== 'HEAD'
      if (mutating && req.headers.get(STUDIO_HEADER) !== '1') {
        return apiError(403, 'forbidden', `missing ${STUDIO_HEADER} header`)
      }
      try {
        if (path === '/api/info' && req.method === 'GET') {
          return json({ name: 'beamhop-studio', spawner: true, health: true, cwd })
        }
        if (path === '/api/spawn' && req.method === 'GET') return json({ peers: spawner.list() })
        if (path === '/api/spawn' && req.method === 'POST') {
          const v = validateSpawnRequest(await req.json().catch(() => null))
          if (!v.ok) return apiError(400, 'invalid', v.error)
          const script = isAbsolute(v.value.script) ? v.value.script : resolve(cwd, v.value.script)
          if (!existsSync(script)) return apiError(400, 'not_found', `script not found: ${script}`)
          const peers = spawner.spawn({ ...v.value, script })
          log(`studio: spawned ${peers.length} peer(s) running ${script}`)
          return json({ peers }, 201)
        }
        if (path === '/api/spawn' && req.method === 'DELETE')
          return json({ killed: spawner.killAll() })
        const m = /^\/api\/spawn\/([\w-]+)$/.exec(path)
        if (m && req.method === 'DELETE') {
          return spawner.kill(m[1] as string)
            ? json({ ok: true })
            : apiError(404, 'not_found', 'no such peer')
        }
        if (path === '/api/health' && req.method === 'POST') {
          const body = (await req.json().catch(() => null)) as {
            relay?: string
            appId?: string
            apiKey?: string
          } | null
          if (!body?.relay || !/^wss?:\/\//.test(body.relay))
            return apiError(400, 'invalid', 'relay must be a ws(s) URL')
          return json(
            await checkRelay({
              relay: body.relay,
              appId: body.appId || undefined,
              apiKey: body.apiKey || undefined,
            }),
          )
        }
        return apiError(404, 'not_found', 'unknown endpoint')
      } catch (e) {
        return apiError(500, 'internal', e instanceof Error ? e.message : String(e))
      }
    },
  })

  const port = server.port ?? 0
  const host = opts.hostname && opts.hostname !== '0.0.0.0' ? opts.hostname : '127.0.0.1'
  const url = `http://${host}:${port}/`
  if (opts.open) openBrowser(url)
  return {
    url,
    port,
    spawner,
    async stop() {
      spawner.killAll()
      await server.stop(true)
    },
  }
}

function parseArgs(argv: string[]): StudioServerOptions {
  const out: StudioServerOptions = { open: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a === '-p') out.port = Number(argv[++i])
    else if (a === '--host') out.hostname = argv[++i]
    else if (a === '--no-open') out.open = false
    else if (a === '--dist') out.distDir = argv[++i]
  }
  return out
}

/** Entry used by `beamhop studio` (and `bun src/server.ts`). */
export function main(argv = process.argv.slice(2)): StudioServer {
  const s = startStudioServer(parseArgs(argv))
  console.log(`Beamhop Studio → ${s.url}`)
  const shutdown = () => {
    void s.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return s
}

if (import.meta.main) main()
