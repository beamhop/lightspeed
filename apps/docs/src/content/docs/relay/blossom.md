---
title: Blossom media
description: Content-addressed media storage (BUD-01/02/06) with per-app and per-pubkey quotas.
sidebar:
  order: 9
---

:::caution[0.x, subject to change]
:::

[Blossom](https://github.com/hzrd149/blossom) stores blobs addressed by their SHA-256 hash, with
uploads authorized by signed Nostr events. The relay implements BUD-01 (retrieval), BUD-02
(upload, list, delete) and BUD-06 (upload requirements).

| Endpoint | What |
|---|---|
| `PUT /upload` | Upload a blob; `Authorization: Nostr <kind 24242 event>` with `t=upload` and the hash |
| `HEAD /upload` | BUD-06 preflight: size and type checks before uploading |
| `GET /<sha256>[.ext]` | Fetch a blob (supports ranges) |
| `HEAD /<sha256>` | Existence and size |
| `DELETE /<sha256>` | Delete your blob (signed `t=delete` event) |
| `GET /list/<pubkey>` | Blobs uploaded by a pubkey |
| `PUT /mirror` | Copy a blob from another Blossom server by URL |

## Limits

Configure in `[blossom]` and per app:

- `max_blob_mb` and `allowed_mime` (glob patterns),
- storage quota per app and per pubkey,
- whether uploads require a paid plan or an allowlisted pubkey (via the realm policy).

Blobs live under `/data/blobs`. An S3-compatible backend is planned. NIP-96 compatibility will only be
added if a client you need requires it.

## Using it from apps

Large shared assets (avatars, images in chat history) are better stored once in Blossom and
referenced by hash than sent peer-to-peer to every member. Peer-to-peer
[file transfer](../../guides/file-transfer/) is the right tool for one-off, private transfers.
