---
title: Identity and attestations
description: Session keys, the anonymous, Nostr and OIDC providers, and how room policy admits peers.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
:::

Every peer in a room is a **session key**: a secp256k1 keypair (BIP-340 Schnorr). The session pubkey
is the peer's id. It signs Nostr signaling events, the connection handshake and data-relay
challenges, and it is the input to pairwise encryption (NIP-44 v2 conversation keys).

A session key on its own says nothing about *who* is behind it. **Attestations** add that:

| Attestation | Claim | Verified by |
|---|---|---|
| `{ type: 'anonymous' }` | Nothing | – |
| `{ type: 'nostr', pubkey, sig, created_at }` | The Nostr key `pubkey` vouches for this session key | Schnorr signature by `pubkey` over a kind 28100 event (see below) |
| `{ type: 'oidc', jws }` | Your backend vouches that OIDC subject `sub` from issuer `iss` holds this session key | JWS signature against the issuer's JWKS |

Attestations travel in the encrypted announce and again in the handshake, where the peer also
proves it holds the session key by signing the handshake transcript. The application only sees
`onPeerJoin` after both checks pass.

## Providers

```ts
import { anonymous, nip46Signer, nostr, oidc, parseBunkerUrl } from '@beamhop/p2p'

anonymous()                       // fresh key per page load
anonymous({ persist: true })      // key kept in IndexedDB, same id across reloads
anonymous({ secretKey })          // fixed key (tests, Bun server peers)

nostr()                           // NIP-07 browser extension (window.nostr: Alby, nos2x…)
nostr({ extension: myNip07 })     // an explicit NIP-07 object
nostr({ nsec: 'nsec1…' })         // raw key, nsec or hex (servers, tests)

// NIP-46 remote signer: `transport` is any { publish(event), subscribe(filter, cb) } pair,
// e.g. built on @beamhop/signaling-nostr's RelayPool.
const { remotePubkey, secret } = parseBunkerUrl('bunker://<pubkey>?relay=wss://…&secret=…')
nostr({ bunker: nip46Signer({ transport, remotePubkey, secret }) })

oidc({
  // Called with the fresh session pubkey; your backend returns the signed cert (a JWS string).
  getCert: async (pubkey) => {
    const res = await fetch('/api/beamhop-cert', { method: 'POST', body: JSON.stringify({ pubkey }) })
    return (await res.json()).jws
  },
})
```

With `nostr()`, the library creates an ephemeral session key and asks the Nostr signer once to sign
an attestation for it, so the extension is not prompted for every signaling event. The signed
message is a regular Nostr event, so NIP-07 and NIP-46 signers work unchanged:

```
kind = 28100, created_at = attestation.created_at, tags = [["p", <session pubkey>]],
content = "beamhop-session", pubkey = <Nostr user key>
```

`attestation.sig` is the BIP-340 signature over that event's NIP-01 id.
`createNostrAttestation(signer, sessionPubkey)` and `verifyNostrAttestation(att, sessionPubkey)`
implement it.

## Room policy

`createRoom({ policy })` decides who may join. Peers that fail policy are disconnected after the
handshake and never reach your code.

```ts
createRoom({
  // …
  policy: {
    // Omit `attest` to admit everyone whose attestations verify (including anonymous peers).
    attest: { anonymous: false, nostr: { pubkeys: ['<hex>', '<hex>'] } }, // only these Nostr users
    // attest: { nostr: true },                       // any verified Nostr user
    // attest: { oidc: { iss: 'https://app.example' } }, // anyone your backend certified
    // jwks: staticJwks({ ... }),                     // OIDC keys (default: discovery, cached)
    // capabilities: { issuers: [appPubkey], require: ['join'] }, // capability tokens, see below
    // admit: (candidate) => true,                    // final say, after everything verified
  },
})
```

A peer is admitted when all of its attestations verify, at least one matches `attest` (when set),
its capability token covers `capabilities.require`, and `admit` (when set) returns true. Peer
objects expose what was verified:

```ts
room.onPeerJoin((peer) => {
  peer.pubkey                      // session pubkey
  peer.attestations                // attestations the peer presented (all verified, or it would not be here)
  peer.verified                    // results: { ok, type, nostrPubkey?, issuer?, subject? }[]
  peer.caps                        // capabilities from a verified token, e.g. ['join', 'debug']
  peer.meta                        // self-declared metadata (name, avatar): not verified
})
```

:::note
`peer.meta` is whatever the peer announced. Never use it for authorization; use attestations.
:::

## Capability tokens

A capability token is a short signed grant `{ v: 1, room, pubkey, caps, exp, iss, sig }` issued by
an app key (`policy.capabilities.issuers`) or, in star rooms, the current host. Pass yours with
`createRoom({ capability })`; issue them on a backend with
`issueCapability(appSecretKey, { room: topic | '*', pubkey, caps: ['join'] })`. Rooms can require
the `join` capability; Studio attaches with `debug` to receive telemetry. In development
(`policy.dev: true`) any validly signed token is accepted regardless of issuer. See the
[protocol spec](../../protocol/#9-capability-token-draft) for the format.

## Threat model in one paragraph

Anyone who knows `appId` and `roomId` (and the password, if set) can compute the room topic and key
and announce into the room. Attestations and policy, not secrecy of the room name, are what keep
strangers out. Relays see topics, pubkeys and traffic volume but cannot read announces or signals.
