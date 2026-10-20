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
| `{ type: 'nostr', pubkey, sig }` | The Nostr key `pubkey` vouches for this session key | Schnorr signature by `pubkey` |
| `{ type: 'oidc', jws }` | Your backend vouches that OIDC subject `sub` from issuer `iss` holds this session key | JWS signature against the issuer's JWKS |

Attestations travel in the encrypted announce and again in the handshake, where the peer also
proves it holds the session key by signing the handshake transcript. The application only sees
`onPeerJoin` after both checks pass.

## Providers

```ts
import { anonymous, nostr, oidc } from '@beamhop/p2p'

anonymous()                       // fresh key per page load
anonymous({ persist: true })      // key kept in IndexedDB, same id across reloads

nostr({ nip07: true })            // browser extension (Alby, nos2x…)
nostr({ nsec: 'nsec1…' })         // raw key (servers, tests)
nostr({ bunker: 'bunker://…' })   // NIP-46 remote signer

oidc({
  issuer: 'https://app.example',
  // Called with the fresh session pubkey; your backend returns the signed cert (JWS).
  getCert: async (pubkey) => {
    const res = await fetch('/api/beamhop-cert', { method: 'POST', body: JSON.stringify({ pubkey }) })
    return (await res.json()).jws
  },
})
```

With `nostr()`, the library creates an ephemeral session key and asks the Nostr signer once to sign
an attestation for it, so the extension is not prompted for every signaling event.

## Room policy

`createRoom({ policy })` decides who may join. Peers that fail policy are disconnected after the
handshake and never reach your code.

```ts
createRoom({
  // …
  policy: {
    attest: 'any',                                      // default: everyone, including anonymous
    // attest: { nostr: { pubkeys: ['<hex>', '<hex>'] } }, // only these Nostr users
    // attest: { oidc: { iss: 'https://app.example' } },   // anyone your backend certified
    // requireCapability: 'join',                          // capability token, see below
  },
})
```

Peer objects expose what was verified:

```ts
room.onPeerJoin((peer) => {
  peer.pubkey                      // session pubkey
  peer.attestations                // verified attestations only
  peer.nostrPubkey                 // set when a nostr attestation verified
  peer.oidc                        // { iss, sub } when an OIDC cert verified
  peer.meta                        // self-declared metadata (name, avatar): not verified
})
```

:::note
`peer.meta` is whatever the peer announced. Never use it for authorization; use attestations.
:::

## Capability tokens

A capability token is a short signed grant `{ room, pubkey, caps, exp }` issued by the room host or an
app key. Rooms can require the `join` capability; Studio attaches with `debug` to receive telemetry.
In development (`dev: true`) any well-formed token is accepted. See the
[protocol spec](../../protocol/#9-capability-token-draft) for the format.

## Threat model in one paragraph

Anyone who knows `appId` and `roomId` (and the password, if set) can compute the room topic and key
and announce into the room. Attestations and policy, not secrecy of the room name, are what keep
strangers out. Relays see topics, pubkeys and traffic volume but cannot read announces or signals.
