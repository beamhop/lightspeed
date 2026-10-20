# @beamhop/signaling-nostr

Nostr signaling adapter for [`@beamhop/p2p`](../p2p). Peers find each other and exchange
offer/answer/ICE through ephemeral Nostr events on public relays or on your own Beamhop relay.

```ts
import { nostrSignaling } from '@beamhop/signaling-nostr'

// A SignalingFactory: pass it to the room as its `signaling` option.
const signaling = nostrSignaling({
  relays: ['wss://relay.example/a/my-app', 'wss://nos.lol'],
  powBits: 0, // NIP-13 proof of work on outgoing events
  auth: true, // answer NIP-42 AUTH challenges (default)
})

// The room calls it with its identity; the adapter can also be used directly:
const adapter = signaling({ identity })
const off = adapter.subscribe(topic, (signal) => console.log(signal.kind, signal.from))
await adapter.announce(topic, encryptedAnnounce)
await adapter.send(topic, peerPubkey, nip44Payload)
```

## Wire format

| Event | Kind | Tags | Content |
| --- | --- | --- | --- |
| Announce | `20100` (ephemeral) | `t` = room topic, `expiration` = now + 30 s | opaque string (the room encrypts it with the room key) |
| Directed signal | `20101` (ephemeral) | `t` = room topic, `p` = recipient, `expiration` = now + 60 s | opaque string (NIP-44 to the recipient) |

Events are signed with the room `Identity`: the adapter builds the NIP-01 id
(`sha256([0, pubkey, created_at, kind, tags, content])`) and calls `identity.sign(id)` (BIP-340).
With `powBits > 0` a NIP-13 `nonce` tag is mined first.

The subscription is a single `REQ` with two filters:

```json
[{ "kinds": [20100], "#t": ["<topic>"], "since": "<now - 30>" },
 { "kinds": [20101], "#t": ["<topic>"], "#p": ["<me>"], "since": "<now - 60>" }]
```

## Relay pool

The package ships its own small pool (`RelayPool`, also exported):

- **Reconnect** with exponential backoff and jitter (`minBackoffMs` 500, `maxBackoffMs` 30 000).
  Subscriptions are re-sent on every reconnect with a fresh `since`; unacknowledged events are re-sent.
- **Publish** goes to every relay; `announce`/`send` resolve when one relay answers `OK true` and reject
  when all relays reject or time out (`publishTimeoutMs`, default 10 s).
- **Dedupe** by event id across relays, per subscription.
- **Verification**: every incoming event's id and Schnorr signature are checked (`@noble/curves`);
  invalid events are dropped and counted in `pool.dropped`.
- **Freshness**: events from the future (> 30 s skew), older than the TTL, or past their NIP-40
  `expiration` are dropped; so are own echoes, directed signals for other recipients and events
  below `minPowBits`.
- **NIP-42**: when a relay sends `["AUTH", challenge]` the adapter answers with a kind 22242 event signed
  by the room identity. Events rejected with `auth-required:` and subscriptions `CLOSED` with
  `auth-required:` are retried once the relay acknowledges the AUTH. Disable with `auth: false`.
- **Rate limits**: `OK false "rate-limited: ..."`, `CLOSED "rate-limited: ..."` or a `NOTICE` that mentions
  rate limiting pauses writes to that relay with doubling backoff, then retries.
- **Status**: `adapter.status()` returns `{ url, state: 'connecting' | 'open' | 'closed' | 'error', error? }`
  per relay (last `NOTICE`/close reason in `error`).

## Options

| Option | Default | |
| --- | --- | --- |
| `relays` | — | relay URLs (required) |
| `powBits` | `0` | NIP-13 difficulty for outgoing events |
| `minPowBits` | `0` | drop incoming events with less PoW |
| `auth` | `true` | answer NIP-42 challenges |
| `WebSocket` | `globalThis.WebSocket` | constructor override (Node < 22, tests) |
| `minBackoffMs` / `maxBackoffMs` | `500` / `30000` | reconnect backoff bounds |
| `publishTimeoutMs` | `10000` | per-relay wait for `OK` |

## Tests

`bun test packages/signaling-nostr` runs against a small in-process Nostr relay
(`src/fake-relay.test-util.ts`, `Bun.serve` on port 0): announce + directed exchange over two relays with
dedupe, reconnect after a relay restart, queued publishes, NIP-42 AUTH, bad signatures / stale / expired
events dropped, and rate-limit retry.

MIT licensed.
