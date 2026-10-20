---
title: Admin UI tour
description: The mobile-first admin SPA at /admin, screen by screen.
sidebar:
  order: 6
---

:::caution[0.x, subject to change]
:::

The admin UI lives at `https://relay.example.com/admin`. It is a mobile-first single-page app, dark
by default in the Beamhop palette, fed by one WebSocket stats stream so every screen is live.

## Signing in

- **Nostr login** with a NIP-07 extension or a NIP-46 bunker: the UI asks you to sign a challenge
  (kind 27235) and checks your pubkey against the admin allowlist.
- **Password + TOTP** as a fallback for admins without a Nostr signer.
- **First run:** the relay prints a one-time bootstrap token. Paste it on the login screen to claim
  the first admin (with a pubkey, or a username, password and TOTP).

Sessions use an HTTP-only cookie (`bh_admin`). Every write action asks for confirmation with the
affected scope spelled out and lands in the audit log with the admin's identity.

## Screens

| Area | What you see | What you can do |
|---|---|---|
| **Overview** | Events/s, subscriptions, clients, TURN allocations, relayed Mbps, disk, uptime, alerts | Acknowledge alerts, jump to the offending app or client |
| **Nostr relay** | Event explorer (kind, author, tag, NIP-50 search), live subscriptions, policy and NIP-11 editors, retention, negentropy status | Allow/deny pubkeys and kinds, rate limits, PoW, AUTH per kind, delete events, backup/restore |
| **TURN** | Allocations (app, user, 5-tuple, bytes, age), bandwidth charts, listener status, IP bans | Kill allocations, set per-app quotas, rotate secrets, ban IPs |
| **Apps** | App list, per-app policy, quotas, API keys, usage, plan | Create apps, rotate TURN secret and API key, edit realm policy, export usage |
| **Media** | Blobs by app and pubkey, usage, MIME/size limits | Delete blobs, set quotas |
| **Payments** | Plans, invoices, NWC connection, paid pubkeys, revenue | Create plans, refund/extend, reconnect wallet |
| **Admins** | Admin pubkeys, password + TOTP users, sessions, audit log | Invite/remove admins, revoke sessions, reset TOTP |
| **Settings** | TLS paths, listeners and ports, logging, metrics, backups | Edit config, test TLS, download the Grafana dashboard |

The bunny mascot shows up in loading (spinner), empty (idle), success (smile), error (angry) and
secret-handling (secret) states.

## API

Everything the UI does goes through the JSON API under `/api/admin` (cookie session, CSRF-protected),
so you can script it. Errors are `{ "error": { "code", "message" } }`. Live stats are pushed on the
WebSocket `/api/admin/stats` once per second.
