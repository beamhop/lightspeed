import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  AdminAuth,
  AdminDb,
  createLogger,
  createRelayServer,
  exampleToml,
  loadConfig,
  systemdUnit,
  VERSION,
} from '@beamhop/relay'
import { scaffoldFiles } from './scaffold'

export interface Io {
  out(line: string): void
  err(line: string): void
  cwd: string
  env: Record<string, string | undefined>
}

export const defaultIo = (): Io => ({
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  cwd: process.cwd(),
  env: process.env,
})

const HELP = `beamhop ${VERSION}

Usage:
  beamhop relay [--config <file>]           Run the relay (Nostr, TURN, data relay, Blossom, admin)
  beamhop relay init [options]              Write beamhop-relay.toml + systemd unit, create the data
                                            directory and print the admin bootstrap token
      --dir <dir>        where to write the config and unit (default: .)
      --data <dir>       data directory (default: <dir>/data)
      --domain <host>    public hostname (default: localhost)
      --force            overwrite existing files
  beamhop relay bootstrap-token [--config]  Mint a new bootstrap token (only while no admin exists)
  beamhop studio [args...]                  Open Beamhop Studio
  beamhop init <dir> [--app-id <id>] [--force]
                                            Scaffold a minimal app on @beamhop/p2p
  beamhop --version | --help`

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']

/** Run the CLI. Returns the process exit code (long-running commands resolve when started). */
export async function run(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP)
        return 0
      case '--version':
      case '-v':
        io.out(VERSION)
        return 0
      case 'relay':
        return await relayCmd(rest, io)
      case 'studio':
        return await studioCmd(rest, io)
      case 'init':
        return initCmd(rest, io)
      default:
        io.err(`unknown command: ${cmd}\n\n${HELP}`)
        return 2
    }
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

async function relayCmd(argv: string[], io: Io): Promise<number> {
  if (argv[0] === 'init') return relayInit(argv.slice(1), io)
  if (argv[0] === 'bootstrap-token') return bootstrapToken(argv.slice(1), io)
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help) {
    io.out(HELP)
    return 0
  }
  const loaded = loadConfig(values.config ? resolve(io.cwd, values.config) : undefined, io.env)
  const logger = createLogger(loaded.config.log.level)
  const relay = createRelayServer(loaded, { logger })
  const res = await relay.start()
  if (res.bootstrapToken) {
    io.err(
      `\n  Bootstrap token (claim the first admin at ${res.url}/admin):\n\n    ${res.bootstrapToken}\n`,
    )
  }
  const stop = async () => {
    await relay.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  return 0
}

function relayInit(argv: string[], io: Io): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      data: { type: 'string' },
      domain: { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  const dir = resolve(io.cwd, values.dir ?? '.')
  const dataDir = resolve(dir, values.data ?? 'data')
  const domain = values.domain ?? 'localhost'
  const tomlPath = join(dir, 'beamhop-relay.toml')
  const unitPath = join(dir, 'beamhop-relay.service')
  for (const p of [tomlPath, unitPath]) {
    if (existsSync(p) && !values.force) throw new Error(`${p} exists (use --force to overwrite)`)
  }
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dataDir, 'blobs'), { recursive: true })
  mkdirSync(join(dataDir, 'backups'), { recursive: true })
  let toml = exampleToml({
    domain,
    dataDir,
    publicUrl: domain === 'localhost' ? '' : `https://${domain}`,
  })
  if (domain === 'localhost') {
    // Local trial: plain HTTP on 8080, no TLS files.
    toml = toml
      .replace(/^port = 443$/m, 'port = 8080')
      .replace(/^tls_cert = .*$/m, 'tls_cert = ""')
      .replace(/^tls_key = .*$/m, 'tls_key = ""')
  }
  writeFileSync(tomlPath, toml, { mode: 0o600 })
  writeFileSync(unitPath, systemdUnit({ config: tomlPath, dataDir }))
  const adb = new AdminDb(join(dataDir, 'admin.db'))
  const auth = new AdminAuth(adb)
  let token: string | null = null
  try {
    token = auth.adminCount() === 0 ? auth.regenerateBootstrapToken() : null
  } finally {
    adb.close()
  }
  io.out(`Wrote ${tomlPath}`)
  io.out(`Wrote ${unitPath}`)
  io.out(`Data directory ${dataDir}`)
  io.out('')
  io.out('Next steps:')
  io.out(`  beamhop relay --config ${tomlPath}`)
  io.out(
    '  or install the unit: sudo cp beamhop-relay.service /etc/systemd/system/ && sudo systemctl enable --now beamhop-relay',
  )
  io.out('  Open ports: 443/tcp, 3478/udp+tcp, 5349/tcp, 50000-50100/udp')
  if (token) {
    io.out('')
    io.out('Bootstrap token (claim the first admin in /admin, shown once):')
    io.out(`  ${token}`)
  } else {
    io.out('An admin already exists; no bootstrap token was minted.')
  }
  return 0
}

function bootstrapToken(argv: string[], io: Io): number {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string', short: 'c' } } })
  const { config } = loadConfig(values.config ? resolve(io.cwd, values.config) : undefined, io.env)
  const adb = new AdminDb(join(resolve(io.cwd, config.dataDir), 'admin.db'))
  try {
    const auth = new AdminAuth(adb)
    if (auth.adminCount() > 0)
      throw new Error('this relay already has an admin; log in at /admin instead')
    io.out(auth.regenerateBootstrapToken())
    return 0
  } finally {
    adb.close()
  }
}

/** Locate `@beamhop/studio`'s server entry: $BEAMHOP_STUDIO_ENTRY, then the workspace package. */
export function studioEntry(env: Record<string, string | undefined>): string | null {
  const candidates = [
    env.BEAMHOP_STUDIO_ENTRY,
    fileURLToPath(new URL('../../studio/src/server.ts', import.meta.url)),
  ].filter((p): p is string => !!p)
  try {
    const main = Bun.resolveSync('@beamhop/studio', import.meta.dir)
    candidates.push(join(main, '..', 'server.ts'))
  } catch {}
  return candidates.find((p) => existsSync(p)) ?? null
}

async function studioCmd(argv: string[], io: Io): Promise<number> {
  const entry = studioEntry(io.env)
  if (!entry) {
    io.err('Beamhop Studio is not installed (packages/studio/src/server.ts not found).')
    return 1
  }
  const proc = Bun.spawn([process.execPath, entry, ...argv], {
    cwd: io.cwd,
    env: io.env as Record<string, string>,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return await proc.exited
}

function initCmd(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'app-id': { type: 'string' }, force: { type: 'boolean' } },
  })
  const target = positionals[0]
  if (!target) throw new Error('usage: beamhop init <dir>')
  const dir = resolve(io.cwd, target)
  if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) {
    throw new Error(`${dir} is not empty (use --force to write anyway)`)
  }
  const name =
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'beamhop-app'
  const files = scaffoldFiles({ name, appId: values['app-id'] ?? name, relays: DEFAULT_RELAYS })
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  io.out(`Created ${name} in ${dir}`)
  io.out('')
  io.out(`  cd ${target}`)
  io.out('  bun install')
  io.out('  bun run dev')
  return 0
}
