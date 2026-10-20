# Beamhop wire protocol, version 1

Status: **0.x draft, subject to change.** This document is the normative description of everything a
Beamhop peer puts on the wire: what it publishes to Nostr relays, what it sends to other peers over a
transport, and what it exchanges with a Beamhop relay. The reference implementation of the shared
primitives is `packages/p2p/src/wire.ts` (`@beamhop/p2p/wire`). Where this document and `wire.ts`
disagree, `wire.ts` wins and this document is the bug.

Sections marked **(draft)** describe behaviour that `@beamhop/p2p` will implement but whose exact
byte layout is not yet fixed in `wire.ts`. Implementers outside this repository should wait for 1.0
before depending on them.

## 1. Conventions

- The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.
- `‖` is byte concatenation. Integers are unsigned and **big-endian** unless stated otherwise.
- `hex` is lowercase hexadecimal without a prefix. `utf8(s)` is the UTF-8 encoding of `s`.
- Public keys are 32-byte x-only secp256k1 keys (BIP-340), written as 64 hex characters. Signatures
  are 64-byte BIP-340 Schnorr signatures, written as 128 hex characters.
- `sha256`, `HMAC`, `HKDF` are SHA-256, RFC 2104 and RFC 5869. NIP-44 refers to NIP-44 version 2.
- JSON is UTF-8 encoded, without a byte-order mark. Unknown fields MUST be ignored.

### Constants

| Name | Value | Meaning |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | First byte of every data frame; `v` in JSON payloads |
| `KIND_ANNOUNCE` | `20100` | Nostr kind for room-wide announces (ephemeral range) |
| `KIND_SIGNAL` | `20101` | Nostr kind for directed signals (ephemeral range) |
| `ANNOUNCE_TTL_S` | `30` | Seconds an announce stays valid |
| `ANNOUNCE_INTERVAL_S` | `20` | Seconds between re-announces |
| `CHUNK_SIZE` | `16384` | Maximum payload bytes per data frame for chunked transfers |
| `FRAME_HEADER` | `6` | Data frame header size in bytes |
| `TELEMETRY_CHANNEL` | `__beamhop/telemetry` | Reserved channel label for Studio telemetry |

## 2. Identities and keys

Every peer has a **session keypair**: a secp256k1 key used to sign Nostr events, sign handshakes,
answer relay challenges and derive pairwise encryption keys. The session pubkey is the peer's
identity in a room. Who stands behind it is expressed by **attestations**:

```ts
type Attestation =
  | { type: 'anonymous' }
  | { type: 'nostr'; pubkey: Hex; sig: Hex }
  | { type: 'oidc'; jws: string }
```

- `anonymous`: no claim. The session key is ephemeral (optionally persisted on the device).
- `nostr`: the long-lived Nostr key `pubkey` vouches for the session key. **(draft)** `sig` is a
  BIP-340 signature by `pubkey` over `sha256(utf8("beamhop/v1 attest:") ‖ utf8(sessionPubkeyHex))`.
  With NIP-07 or NIP-46 signers, which only sign events, the signer instead signs a kind 27235
  event whose content is the session pubkey; `sig` is then that event's signature and verifiers
  rebuild the event id. A peer MAY use its Nostr key directly as the session key, in which case
  the attestation is implicit.
- `oidc`: see section 8.

Room policy decides which attestations admit a peer (for example "any", "nostr pubkey in list",
"oidc issuer equals X"). Verification happens during the handshake (section 6), before the
application sees `onPeerJoin`.

## 3. Rooms: topic and room key

A room is identified by `(appId, roomId, password)`; `password` is the empty string when absent. All
three are UTF-8 strings. They are serialized as

```
input = utf8("beamhop/v1")
      ‖ u32(len(utf8(appId)))    ‖ utf8(appId)
      ‖ u32(len(utf8(roomId)))   ‖ utf8(roomId)
      ‖ u32(len(utf8(password))) ‖ utf8(password)
```

The length prefixes make `("ab", "c")` and `("a", "bc")` distinct.

- **Room topic**: `topic = hex(sha256(input))`. The topic is public: it is carried in the `t` tag of
  every Nostr event so that relays index it. Anyone who knows the three inputs can compute it.
- **Room key**: `roomKey = HKDF-SHA256(ikm = input, salt = none, info = utf8("beamhop/v1 room key"), L = 32)`.
  "salt = none" means the RFC 5869 default (a string of 32 zero bytes). The room key encrypts
  announces (section 4.1). A password therefore changes both the topic and the key, and a relay
  operator who sees the topic cannot read announces without the inputs.

Test vectors (`appId = "demo"`, `roomId = "lobby"`):

| Input | Value |
|---|---|
| topic, no password | `57cb91bd23ea83972e4c85fd7deb19b20fcec795fa0ef4b82936f807097039b7` |
| topic, password `hunter2` | `b155f2fa044f8614387c7ee647c2622d048117aee4e50d9b4a617d1b83a61550` |
| room key, no password | `fb24cbc0e05ec3f018db8f5278bf223b97495d1086abdee59aa8952138f9789c` |

## 4. Signaling over Nostr

Peers discover each other and exchange connection setup messages as Nostr events (NIP-01), signed
by the **session key** (`event.pubkey` is the session pubkey). Both kinds are in the ephemeral range
20000–29999, so conforming relays forward them to live subscriptions and never store them.

Peers SHOULD publish to several relays at once (the demo uses three) and MUST de-duplicate received
events by `id`. A peer SHOULD add a NIP-40 `["expiration", "<created_at + 30>"]` tag so that relays
which mistakenly store ephemeral events drop them.

A peer subscribes with two filters:

```json
["REQ", "<sub>", {"kinds": [20100], "#t": ["<topic>"], "since": <now - 30>},
                 {"kinds": [20101], "#t": ["<topic>"], "#p": ["<own session pubkey>"], "since": <now - 30>}]
```

Events older than `ANNOUNCE_TTL_S` (by `created_at`) MUST be ignored. Events from the peer's own
session pubkey MUST be ignored.

### 4.1 Announce (kind 20100)

```json
{
  "kind": 20100,
  "pubkey": "<session pubkey>",
  "tags": [["t", "<topic>"], ["expiration", "<created_at + 30>"]],
  "content": "<base64(nonce ‖ ciphertext)>"
}
```

`content` is `base64(nonce12 ‖ AES-256-GCM(roomKey, nonce12, plaintext, aad = utf8(topic)))` with a
random 12-byte nonce and the 16-byte tag appended to the ciphertext. The plaintext is JSON:

```ts
interface AnnouncePayload {
  v: 1
  pubkey: Hex               // MUST equal event.pubkey
  attestations: Attestation[]
  meta?: Record<string, unknown>   // application peer.meta (name, avatar…), small
  cap?: string              // capability token (section 9), when the room requires one
  ttl: 30                   // seconds this announce is valid
  relay?: string            // optional data-relay URL the peer can be reached on (section 11)
}
```

Peers re-announce every `ANNOUNCE_INTERVAL_S` (20 s) and on leave publish a final announce with
`ttl: 0`. A peer that has not announced within `ttl` seconds is considered gone unless a live
transport connection to it still exists. Announces that fail to decrypt are silently dropped (they
belong to a different password).

### 4.2 Directed signal (kind 20101)

```json
{
  "kind": 20101,
  "pubkey": "<sender session pubkey>",
  "tags": [["t", "<topic>"], ["p", "<recipient session pubkey>"], ["expiration", "<created_at + 30>"]],
  "content": "<NIP-44 v2 payload>"
}
```

`content` is NIP-44 v2 encrypted from the sender's session key to the recipient's session key. The
plaintext is a JSON `TransportSignal`, wrapped with the sender's connection attempt id:

```ts
interface DirectedSignal {
  v: 1
  sid: string        // connection attempt id chosen by the initiator; lets peers drop stale attempts
  signal:
    | { type: 'offer' | 'answer'; sdp: string }
    | { type: 'candidate'; candidate: RTCIceCandidateInit | null }   // null = end of candidates
    | { type: 'restart' }                                             // request an ICE restart
    | { type: 'relay-connect'; url: string }                          // meet on a data relay
}
```

Transports MAY define additional `type` values; receivers ignore types they do not know.

### 4.3 Who initiates

For each pair of peers exactly one side initiates: the peer whose session pubkey is **lower** when
compared as lowercase hex strings. The initiator creates the WebRTC offer (or sends
`relay-connect`). The other side only answers. This makes simultaneous discovery race-free.

### 4.4 NIP-42 on realms

A Beamhop relay serves app realms at `wss://host/a/<appId>`. A realm MAY require NIP-42
authentication before it accepts kinds 20100 and 20101. Such a relay sends `["AUTH", "<challenge>"]`
on connect and answers unauthenticated `EVENT` or `REQ` messages with an `OK`/`CLOSED` message whose
reason starts with `auth-required:`. The client responds with

```json
["AUTH", {"kind": 22242, "pubkey": "<session pubkey>", "created_at": <now>,
          "tags": [["relay", "wss://host/a/<appId>"], ["challenge", "<challenge>"]], "content": ""}]
```

signed by the session key, then retries. Realm policy may additionally restrict which pubkeys are
accepted (for example only pubkeys holding a valid capability token or a paid plan). Public relays
used by the demo do not require AUTH.

## 5. Transports and the connection ladder

A pair of peers is connected by one of these paths, tried in order by the connection manager:

1. **direct**: WebRTC with host or server-reflexive (STUN) candidates.
2. **turn**: WebRTC through a TURN relay (credentials from section 10).
3. **relay**: the Beamhop data relay over WebSocket (section 11).

With `relayFirst: true` a peer connects through the data relay first (one round trip after
discovery), runs ICE in parallel and migrates channels to the direct path once it is up.

Every path carries the same **data frames** (section 7). On WebRTC each channel is an
`RTCDataChannel` with the requested reliability (`reliable` = ordered + reliable, `unordered` =
unordered + reliable, `unreliable(n)` = unordered with `maxRetransmits: n`), negotiated in-band.
On the data relay all channels are multiplexed by stream id over one ordered WebSocket.

## 6. Handshake (draft)

Before a connection is reported to the application, each side proves possession of the session key
and presents its attestations. The handshake runs on the first reliable channel, with label
`__beamhop/control`, as two `Hello` frames (type 0, stream id 0) in each direction. Payloads are
CBOR maps.

1. Both sides send `Hello₁ = { v: 1, phase: 1, pubkey, attestations, meta, nonce }` where `nonce` is
   32 random bytes.
2. After receiving the peer's `Hello₁`, each side sends `Hello₂ = { v: 1, phase: 2, sig }` where
   `sig` is a BIP-340 signature by its session key over the transcript hash

   ```
   th = sha256( utf8("beamhop/v1 handshake") ‖ hexToBytes(topic)
              ‖ pubkey_initiator ‖ pubkey_responder
              ‖ nonce_initiator  ‖ nonce_responder
              ‖ utf8(role) )
   ```

   with `role` = `"initiator"` or `"responder"` for the signer, so a signature cannot be reflected.
3. Each side verifies that `Hello₁.pubkey` equals the pubkey it expected from signaling, verifies
   the signature and the attestations against room policy, and only then emits `onPeerJoin`.
   On failure it sends `Close` with a reason and drops the connection.

On WebRTC the DTLS fingerprints in the SDP already bind the channel to whoever answered the signed
signaling messages; the handshake additionally covers the data relay, where no DTLS exists.

## 7. Data frames

All peer-to-peer traffic is a sequence of frames:

```
 0        1        2                 4                 6
 +--------+--------+--------+--------+--------+--------+---------------------+
 | version|  type  |    streamId     |     length      |  payload (length B) |
 +--------+--------+--------+--------+--------+--------+---------------------+
   u8       u8       u16 BE            u16 BE
```

- `version` MUST be `1`. Receivers MUST drop frames with an unknown version.
- `length` is the payload length (0–65535). A buffer shorter than `6 + length` is a protocol error
  ("truncated frame"); a buffer shorter than 6 bytes is a "short frame".
- `type`:

| Value | Name | Payload |
|---|---|---|
| 0 | `Hello` | Handshake message (section 6) |
| 1 | `Connect` | Opens stream `streamId`: CBOR `{ label, reliability, total? }` |
| 2 | `Data` | Application bytes for `streamId` |
| 3 | `Close` | Closes `streamId`; optional UTF-8 reason |
| 4 | `Ping` | 8-byte opaque value; the receiver echoes it back as a `Ping` on stream 0xFFFF |

Test vector: a `Data` frame on stream 7 with payload `ca fe` encodes to `010200070002cafe`.

**Streams (draft).** Stream 0 is the control stream. The initiator allocates odd stream ids, the
responder even ids, so both can open streams without coordination. Messages that fit in one frame are
sent as a single `Data` frame on the action's stream. Larger messages and file transfers open a new
stream with `Connect` (carrying `total` byte length when known), send the content in `Data` frames
of at most `CHUNK_SIZE` (16 KiB) payload bytes, and finish with `Close`. Senders apply backpressure
from the channel's `bufferedAmount` / `bufferedAmountLow` and report `progress` telemetry per chunk.

**Application payloads (draft).** Typed protocol messages are CBOR maps
`{ a: action, d: data, id?: messageId, re?: requestId }`. `id` enables at-least-once delivery
across a resume (receivers de-duplicate by `id`); `re` marks a response to a request.

## 8. OIDC attestation certificate

An application backend that authenticates its users with OIDC can bind a user to a session key:

1. The client creates its session key and sends the pubkey with the user's OIDC token to the app
   backend.
2. The backend verifies the token and returns a compact JWS (RFC 7515) with payload

   ```json
   { "v": 1, "iss": "https://app.example", "sub": "user-123", "pubkey": "<session pubkey>",
     "iat": 1700000000, "exp": 1700003600 }
   ```

   signed with a key published in the backend's JWKS. `alg` MUST be one of `ES256`, `EdDSA` or
   `RS256`; the protected header MUST carry `kid`.
3. The client presents `{ type: 'oidc', jws }` as an attestation.

Verifiers fetch `iss + "/.well-known/jwks.json"` (or `jwks_uri` from
`iss + "/.well-known/openid-configuration"`) over HTTPS, cache it, and check the signature, that
`v == 1`, that `pubkey` equals the peer's session pubkey and that `iat <= now < exp` (allowing 60 s
of clock skew). Room policy `attest: { oidc: { iss } }` admits peers with a valid cert from `iss`.
Certificates SHOULD be short-lived (minutes to hours).

## 9. Capability token (draft)

Some rooms require a capability to join, and Studio joins with the `debug` capability to receive
telemetry on `__beamhop/telemetry`. A capability token is issued by the room host or by an app key:

```
token = base64url(json) "." hex(sig)
json  = { "v": 1, "iss": "<issuer pubkey>", "room": "<topic>", "pubkey": "<holder session pubkey>",
          "caps": ["join", "debug"], "exp": 1700003600 }
sig   = BIP-340 signature by iss over sha256(utf8("beamhop/v1 cap:") ‖ utf8(json))
```

Verifiers check the signature, `room == topic`, `pubkey ==` the presenter's session pubkey,
`exp > now`, and that `iss` is trusted for this room (the current host in a star room, or an app key
from configuration). Rooms created with `dev: true` accept any well-formed token.

## 10. TURN credentials

A Beamhop relay mints ephemeral TURN REST credentials per app:

```
POST https://host/a/<appId>/turn-credentials
Authorization: Bearer <apiKey>           (server-side callers)
Authorization: Nostr <base64(event)>     (NIP-98: kind 27235, tags u = request URL, method = POST)
Content-Type: application/json

{ "pubkey": "<session pubkey>", "ttl": 3600 }      (both optional; NIP-98 implies pubkey)
```

Response (`TurnCredentialsResponse`):

```json
{
  "iceServers": [
    { "urls": ["stun:host:3478"] },
    { "urls": ["turn:host:3478?transport=udp", "turn:host:3478?transport=tcp", "turns:host:443?transport=tcp"],
      "username": "1700003600:demo:79be…1798", "credential": "base64…" }
  ],
  "ttl": 3600
}
```

- `username = "<expiry>:<appId>:<pubkey>"` where `expiry` is a Unix timestamp in seconds.
- `credential = base64(HMAC-SHA1(key = utf8(appTurnSecret), message = utf8(username)))`.

The TURN server parses the username, rejects it if `expiry < now` or the app is unknown or over
quota, recomputes the credential with the app's current secret and uses it as the long-term
password (RFC 8489 MESSAGE-INTEGRITY with `key = MD5(username ":" realm ":" password)`). Rotating
the app secret invalidates all outstanding credentials. Usage is accounted per app and per pubkey.

Test vector: secret `s3cret`, expiry `1700000000`, app `demo`, pubkey
`79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` gives username
`1700000000:demo:79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` and credential
`MwpNGiWgPDM9KxN9jTKmi9Xgg9I=`.

## 11. Data relay

`wss://host/a/<appId>/data` forwards opaque, end-to-end encrypted frames between peers that cannot
connect directly, and lets server peers (for example a Bun process) join rooms without WebRTC.

### 11.1 Control messages

Text WebSocket messages are JSON `RelayControl` objects:

```ts
type RelayControl =
  | { type: 'challenge'; challenge: Hex }               // relay → client, on connect
  | { type: 'hello'; pubkey: Hex; sig: Hex }            // client → relay
  | { type: 'ready' }                                   // relay → client, authenticated
  | { type: 'error'; code: string; message: string }    // relay → client
  | { type: 'peer-offline'; pubkey: Hex }               // relay → client, destination not connected
```

1. On connect the relay sends `{ type: 'challenge', challenge }` with 32 random bytes in hex.
2. The client answers `{ type: 'hello', pubkey, sig }` where `sig` is a BIP-340 signature by the
   session key over

   ```
   relayHelloHash = sha256(utf8("beamhop-relay-hello:" + appId + ":" + challenge))
   ```

3. The relay verifies the signature, checks app policy (bans, quotas, NIP-42-style allowlists) and
   replies `{ type: 'ready' }`, or `{ type: 'error', code, message }` and closes.

A client MUST NOT send binary messages before `ready`. One pubkey has at most one data connection
per app; a new authenticated connection replaces the old one.

Error codes: `bad-message`, `auth-failed`, `unknown-app`, `banned`, `quota-exceeded`,
`rate-limited`, `too-large`, `replaced`.

Test vector: `appId = "demo"`, `challenge = "aa" × 32` gives
`relayHelloHash = f19fc962dce2037a47345f94ffd2c9ebb7b629aadc63f86a3484f8909b613432`.

### 11.2 Envelope

Binary WebSocket messages are envelopes:

```
envelope = pubkey (32 bytes) ‖ body
```

- client → relay: `pubkey` is the **destination** session pubkey.
- relay → client: `pubkey` is the **source** session pubkey (rewritten by the relay; clients cannot
  spoof it because the relay knows who authenticated each socket).

If the destination is not connected the relay drops the envelope and sends
`{ type: 'peer-offline', pubkey }`. The relay never inspects `body`; it only counts bytes per app
for quotas and metrics. Relays SHOULD limit envelopes to `32 + 65536 + 64` bytes.

Test vector: destination `79be…1798`, body `01 02 03` encodes to
`79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798010203`.

### 11.3 Pair session encryption (draft)

`body` is a data frame (section 7) encrypted for the destination:

- `ck = NIP-44 v2 conversation key(sender, recipient)` (32 bytes; symmetric for both sides).
- Per direction, `k = HKDF-SHA256(ikm = ck, salt = none, info = utf8("beamhop/v1 pair") ‖ senderPub ‖ recipientPub, L = 32)`
  with pubkeys as 32 raw bytes.
- Each direction keeps a 64-bit counter starting at 0, incremented per message.
  `nonce = 0x00000000 ‖ u64(counter)` (12 bytes).
- `body = u64(counter) ‖ ChaCha20-Poly1305(k, nonce, frame, aad = senderPub ‖ recipientPub)`.

Receivers MUST reject counters that are not strictly greater than the last accepted one for that
direction, and drop the connection on authentication failure. Counters reset when a new handshake
(section 6) completes.

## 12. What observers learn

- **Nostr relays** see the room topic, session pubkeys, event timing and sizes. Announce contents are
  encrypted with the room key; directed signals with NIP-44. Without the room inputs a relay cannot
  read peer metadata or SDP.
- **TURN servers** see IP addresses and traffic volume; WebRTC payloads are DTLS-encrypted.
- **The data relay** sees session pubkeys, envelope sizes and timing; bodies are end-to-end encrypted.
- **Anyone who knows `(appId, roomId, password)`** can compute the topic and room key and announce
  into the room. Use a password, capability tokens or attestation policy for private rooms.

## 13. Versioning

The `beamhop/v1` prefix, `PROTOCOL_VERSION = 1` and `v: 1` fields change together. A future
incompatible version uses a new prefix, so v1 and v2 rooms never share a topic. Within v1 new
optional fields and new signal types may be added; receivers ignore what they do not understand.
