// "About this page" copy for every screen: what it is, why it matters, how to use it.
// Field- and column-level explanations live next to the inputs they describe.

import type { PageHelp } from './components/ui'

export const PAGE_HELP = {
  overview: {
    id: 'overview',
    what: 'A live health dashboard for the whole relay: the Nostr relay, the built-in TURN server, disk and media storage. Numbers update every second over the stats stream (the dot in the sidebar shows whether it is connected).',
    why: 'It is the first place to look when users report slow calls or missing messages. Spikes in events or bandwidth, a full disk or an open alert usually point straight at the cause.',
    how: [
      'Hover or tap the (i) next to a number to see what it measures and when to worry.',
      'Watch the two charts for sudden jumps; they cover the last few minutes.',
      'Work through Alerts: use “Open app” or “Inspect client” to jump to the source, then Acknowledge once handled.',
    ],
  },
  nostr: {
    id: 'nostr',
    what: 'The Nostr relay that apps use for signalling and that anyone can use as a public relay. Here you can browse stored events, see who is subscribed right now, and set the rules for what the public relay accepts and keeps.',
    why: 'Spam, abuse and runaway clients show up here first. Policy and retention control how much the relay stores, which keeps disk use and moderation work under control.',
    how: [
      'Use Events to search and delete individual events (spam, illegal content, test data).',
      'Use Live subscriptions to spot noisy clients and ban their IP.',
      'Use Policy and Retention to set rules for the public relay; each app has its own policy under Apps.',
      'Edit NIP-11 to change how clients see your relay, and Backup to snapshot the databases.',
    ],
  },
  turn: {
    id: 'turn',
    what: 'The built-in TURN server. When two peers cannot connect directly (strict NATs, corporate firewalls), their media and data are relayed through an “allocation” on this server.',
    why: 'TURN is the most bandwidth-hungry part of the relay and what keeps calls working on difficult networks. This page shows who is using it and lets you stop abuse.',
    how: [
      'Check the bandwidth chart and Allocations list to see current relaying.',
      'Filter by IP, user or app to find a specific client; Kill drops one allocation.',
      'Use IP bans to block an address or range from every listener, temporarily or permanently.',
      'To limit usage per app instead, set quotas on the app’s Quotas tab.',
    ],
  },
  apps: {
    id: 'apps',
    what: 'An app is one product that uses this relay. Each gets its own private realm (Nostr relay, data relay and TURN credentials), its own secrets, quotas and policy.',
    why: 'Apps keep products separated: you can cap one app’s bandwidth, rotate its keys or disable it without affecting anyone else, and see exactly what each one costs you.',
    how: [
      'Click New app, name it, and copy the App ID, TURN secret and API key shown once.',
      'Put the App ID in your client and the API key on your backend (it mints TURN credentials).',
      'Open an app to rotate keys, set quotas, edit its realm policy or export usage.',
    ],
  },
  app: {
    id: 'app',
    what: 'Everything about a single app: its secrets and endpoints, resource quotas, realm policy and usage history.',
    why: 'This is where you onboard a new integration, respond to a leaked key, or stop one app from eating the relay’s bandwidth or storage.',
    how: [
      'Keys: copy the endpoints into your app; rotate a secret if it leaked.',
      'Quotas: cap allocations, bandwidth, monthly transfer and media storage (0 = unlimited).',
      'Policy: rules for events published to this app’s realm.',
      'Usage: 30-day traffic chart with CSV export for billing.',
      'The Enabled switch turns all of the app’s traffic off or on without deleting anything.',
    ],
  },
  media: {
    id: 'media',
    what: 'Files uploaded to the relay’s Blossom media server. Each file (“blob”) is addressed by its SHA-256 hash and owned by the Nostr pubkey that uploaded it.',
    why: 'Media is usually the biggest user of disk. Use this page to remove unwanted content and to see which apps are close to their storage quota.',
    how: [
      'Pick an app and/or paste a pubkey, then Filter to narrow the list.',
      'Delete removes a blob from this server (copies on other Blossom servers are not affected).',
      'Storage quotas per app shows usage against each app’s limit; click an app to change it.',
    ],
  },
  payments: {
    id: 'payments',
    what: 'Optional Lightning payments for write access to the public relay. Users pay a plan on the public /pay page; their pubkey can then publish for the plan’s period.',
    why: 'Charging a small fee is one of the most effective spam filters for a public relay and helps cover hosting costs.',
    how: [
      'Connect a wallet on the Wallet (NWC) tab first; it issues and detects invoices.',
      'Create one or more plans (price and period). With no plans, writes are free.',
      'Follow payments in Invoices and see who currently has access under Paid pubkeys.',
    ],
  },
  admins: {
    id: 'admins',
    what: 'The people who can sign in to this admin UI, their active sessions, and an audit log of every change anyone made.',
    why: 'Admins have full control of the relay. Reviewing who has access and what they did is how you keep that power accountable and recover from a lost or stolen device.',
    how: [
      'Invite admins by Nostr pubkey (recommended) or username + password + TOTP.',
      'Revoke a session to sign a lost device out immediately.',
      'Search the Audit log by actor to review someone’s changes.',
    ],
  },
  settings: {
    id: 'settings',
    what: 'Relay-wide configuration: network listeners, TLS certificates, logging, Prometheus metrics and automatic backups, plus this browser’s appearance.',
    why: 'These settings decide how clients reach the relay and how you operate it. Saved values override beamhop-relay.toml.',
    how: [
      'Change values; the bar at the bottom counts unsaved changes.',
      'Save shows exactly what changes before applying it.',
      'Listener and TLS changes need a relay restart; the rest apply immediately.',
    ],
  },
} satisfies Record<string, PageHelp>
