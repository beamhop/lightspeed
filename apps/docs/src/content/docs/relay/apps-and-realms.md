---
title: Apps and realms
description: Per-app Nostr realms, TURN secrets, API keys, quotas and policies on one relay.
sidebar:
  order: 5
---

:::caution[0.x, subject to change]
:::

One relay can serve many applications. Each **app** gets its own **realm**: a separate Nostr relay
namespace with its own policy, plus its own TURN secret, API key, quotas and usage counters.

| URL | What |
|---|---|
| `wss://relay.example.com/` | The public Nostr relay (global policy `_global`) |
| `wss://relay.example.com/a/<appId>` | The app's realm relay |
| `wss://relay.example.com/a/<appId>/data` | The app's data relay |
| `POST https://relay.example.com/a/<appId>/turn-credentials` | Mints TURN credentials |

Events published to a realm are only visible in that realm. The library only ever uses a realm for
signaling; the public relay is for regular Nostr clients.

## Creating an app

In the admin UI: **Apps → New app**. Choose an id (`[a-z0-9-]`, it appears in URLs), a name and a plan.
The relay generates:

- a **TURN shared secret** (never leaves the relay; credentials are HMACs of it),
- an **API key** for `POST /a/<appId>/turn-credentials` from your backend.

Both are rotatable. Rotating the TURN secret invalidates every outstanding TURN credential
immediately; rotating the API key breaks backends that still use the old key.

## Minting TURN credentials

From your backend (never ship the API key to browsers):

```ts
const res = await fetch(`https://relay.example.com/a/${appId}/turn-credentials`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${Bun.env.BEAMHOP_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pubkey: sessionPubkey, ttl: 3600 }),
})
const { iceServers, ttl } = await res.json()
```

Or let clients call it directly with a **NIP-98** `Authorization: Nostr <event>` header, if the
app's policy allows it (useful for apps without a backend; combine with a pubkey allowlist or paid
plans).

## Realm policy

Each realm has a policy editable under **Apps → (app) → Policy**, same shape as the global one:

- pubkey allow/deny lists, kind allow/deny lists,
- rate limits per IP and per pubkey,
- maximum event size, NIP-13 minimum proof of work,
- **AUTH-required kinds** (NIP-42): require AUTH for 20100/20101 so only authenticated clients
  signal on your realm,
- retention per kind (for stored kinds),
- `writeAllowed` from payments: only paid pubkeys can write.

## Quotas

Per app: maximum concurrent TURN allocations, bandwidth cap (Mbps), monthly transfer (GB, TURN and
data relay combined), and Blossom storage. Usage is visible under **Apps → (app) → Usage** and
exportable as CSV. When a quota is exhausted new allocations are refused with a clear error and the
overview raises an alert.
