# @beamhop/p2p

Typed peer-to-peer rooms: Nostr signaling, WebRTC / relay / memory transports, identity-keyed
sessions that survive drops, mesh and star topologies, CRDT-ish shared state, file streams and a
telemetry bus. Runs in browsers, Bun, Node and workers. A Bun server peer needs only the relay
transport, no WebRTC. MIT.

```ts
import { action, anonymous, createRoom, defineProtocol, relayTransport, request } from '@beamhop/p2p'
import { webrtc } from '@beamhop/p2p/webrtc'
import { nostrSignaling } from '@beamhop/signaling-nostr'
import { z } from 'zod' // or Valibot or ArkType: any Standard Schema

const protocol = defineProtocol({
  chat: action(z.object({ text: z.string() })),
  cursor: action(z.object({ x: z.number(), y: z.number() }), { reliability: 'unreliable' }),
  ping: request(z.number(), z.number()),
})

const room = await createRoom({
  appId: 'my-app',
  roomId: 'lobby',
  identity: anonymous({ persist: true }),
  signaling: nostrSignaling({ relays: ['wss://relay.example/a/my-app'] }),
  transports: [webrtc(), relayTransport({ url: 'wss://relay.example/a/my-app/data' })],
  protocol,
  meta: { name: 'Ada' },
})

room.onPeerJoin((p) => console.log('joined', p.meta.name, p.path))
room.action('chat').onMessage(({ text }, from) => console.log(from, text))
await room.action('chat').send({ text: 'hi' })                  // resolves when acknowledged
room.request('ping').handle((n) => n + 1)
const pong = await room.request('ping').call(peerPubkey, 41)
room.state.map<number>('scores').set('ada', 10)                // LWW on hybrid logical clocks
room.state.log<string>('events').append('started')             // append-only, per-author seq
await room.sendFile(file, { to: peerPubkey, onProgress: (s, t) => {} })
room.onFile(async (f) => save(await f.bytes()))                 // f.stream is a ReadableStream
```

## Layers

| Layer | Default | Swap with |
| --- | --- | --- |
| Identity | `anonymous()` | `nostr({ nsec } \| { extension } \| { bunker })`, `oidc({ getCert })`, any `Identity` |
| Signaling | `@beamhop/signaling-nostr` | `memorySignaling(hub)`, `unionSignaling(a, b, ...)`, any `SignalingFactory` |
| Transport | `webrtc()` (`@beamhop/p2p/webrtc`) | `relayTransport({ url })`, `memoryTransport(hub)` |
| Topology | `'mesh'` | `{ star: { host? } }` |
| Protocol | untyped | `defineProtocol({ name: action(schema) \| request(req, res) })` |

### Identity

Every peer has a **session key** (secp256k1, BIP-340). Providers add attestations of who vouches for it:

- `anonymous({ persist?, storage?, secretKey? })`: ephemeral key; `persist` stores it in IndexedDB (no-op where
  IndexedDB is missing; inject `storage` for tests).
- `nostr(...)`: a fresh session key vouched for by the user's Nostr key, via a NIP-07 extension (`window.nostr`
  or `{ extension }`), an `nsec`, or a NIP-46 bunker: `nip46Signer({ transport, remotePubkey, secret })`, where
  `transport` is any `{ publish(event), subscribe(filter, cb) }` pair. `parseBunkerUrl('bunker://...')` helps.
- `oidc({ getCert })`: your backend checks the user's OIDC token and returns
  `signAttestationCert({ alg: 'ES256' | 'EdDSA', privateKey, kid, iss, sub, pubkey })`, a JWS
  `{ v: 1, iss, sub, pubkey, iat, exp }`. Peers check it with `verifyAttestation(att, sessionPubkey, { jwks })`
  (ES256, EdDSA, RS256; JWKS from OIDC discovery, cached, or `staticJwks`).

#### Nostr session attestation (signed-message format)

The Nostr key signs a Nostr **event** (so NIP-07 and NIP-46 signers work unchanged):

```
kind       = 28100 (KIND_SESSION_ATTESTATION)
created_at = attestation.created_at (0 when absent)
tags       = [["p", <session pubkey hex>]]
content    = "beamhop-session"
pubkey     = attestation.pubkey (the Nostr user key)
```

The message is the NIP-01 event id, `sha256(JSON.stringify([0, pubkey, created_at, 28100, [["p", session]], "beamhop-session"]))`,
and `attestation.sig` is the BIP-340 signature over it. The attestation is
`{ type: 'nostr', pubkey, sig, created_at }`. `createNostrAttestation(signer, sessionPubkey)` and
`verifyNostrAttestation(att, sessionPubkey)` implement it.

### Room policy and capabilities

```ts
policy: {
  attest: { anonymous: false, nostr: { pubkeys: [admin] }, oidc: { iss: 'https://auth.example' } },
  jwks: staticJwks({...}),                    // optional
  capabilities: { issuers: [appKey], require: ['join'] },
  dev: false,                                 // dev: accept any validly signed token
  admit: (peer) => true,                      // final say
}
```

A peer is admitted when all of its attestations verify, at least one matches `attest` (when set), and
its capability token (if `require`d) verifies. Tokens are `{ v: 1, room, pubkey, caps, exp, iss, sig }`
with `sig` = BIP-340 over `sha256(JSON.stringify(['beamhop-cap/v1', room, pubkey, caps, exp, iss]))`;
issue them with `issueCapability(appSecretKey | hostIdentity, { room: topic | '*', pubkey, caps })`.
In star rooms the current host is a trusted issuer too. A peer with the `debug` cap may call
`room.telemetry.observe(peer)` to receive that peer's telemetry on the reserved `__beamhop/telemetry`
channel (`room.telemetry.subscribeRemote`).

## Connection manager

- **Who connects:** the lower session pubkey initiates; the higher one sends a `knock` directed signal
  when it wants a link, so recovery never waits for a backoff. A knock that arrives while we hold a link
  older than 2 s means the far side lost it, so we drop ours and resume.
- **Ladder:** `transports` are tried in order with a per-rung timeout (`timeouts.connectMs`, default 15 s),
  e.g. `[webrtc({ stun }), webrtc({ turn, iceTransportPolicy: 'relay' }), relayTransport({ url })]`
  gives direct → TURN → relay. Failures back off from 0.5 s to 8 s.
- **relayFirst:** the transport named `relay` is tried in parallel with the rest of the ladder; the session
  starts on whichever path is ready first and migrates to a better path (direct > TURN > relay) when it
  comes up. Unacknowledged units are re-sent on the new path and de-duplicated by the receiver.
- **Sessions are keyed by identity.** When a link drops, the peer becomes `away` (telemetry
  `connection: away`), the initiator reconnects, and the new handshake carries each side's receive cursors,
  so only missing units are re-sent (`back`). After `timeouts.resumeWindowMs` (30 s) the peer leaves. A
  different `sid` in a handshake or announce means the peer restarted: leave + join.
- **Topology:** mesh connects everyone (intended for 12 peers or fewer). Star picks the explicit host if it
  is present, else the lowest pubkey; clients hold one session to the host, which forwards messages
  (stamping the true origin) and sends a roster so clients still see every member (`peer.via = 'host'`).
  When the host leaves, the next lowest pubkey takes over; members stay in the room through the handoff.

## Channels, framing, reliability

Each connection carries three channels: `bh/r` (reliable, ordered), `bh/u` (reliable, unordered) and
`bh/x` (unreliable, `maxRetransmits: 0`). Frames use `wire.ts` (`version · type · streamId · length ·
payload`); payloads are CBOR (own small codec, `encodeCbor`/`decodeCbor`).

- Reliable units carry a per-lane sequence number; receivers send cumulative acks (5 ms delay). Sends resolve
  when acknowledged (at-least-once), and receivers drop duplicates (exactly-once delivery to the app).
- Payloads over 16 KiB are split into chunks with a stream id; progress is reported through `onProgress` and
  telemetry `progress` events.
- A priority queue (high / normal / low; files are low) feeds the link. Sequence numbers are assigned at
  dequeue so priority never blocks the ordered lane. The queue stops at 256 KiB `bufferedAmount` and resumes
  on `bufferedAmountLow` (64 KiB).
- Files: `sendFile(Blob | ReadableStream | Uint8Array, { to, name, mime, onProgress })` waits for the
  queue to drain between pieces; receivers get `IncomingFile { stream, bytes(), onProgress }`.

## State

`room.state.map(name)` is a last-writer-wins map on hybrid logical clocks (ties broken by node id;
deletes are tombstones). `room.state.log(name)` is append-only with per-author sequence numbers, ordered
by HLC. Ops and snapshots merge commutatively and idempotently. When a session first joins, each side
asks the other for a snapshot (in star rooms that is the host and the client), so late joiners and
peers rejoining after a long partition catch up. `room.state.digest()` is equal on converged peers.

## Telemetry and Studio

`room.telemetry.subscribe(cb, { replay })` emits the `TelemetryEvent`s defined in `types.ts`
(signal, connection, path, bytes, rtt, message with decoded payload, progress, peer, plus `error` and
`host`). Set `telemetry: false` to disable it.

`room.devtools({ onIdentity?, channel?, createChannel? })` speaks Studio's in-page bridge protocol on
`BroadcastChannel('beamhop-devtools:<roomId>')`:

- page → Studio: `{ type: 'hello', self, peers }`, `{ type: 'peers', peers }`,
  `{ type: 'telemetry', source, event }`, `{ type: 'connection-info', source, peer, info }`,
  `{ type: 'admission', pubkey, admitted, reason? }`
- Studio → page: `studio-hello` (re-sends hello and replays recent telemetry), `fault` / `clear-fault`
  (latency, loss, partition, kill; applied to every `MemoryHub` behind the room's memory transports and
  reverted on clear; with live transports `kill` and `partition` drop links), `identity` (evaluated
  against the room policy), `connection-info?` (channels, buffer levels, candidate pair).

## Transports

- `memoryTransport(hub)`: `createMemoryHub({ clock, seed, defaults: { latencyMs, jitterMs, loss,
  bandwidthBps, path }, detectMs })`. Fault hooks: `setLink`, `setDefaults`, `partition(a, b)` → id,
  `unpartition(id)`, `heal()`, `kill(pk)`, `revive(pk)`, `connections()`. Loss drops unreliable frames and
  delays reliable ones by a retransmit. All randomness comes from the seeded RNG.
- `relayTransport({ url, appId?, WebSocket? })`: one authenticated socket per identity multiplexes every peer.
  The relay sends `challenge`, the client answers `hello { pubkey, sig = schnorr(relayHelloHash(appId,
  challenge)) }` and the relay replies `ready`. Binary messages are `encodeRelayEnvelope(pubkey, body)`, with
  `body = type u8 · connId 8 · rest`: `1 CONNECT(nonceI 32)`, `2 ACCEPT(nonceR 32)`, `3 DATA`, `4 CLOSE`.
  DATA is ChaCha20-Poly1305 under `HKDF-SHA256(NIP-44 conversation key, salt = nonceI‖nonceR,
  info = 'beamhop/v1 relay i2r' | 'r2i')` with a 96-bit nonce of 4 zero bytes followed by a u64
  per-direction counter. Plaintext is `op u8 · channel u16 · …` (0 open: mode, maxRetransmits, label;
  1 message; 2 close). The rendezvous uses the signal pipe: `relay-connect { url }` → `relay-ready`.
- `webrtc()`: `@beamhop/p2p/webrtc`, maintained separately.

## Wire summary (room level)

- Topic and room key: `roomTopic` and `roomKey` in `wire.ts`.
- Announce (kind 20100): `base64(nonce12 ‖ AES-256-GCM(roomKey, JSON { v, pubkey, sid, attestations, meta,
  cap?, ttl: 30, ts, leave? }))`, re-sent every 20 s plus once when a new peer appears; `leave: true` on exit.
- Directed signal (kind 20101): NIP-44 v2 to the recipient, `JSON { v, tr: transport name, at: attempt id,
  m: TransportSignal }`; `tr: ''` carries room control (`knock`).
- Handshake: first frames on `bh/r` (type Hello): `['h1', { v, pubkey, sid, topic, nonce32, attestations,
  meta, cap?, known?: { sid, recv } }]`, then after admission `['h2', sig]` with
  `sig = schnorr(sha256(cbor(['beamhop-hs/v1', topic, signer, verifier, signerNonce, verifierNonce,
  sha256(signer h1 bytes)])))`. `onPeerJoin` fires only after both signatures verify.
- Session units (type Data): `[0, lane, seq, idx, count, bytes]` (streamId in the frame header),
  `[1, bytes]` unreliable, `[2, lane, cumAck]`; Ping frames `[0|1, t]`; Close `[reason]`.

## NIP-44

`import { nip44 } from '@beamhop/p2p'` (or `@beamhop/p2p/nip44`): `getConversationKey`, `encrypt`, `decrypt`,
`calcPaddedLen`, `getMessageKeys`, tested against the official vectors.

## Simulator

```ts
const clock = new VirtualClock()
const net = createMemoryHub({ clock, seed: 42, defaults: { latencyMs: 20, jitterMs: 10, loss: 0.05 } })
const signaling = createSignalingHub({ clock, latencyMs: 15 })
const room = await createRoom({ ..., transports: [memoryTransport(net)], signaling: memorySignaling(signaling), clock })
await clock.until(() => room.peers.length === 4)
await clock.run(room.action('chat').send(...))   // advance virtual time until the promise settles
```

With fixed secret keys and a seed, runs are bit-for-bit reproducible (`src/sim.test.ts` checks this).

## Status

Implemented: everything above. Not implemented yet, or partial:

- The `webrtc` transport is a separate module (`src/transport/webrtc.ts`).
- TURN-vs-direct on WebRTC is up to the WebRTC transport's reported `path`; the ladder ranks paths but does not
  try to upgrade a long-lived relay session except through `relayFirst`.
- Unreliable sends are dropped (not queued) while a peer is away.
- Fault injection on live WebRTC channels (latency and loss) needs a dev hook in the WebRTC transport.
- Third-peer relaying and the Yjs adapter are planned for v2.

## Development

```sh
bun test packages/p2p            # relay tests bind a local WebSocket server on port 0
bunx tsc --noEmit -p packages/p2p
SIM_SEEDS=40 bun test packages/p2p/src/sim.test.ts   # sweep simulator seeds
```
