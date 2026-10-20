---
title: Supported NIPs
description: Which Nostr Improvement Proposals the relay implements, with per-NIP notes.
sidebar:
  order: 10
---

:::caution[0.x, subject to change]
:::

The relay is a complete Nostr relay, not just a signaling server. NIP-11 (`supported_nips`) lists
what your version supports.

| NIP | Name | Notes |
|---|---|---|
| [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol | Schnorr verification (moved to a worker pool under load), replaceable and addressable events. Kinds 20000–29999 are matched to live subscriptions but never stored. |
| [09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion | Deletes by `e` and `a` tags from the same author; the deletion request is kept. |
| [11](https://github.com/nostr-protocol/nips/blob/master/11.md) | Relay information | Edited in the admin UI; merged per realm (`/a/<appId>` serves its own document). Advertises limits, `payments_url` and fees. |
| [13](https://github.com/nostr-protocol/nips/blob/master/13.md) | Proof of work | Optional minimum difficulty, globally or per realm. |
| [40](https://github.com/nostr-protocol/nips/blob/master/40.md) | Expiration | Expired events are rejected on publish, hidden from queries and swept periodically. |
| [42](https://github.com/nostr-protocol/nips/blob/master/42.md) | Authentication | Challenge on connect. Policies can require AUTH per kind; private realms require it for writes. |
| [45](https://github.com/nostr-protocol/nips/blob/master/45.md) | Event counts | `COUNT` with the same filters as `REQ`. |
| [50](https://github.com/nostr-protocol/nips/blob/master/50.md) | Search | SQLite FTS5 over content and selected tags; `search` filter field. |
| [65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata | Stored and served like any replaceable event (kind 10002). |
| [70](https://github.com/nostr-protocol/nips/blob/master/70.md) | Protected events | Events with the `-` tag are only accepted from their authenticated author. |
| [77](https://github.com/nostr-protocol/nips/blob/master/77.md) | Negentropy syncing | `NEG-OPEN` / `NEG-MSG` / `NEG-CLOSE` with an id/time index compatible with strfry. |
| [86](https://github.com/nostr-protocol/nips/blob/master/86.md) | Relay management API | JSON-RPC over HTTP with NIP-98 auth for admin pubkeys; mirrors what the admin UI can do. |
| [98](https://github.com/nostr-protocol/nips/blob/master/98.md) | HTTP auth | Used by NIP-86, TURN credential minting and Blossom. |
| [47](https://github.com/nostr-protocol/nips/blob/master/47.md) | Wallet Connect | Client side only: the relay uses NWC to create and check invoices for [payments](../payments/). |

## Beamhop kinds

| Kind | Use |
|---|---|
| 20100 | Room announce (ephemeral, encrypted with the room key) |
| 20101 | Directed signal (ephemeral, NIP-44 to the recipient) |
| 22242 | NIP-42 AUTH |
| 24242 | Blossom authorization |
| 27235 | NIP-98 HTTP auth, admin login challenge |

See the [protocol spec](../../protocol/) for the exact formats.
