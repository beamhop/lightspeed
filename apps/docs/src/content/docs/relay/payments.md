---
title: Payments
description: Run a paid relay with Lightning through Nostr Wallet Connect.
sidebar:
  order: 8
---

:::caution[0.x, subject to change]
:::

The relay can charge for write access with Lightning. It never holds funds itself: invoices are
created and settled through a wallet you connect with **NWC** (Nostr Wallet Connect, NIP-47).

## Setup

1. Create an NWC connection string in your wallet (Alby Hub, Mutiny, LNbits, Coinos…) with the
   `make_invoice` and `lookup_invoice` permissions only. Never grant `pay_invoice`.
2. Put it in the environment: `BEAMHOP_PAYMENTS_NWC="nostr+walletconnect://…"` and set
   `[payments] enabled = true`.
3. In **Payments → Plans**, create a plan: price in sats, duration (for example 30 days), and the
   realm(s) it applies to (the public relay, an app, or both).

## How users pay

The relay serves a payment page at `/pay`: the user signs in with Nostr (NIP-07 or NIP-46), picks a
plan and gets a Lightning invoice with a QR code. When the wallet reports the invoice as paid, the
pubkey becomes **write-allowed** by policy until the plan expires.

NIP-11 advertises `payments_url` and `fees`, so Nostr clients that support paid relays can link
users straight to `/pay`.

## Operations

- **Payments → Invoices** shows the invoice state machine (open, paid, expired) with retries for
  lookups.
- **Paid pubkeys** lists active plans; you can extend or revoke them (audited).
- If the NWC connection drops, the overview raises an alert and the page shows "payments
  temporarily unavailable"; existing paid pubkeys keep their access.
