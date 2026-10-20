# @beamhop/turn

A STUN/TURN server in TypeScript for Bun. It uses only `Bun.udpSocket`, `Bun.listen` (TCP and TLS)
and `node:crypto`, with no native addons. It runs inside `@beamhop/relay` and also works standalone.

License: AGPL-3.0-only.

## What it implements

| Area | Status |
| --- | --- |
| STUN codec (RFC 8489) | Header, all attributes the server uses, XOR-MAPPED/PEER/RELAYED-ADDRESS (IPv4 and IPv6), USERNAME, REALM, NONCE, MESSAGE-INTEGRITY (HMAC-SHA1, long-term key `MD5(user:realm:SASLprep(pass))`), MESSAGE-INTEGRITY-SHA256 (parsed and verified, used in the response when the request used it), FINGERPRINT, ERROR-CODE, UNKNOWN-ATTRIBUTES, SOFTWARE. Checked against the RFC 5769 test vectors and fuzzed with fast-check. |
| Binding | UDP, TCP and TLS |
| Stream framing | RFC 4571-style over TCP and TLS: STUN messages and ChannelData padded to 4 bytes. A stream that cannot be framed is closed. |
| Allocate | Answers 401 with REALM and NONCE first, then accepts the authenticated request. REQUESTED-TRANSPORT must be UDP (otherwise 442). Supports REQUESTED-ADDRESS-FAMILY (IPv4 or IPv6) and ADDITIONAL-ADDRESS-FAMILY (dual allocation, or ADDRESS-ERROR-CODE when IPv6 fails), LIFETIME (clamped to [default, max]) and EVEN-PORT (R bit ignored). A retransmitted request gets the cached response; a new request on the same 5-tuple gets 437. |
| Refresh | Sets a new lifetime; `LIFETIME 0` deletes the allocation. Answers 437 when there is no allocation and 441 when the username differs. |
| CreatePermission | Installs or refreshes permissions for one or more peers (300 s). Answers 443 on a family mismatch and 403 when the `allowPeer` hook refuses. |
| Send / Data indications | Both directions; data is relayed only when a permission exists |
| ChannelBind + ChannelData | Channels 0x4000–0x4FFF last 600 s and also install a permission. A conflicting rebind gets 400. ChannelData flows in both directions. |
| Auth | Long-term credentials. Nonces are stateless (an HMAC over expiry and client IP); a stale nonce gets 438. Credential lookup may be async. TURN REST credentials via `restCredentials()`. |
| Quotas | Per-user or per-group `maxAllocations` (486) and `allowed:false` (403). `maxBps` is a token bucket shared by the group, covering both directions. A server-wide `maxAllocations` answers 508. |
| Accounting | Per-allocation byte and packet counters; `onUsage` deltas every `usageIntervalMs` and at deletion; `stats()` with live bps |
| Admin | `allocations()`, `kill(id)`, `stats()` |
| Transports | `turn:` over UDP and TCP, `turns:` over TLS (cert and key as files or PEM), and the `handleSocket` / `handleStream` hook for a TLS port the relay owns |
| CLI | `src/bin.ts` (static users and/or a TURN REST secret) |

### Not implemented or stubbed

- TCP allocations (RFC 6062): out of scope. REQUESTED-TRANSPORT=TCP gets 442.
- RESERVATION-TOKEN gets 508, and the EVEN-PORT R bit (port reservation) is ignored.
- DONT-FRAGMENT is accepted but not enforced, since Bun cannot set DF on UDP sockets.
- The RFC 8489 PASSWORD-ALGORITHMS, USERHASH and nonce security-feature bits are not used: only the MD5
  long-term key. A request carrying USERHASH gets 420.
- No ICMP attribute: Bun's UDP sockets do not surface ICMP errors.
- TLS certificates are not hot-reloaded. Restart the server, or call `stop()` and `start()`, after
  renewal.
- No DTLS.
- No per-IP rate limiting in the engine. The relay applies its listener-level limits and bans.
- Dual-stack client listeners: bind `host: '::'`, which is dual-stack on Linux. There is one UDP listener
  per server.

## Usage

```ts
import { createTurnServer, restCredentials } from '@beamhop/turn'

const turn = createTurnServer({
  realm: 'relay.example.com',
  listen: { udp: 3478, tcp: 3478, tls: { port: 5349, cert: '/etc/ssl/fullchain.pem', key: '/etc/ssl/key.pem' } },
  externalIp: '203.0.113.7',
  relayPorts: [50000, 50100],
  credentials: restCredentials({ secret: (appId) => apps.get(appId)?.turnSecret }),
  quota: (username) => {
    const app = appOf(username)
    return { group: app.id, maxAllocations: app.maxAllocations, maxBps: app.maxBps, allowed: !app.suspended }
  },
  onUsage: ({ username, bytesIn, bytesOut }) => usage.add(appOf(username).id, bytesIn + bytesOut),
})
const ports = await turn.start() // { udp: 3478, tcp: 3478, tls: 5349 } — port 0 is allowed
```

`credentials(username)` returns `{ password }` or `null`, or a promise of either. The server derives the
long-term key itself. `restCredentials()` checks the expiry in
`<expiry>:<appId>:<pubkey>` usernames and computes `base64(HMAC-SHA1(secret, username))`. This is
byte-compatible with `turnUsername` / `turnPassword` in `@beamhop/p2p/wire`, and a test checks that.

`quota(username)` may return `group`, an accounting key such as the appId. `maxAllocations` and
`maxBps` then apply to the whole group. Without a group they apply per username.

`onUsage` reports deltas: `bytesIn` is payload received from peers and relayed to the client, and
`bytesOut` is payload relayed from the client to peers. Reports go out every `usageIntervalMs`
(default 10 s) for allocations with traffic, and once more when an allocation is deleted.

Other options, all optional:

- `host`: default `0.0.0.0`.
- `externalIp`, `externalIp6`: advertised relayed addresses. They default to the relay bind address, or
  the first non-internal interface.
- `relayHost`, `relayHost6`: bind addresses for the relay sockets.
- `ipv6`: default true.
- `maxAllocations`: server-wide cap.
- `allowPeer(addr, port)`: a peer filter. Use it to block RFC 1918 or loopback peers in production.
- `software`: the SOFTWARE attribute.
- `timings`: `defaultLifetime`, `maxLifetime`, `permissionLifetime`, `channelLifetime`,
  `nonceLifetime`, `sweepMs`.
- `log(level, msg, extra)`.

`relayPorts: [0, 0]` lets the OS pick a relay port for each allocation, which is useful in tests.

### Serving `turns:` on 443 next to HTTPS

`Bun.serve` and `Bun.listen` cannot share a port, and `Bun.serve` cannot hand a raw TLS socket to other
code. To put `turns:` on 443, the relay must own 443 with `Bun.listen({ tls })` and sniff the first
decrypted bytes. A TURN-over-TLS stream always starts with a STUN request: first byte below 0x40,
magic cookie at bytes 4–7. HTTP/1 and HTTP/2 start with an uppercase ASCII method or `PRI`, so the
two never collide. `looksLikeStunStream()` makes this check.

```ts
Bun.listen<{ turn?: BunSocketSession; decided?: boolean }>({
  port: 443,
  tls: { cert, key },
  socket: {
    open(s) { s.data = {} },
    data(s, chunk) {
      if (!s.data.decided) {
        s.data.decided = true
        if (looksLikeStunStream(chunk)) s.data.turn = turn.handleSocket(s, 'tls')
        else return proxyToHttp(s, chunk) // pipe bytes to Bun.serve on 127.0.0.1 / a unix socket
      }
      s.data.turn?.data(chunk)
    },
    drain(s) { s.data.turn?.drain() },
    close(s) { s.data.turn?.close() },
  },
})
```

The tests run this pattern, with the HTTP branch answered inline. The cost is that every HTTPS and
WSS byte passes through a JS-level proxy hop, and `Bun.serve` sees the loopback address instead of the
client's IP. The relay has to map the proxy's local port back to the original peer. When that is not
worth it, or when a proxy such as Caddy owns 443, keep `turns:` on 5349. That is the plan's
documented fallback. `handleStream(conn)` is the same hook for any byte stream with `write` and `close`.

## CLI

```sh
bun packages/turn/src/bin.ts --realm turn.example.com --user alice:secret \
  --external-ip 203.0.113.7 --relay-ports 50000-50100
bun packages/turn/src/bin.ts --realm turn.example.com --secret "$TURN_REST_SECRET" \
  --cert fullchain.pem --key privkey.pem            # adds turns: on 5349
```

Run `--help` to see every flag. Each flag has a `TURN_*` environment variable. On startup the CLI
prints one JSON line, `{"event":"listening","udp":3478,"tcp":3478}`.

## Test client

`TurnClient` (from `@beamhop/turn` or `@beamhop/turn/client`) is a small TURN client for UDP, TCP and
TLS. It handles the 401 and 438 dance, retransmits on UDP, and supports Allocate, Refresh,
CreatePermission, ChannelBind, Send indications, ChannelData and Binding. The tests use it, and it also
works for health checks and load scripts.

## Tests

```sh
bun test packages/turn      # needs local UDP/TCP port binding
bunx tsc --noEmit -p packages/turn
```

- `stun.test.ts`: the RFC 5769 vectors (2.1–2.4: short-term and long-term integrity with SASLprep,
  IPv4 and IPv6 XOR-MAPPED-ADDRESS, FINGERPRINT), codec unit tests, and fast-check fuzzing. The fuzzer
  covers random bytes, random bodies behind valid headers, and mutated valid messages, and the
  decoders must never throw.
- `server.test.ts`: end-to-end tests over UDP, TCP and TLS against UDP echo peers:
  - Send indications and ChannelData in both directions, with permission enforcement.
  - IPv6 and dual allocations.
  - Refresh, expiry and `kill`, with `onUsage`.
  - Auth failures (401, 400, 438, 441), MESSAGE-INTEGRITY-SHA256, and TURN REST credentials from
    `@beamhop/p2p/wire`.
  - Quotas (486, 403, 508, and the bps cap), 420, 442, channel validation, and garbage input.
  - The shared-TLS-port hook.
- `bin.test.ts`: the CLI end to end.
- `interop.test.ts`: coturn `turnutils_uclient` over UDP and TCP. Skipped when the binary is absent.

## Benchmark

`bun packages/turn/bench/udp.ts [--size 1200] [--seconds 3] [--inproc]` measures packet throughput
through one channel relay on loopback, in two directions:

- client → ChannelData → server → UDP → sink
- sink → UDP → server → ChannelData → client

By default the server runs in its own process (`src/bin.ts`).

Measured on an Apple Silicon Mac (darwin/arm64), Bun 1.4.3, one allocation:

| Direction | Payload | Relayed pps | Throughput |
| --- | --- | --- | --- |
| client → peer (separate process) | 1200 B | ~153 k pps | ~1.47 Gbit/s |
| peer → client (separate process) | 1200 B | ~155 k pps | ~1.49 Gbit/s |
| client → peer (separate process) | 100 B | ~157 k pps | ~126 Mbit/s |
| peer → client (separate process) | 100 B | ~168 k pps | ~135 Mbit/s |
| client → peer (in-process) | 1200 B | ~98 k pps | ~0.94 Gbit/s |
| peer → client (in-process) | 1200 B | ~104 k pps | ~1.0 Gbit/s |

The server tops out at about 150–170 k packets per second per process. At that rate the cost per
packet dominates: packet size barely changes pps. In the separate-process peer → client run, the sender
outpaces the relay and the kernel drops the excess (about 7–15%). The plan's load target is 50
allocations at 2 Mbit/s, roughly 9 k pps at 1200 B, which is well within this budget.
