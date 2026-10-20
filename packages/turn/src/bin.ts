#!/usr/bin/env bun
// Standalone STUN/TURN server.
//   bun src/bin.ts --realm example.org --user alice:secret
//   bun src/bin.ts --realm example.org --secret <TURN REST shared secret>
// Every flag can also be given as an environment variable (TURN_REALM, TURN_SECRET, ...).
import { parseArgs } from 'node:util'
import { restCredentials } from './rest'
import { createTurnServer } from './server'

const HELP = `beamhop-turn — STUN/TURN server (RFC 8489/8656) for Bun

Options (env var in brackets):
  --realm <realm>            authentication realm [TURN_REALM] (required)
  --user <name:password>     static user, repeatable [TURN_USERS=a:x,b:y]
  --secret <secret>          TURN REST shared secret [TURN_SECRET]
  --host <addr>              bind address, default 0.0.0.0 [TURN_HOST]
  --udp-port <n>             STUN/TURN over UDP, default 3478 (-1 disables) [TURN_UDP_PORT]
  --tcp-port <n>             STUN/TURN over TCP, default 3478 (-1 disables) [TURN_TCP_PORT]
  --tls-port <n>             turns: over TLS, default 5349 when --cert is set [TURN_TLS_PORT]
  --cert <file> --key <file> TLS certificate and key (PEM) [TURN_CERT, TURN_KEY]
  --external-ip <addr>       advertised relayed IPv4 (or IPv6) address [TURN_EXTERNAL_IP]
  --external-ip6 <addr>      advertised relayed IPv6 address [TURN_EXTERNAL_IP6]
  --relay-ports <lo-hi>      relay port range, default 50000-50100 [TURN_RELAY_PORTS]
  --no-ipv6                  do not offer IPv6 relayed addresses [TURN_NO_IPV6=1]
  --max-allocations <n>      per-user allocation cap [TURN_MAX_ALLOCATIONS]
  --max-bps <n>              per-user bandwidth cap in bits/s [TURN_MAX_BPS]
  --total-allocations <n>    server-wide allocation cap [TURN_TOTAL_ALLOCATIONS]
  --verbose                  log every allocation [TURN_VERBOSE=1]
  --help
`

const env = process.env
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    realm: { type: 'string', default: env.TURN_REALM },
    user: { type: 'string', multiple: true },
    secret: { type: 'string', default: env.TURN_SECRET },
    host: { type: 'string', default: env.TURN_HOST ?? '0.0.0.0' },
    'udp-port': { type: 'string', default: env.TURN_UDP_PORT ?? '3478' },
    'tcp-port': { type: 'string', default: env.TURN_TCP_PORT ?? '3478' },
    'tls-port': { type: 'string', default: env.TURN_TLS_PORT ?? '5349' },
    cert: { type: 'string', default: env.TURN_CERT },
    key: { type: 'string', default: env.TURN_KEY },
    'external-ip': { type: 'string', default: env.TURN_EXTERNAL_IP },
    'external-ip6': { type: 'string', default: env.TURN_EXTERNAL_IP6 },
    'relay-ports': { type: 'string', default: env.TURN_RELAY_PORTS ?? '50000-50100' },
    'no-ipv6': { type: 'boolean', default: env.TURN_NO_IPV6 === '1' },
    'max-allocations': { type: 'string', default: env.TURN_MAX_ALLOCATIONS },
    'max-bps': { type: 'string', default: env.TURN_MAX_BPS },
    'total-allocations': { type: 'string', default: env.TURN_TOTAL_ALLOCATIONS },
    verbose: { type: 'boolean', default: env.TURN_VERBOSE === '1' },
    help: { type: 'boolean', default: false },
  },
})

function fail(msg: string): never {
  console.error(`beamhop-turn: ${msg}\n\n${HELP}`)
  process.exit(2)
}

if (values.help) {
  console.log(HELP)
  process.exit(0)
}
if (!values.realm) fail('--realm is required')

const users = new Map<string, string>()
for (const u of [...(values.user ?? []), ...(env.TURN_USERS?.split(',').filter(Boolean) ?? [])]) {
  const i = u.indexOf(':')
  if (i <= 0) fail(`invalid --user ${u} (expected name:password)`)
  users.set(u.slice(0, i), u.slice(i + 1))
}
if (users.size === 0 && !values.secret) fail('give at least one --user or a --secret')

const rest = values.secret ? restCredentials({ secret: values.secret }) : null
const port = (s: string | undefined, name: string): number | undefined => {
  if (s === undefined) return undefined
  const n = Number(s)
  if (!Number.isInteger(n) || n < -1 || n > 65535) fail(`invalid ${name}: ${s}`)
  return n < 0 ? undefined : n
}
const num = (s: string | undefined): number | undefined =>
  s === undefined || s === '' ? undefined : Number(s)

const range = /^(\d+)-(\d+)$/.exec(values['relay-ports'] ?? '')
if (!range) fail('invalid --relay-ports (expected lo-hi)')
const relayPorts: [number, number] = [Number(range[1]), Number(range[2])]

if ((values.cert && !values.key) || (!values.cert && values.key))
  fail('--cert and --key go together')

const maxAllocations = num(values['max-allocations'])
const maxBps = num(values['max-bps'])
const verbose = values.verbose

const server = createTurnServer({
  realm: values.realm,
  host: values.host,
  listen: {
    udp: port(values['udp-port'], '--udp-port'),
    tcp: port(values['tcp-port'], '--tcp-port'),
    ...(values.cert && values.key
      ? {
          tls: {
            port: port(values['tls-port'], '--tls-port') ?? 5349,
            cert: values.cert,
            key: values.key,
          },
        }
      : {}),
  },
  externalIp: values['external-ip'],
  externalIp6: values['external-ip6'],
  ipv6: !values['no-ipv6'],
  relayPorts,
  maxAllocations: num(values['total-allocations']),
  credentials(username) {
    const pw = users.get(username)
    if (pw !== undefined) return { password: pw }
    return rest ? rest(username) : null
  },
  ...(maxAllocations !== undefined || maxBps !== undefined
    ? { quota: () => ({ maxAllocations, maxBps }) }
    : {}),
  log(level, msg, extra) {
    if (level === 'debug' || (level === 'info' && !verbose)) return
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }))
  },
})

const ports = await server.start()
console.log(JSON.stringify({ event: 'listening', ...ports }))

const shutdown = async () => {
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
