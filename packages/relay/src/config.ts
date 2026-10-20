import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RelayConfig {
  /** Holds nostr.db, admin.db, blobs/ and backups/. */
  dataDir: string
  /** Public base URL (https://relay.example). Empty = derived from each request's Host. */
  publicUrl: string
  http: {
    host: string
    port: number
    /** PEM files; both set = HTTPS/WSS, reloaded when they change on disk. */
    tlsCert: string
    tlsKey: string
    /** Honour X-Forwarded-For (only behind a trusted proxy such as Caddy). */
    trustProxy: boolean
    /** Requests per IP per minute across HTTP routes (0 = unlimited). */
    rateLimitPerMinute: number
  }
  turn: {
    enabled: boolean
    realm: string
    host: string
    /** Hostname advertised in iceServers (defaults to the publicUrl host). */
    publicHost: string
    externalIp: string
    udpPort: number
    tcpPort: number
    /** turns: port; 0 disables. Uses the http TLS cert. */
    tlsPort: number
    relayPortMin: number
    relayPortMax: number
    /** Lifetime of minted TURN REST credentials, seconds. */
    credentialTtl: number
  }
  nostr: {
    name: string
    description: string
    contact: string
    pubkey: string
    icon: string
  }
  data: {
    /** Largest binary frame accepted on the data relay. */
    maxFrameBytes: number
    /** Messages per connection per second (0 = unlimited). */
    messagesPerSecond: number
  }
  blossom: {
    maxUploadBytes: number
    /** Empty = any type. Entries may end with `/*`. */
    allowedMime: string[]
    /** Default per-app quota for new apps and the public scope (0 = unlimited). */
    defaultQuotaBytes: number
    /** Per-pubkey quota within a scope (0 = unlimited). */
    perPubkeyQuotaBytes: number
    /** Require kind 24242 auth for GET /list. */
    requireAuthForList: boolean
  }
  payments: {
    /** nostr+walletconnect:// URI (NIP-47). Admin UI edits persist to admin.db. */
    nwcUrl: string
    /** When true, writes to the public relay require a paid plan (writeAllowed hook). */
    required: boolean
    invoiceExpirySec: number
  }
  backups: {
    enabled: boolean
    /** Local hour (0-23) for the nightly backup. */
    hour: number
    retentionDays: number
    /** Defaults to <dataDir>/backups. */
    dir: string
  }
  log: { level: LogLevel }
  alerts: {
    diskPercent: number
    /** Fraction of 5xx responses over the last 5 minutes that raises an alert. */
    errorRate: number
    certDays: number
  }
  admin: {
    /** Static build of @beamhop/relay-admin; empty = auto-detect packages/relay-admin/dist. */
    distDir: string
    sessionTtlHours: number
    /** Extra origins accepted on admin writes besides the request's own origin. */
    allowedOrigins: string[]
  }
  metrics: {
    /** Optional bearer token protecting /metrics. */
    token: string
  }
}

export const defaultConfig: RelayConfig = {
  dataDir: './data',
  publicUrl: '',
  http: {
    host: '0.0.0.0',
    port: 443,
    tlsCert: '',
    tlsKey: '',
    trustProxy: false,
    rateLimitPerMinute: 1200,
  },
  turn: {
    enabled: true,
    realm: 'beamhop',
    host: '0.0.0.0',
    publicHost: '',
    externalIp: '',
    udpPort: 3478,
    tcpPort: 3478,
    tlsPort: 5349,
    relayPortMin: 50000,
    relayPortMax: 50100,
    credentialTtl: 86400,
  },
  nostr: {
    name: 'Beamhop relay',
    description: 'Nostr relay by Beamhop',
    contact: '',
    pubkey: '',
    icon: '',
  },
  data: { maxFrameBytes: 256 * 1024, messagesPerSecond: 2000 },
  blossom: {
    maxUploadBytes: 100 * 1024 * 1024,
    allowedMime: [],
    defaultQuotaBytes: 5 * 1024 ** 3,
    perPubkeyQuotaBytes: 500 * 1024 ** 2,
    requireAuthForList: false,
  },
  payments: { nwcUrl: '', required: false, invoiceExpirySec: 3600 },
  backups: { enabled: true, hour: 3, retentionDays: 14, dir: '' },
  log: { level: 'info' },
  alerts: { diskPercent: 80, errorRate: 0.05, certDays: 14 },
  admin: { distDir: '', sessionTtlHours: 24 * 7, allowedOrigins: [] },
  metrics: { token: '' },
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys)
  if (!isObj(v)) return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]))
}

/** Deep-merge `src` into a copy of `base`, keeping only keys known to `base` and coercing types. */
export function mergeKnown<T>(base: T, src: unknown, path = ''): T {
  if (!isObj(src)) return structuredClone(base)
  const out = structuredClone(base) as Obj
  for (const [k, v] of Object.entries(src)) {
    if (!(k in out)) continue
    const cur = out[k]
    if (isObj(cur)) out[k] = mergeKnown(cur, v, `${path}${k}.`)
    else out[k] = coerce(cur, v, `${path}${k}`)
  }
  return out as T
}

function coerce(current: unknown, v: unknown, key: string): unknown {
  if (typeof current === 'number') {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) throw new Error(`config ${key}: expected a number`)
    return n
  }
  if (typeof current === 'boolean') {
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0' || v === '') return false
    throw new Error(`config ${key}: expected a boolean`)
  }
  if (Array.isArray(current)) {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string')
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    throw new Error(`config ${key}: expected a list`)
  }
  return String(v)
}

/**
 * Env overrides: `BEAMHOP_<KEY>` for top-level keys (BEAMHOP_DATA_DIR) and
 * `BEAMHOP_<SECTION>_<KEY>` for section keys (BEAMHOP_HTTP_PORT, BEAMHOP_TURN_EXTERNAL_IP).
 * Lists are comma separated.
 */
export function envOverrides(env: Record<string, string | undefined>): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(defaultConfig)) {
    if (isObj(v)) {
      for (const sk of Object.keys(v)) {
        const name = `BEAMHOP_${snake(k)}_${snake(sk)}`.toUpperCase()
        const val = env[name]
        if (val !== undefined) {
          out[k] ??= {}
          const sec = out[k] as Obj
          sec[sk] = val
        }
      }
    } else {
      const val = env[`BEAMHOP_${snake(k)}`.toUpperCase()]
      if (val !== undefined) out[k] = val
    }
  }
  return out
}

export interface LoadedConfig {
  config: RelayConfig
  /** Path of the TOML file used, if any. */
  path: string | null
  /** Dotted keys set through the environment (locked against admin edits). */
  envKeys: string[]
}

function flatKeys(o: Obj, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    isObj(v) ? flatKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}

/** Parse TOML text (snake_case keys) into a partial config object. */
export function parseToml(text: string): Obj {
  return camelKeys(Bun.TOML.parse(text)) as Obj
}

/**
 * Load `beamhop-relay.toml` (explicit path, $BEAMHOP_CONFIG, ./beamhop-relay.toml) and apply
 * BEAMHOP_* env overrides on top of the defaults.
 */
export function loadConfig(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): LoadedConfig {
  const candidate =
    path ??
    env.BEAMHOP_CONFIG ??
    (existsSync('beamhop-relay.toml') ? 'beamhop-relay.toml' : undefined)
  let fileObj: Obj = {}
  let used: string | null = null
  if (candidate) {
    const abs = resolve(candidate)
    if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`)
    fileObj = parseToml(readFileSync(abs, 'utf8'))
    used = abs
  }
  const envObj = envOverrides(env)
  let config = mergeKnown(defaultConfig, fileObj)
  config = mergeKnown(config, envObj)
  return { config, path: used, envKeys: flatKeys(envObj) }
}

/** Build a full config from a partial one (used by tests and embedders). */
export function makeConfig(partial: DeepPartial<RelayConfig> = {}): RelayConfig {
  return mergeKnown(defaultConfig, partial)
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** Render a config as TOML (snake_case keys). */
export function toToml(config: RelayConfig): string {
  const lines: string[] = []
  const fmt = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(fmt).join(', ')}]`
      : typeof v === 'string'
        ? JSON.stringify(v)
        : String(v)
  const sections: [string, Obj][] = []
  for (const [k, v] of Object.entries(config)) {
    if (isObj(v)) sections.push([k, v])
    else lines.push(`${snake(k)} = ${fmt(v)}`)
  }
  for (const [name, sec] of sections) {
    lines.push('', `[${snake(name)}]`)
    for (const [k, v] of Object.entries(sec)) lines.push(`${snake(k)} = ${fmt(v)}`)
  }
  return `${lines.join('\n')}\n`
}
