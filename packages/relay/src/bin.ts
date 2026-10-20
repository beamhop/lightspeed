#!/usr/bin/env bun
// beamhop-relay: standalone entry (also the `bun build --compile` target).
import { parseArgs } from 'node:util'
import { loadConfig, type RelayConfig } from './config'
import { createLogger } from './log'
import { createRelayServer } from './server'
import { VERSION } from './version'

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      healthcheck: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values.version) {
    console.log(VERSION)
    return
  }
  if (values.help) {
    console.log(`beamhop-relay ${VERSION}

Usage: beamhop-relay [--config beamhop-relay.toml]
       beamhop-relay --healthcheck   exit 0 when the local relay answers /healthz

Config is read from --config, $BEAMHOP_CONFIG or ./beamhop-relay.toml; BEAMHOP_<SECTION>_<KEY>
environment variables override it (e.g. BEAMHOP_HTTP_PORT=8443).`)
    return
  }
  const loaded = loadConfig(values.config)
  if (values.healthcheck) {
    process.exitCode = (await healthcheck(loaded.config)) ? 0 : 1
    return
  }
  const logger = createLogger(loaded.config.log.level)
  const relay = createRelayServer(loaded, { logger })
  const res = await relay.start()
  if (res.bootstrapToken) {
    // Also print plainly so it stands out from the JSON log stream.
    process.stderr.write(
      `\n  Bootstrap token (claim the first admin at ${res.url}/admin):\n\n    ${res.bootstrapToken}\n\n`,
    )
  }
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info('shutting down', { signal })
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/** GET /healthz on the locally configured listener (container HEALTHCHECK). */
export async function healthcheck(config: RelayConfig): Promise<boolean> {
  const scheme = config.http.tlsCert ? 'https' : 'http'
  const host = ['0.0.0.0', '::', ''].includes(config.http.host) ? '127.0.0.1' : config.http.host
  try {
    const res = await fetch(`${scheme}://${host}:${config.http.port}/healthz`, {
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
