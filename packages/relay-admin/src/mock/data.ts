// Deterministic fake data for the mock API (demos, screenshots, tests).

import { DEFAULT_POLICY } from '../api'
import type {
  Admin,
  Alert,
  Allocation,
  App,
  AuditEntry,
  Backup,
  Ban,
  Invoice,
  MediaBlob,
  Nip11Info,
  NostrEvent,
  NwcStatus,
  PaidPubkey,
  Plan,
  Policy,
  Session,
  Settings,
  Subscription,
} from '../types'

export function prng(seed = 42) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MockDb {
  loggedIn: boolean
  me: {
    id: string
    pubkey?: string
    username?: string
    role: 'owner' | 'admin'
    method: 'nostr' | 'password' | 'bootstrap'
  }
  apps: (App & { turnSecret: string; apiKey: string })[]
  events: NostrEvent[]
  subscriptions: Subscription[]
  policies: Record<string, Policy>
  nip11: Nip11Info
  allocations: Allocation[]
  bans: Ban[]
  blobs: MediaBlob[]
  plans: Plan[]
  invoices: Invoice[]
  paid: PaidPubkey[]
  nwc: NwcStatus
  admins: Admin[]
  sessions: Session[]
  audit: AuditEntry[]
  settings: Settings
  backups: Backup[]
  alerts: Alert[]
  startedAt: number
  totalEvents: number
}

const NAMES = ['Lightspeed Chat', 'Pixel Party', 'Cursor Lab', 'FileDrop', 'Room Radio']
const WORDS = [
  'hello',
  'nostr',
  'relay',
  'beam',
  'hop',
  'turn',
  'peer',
  'gm',
  'zap',
  'bunny',
  'rabbit',
  'p2p',
]
const KINDS = [0, 1, 1, 1, 3, 7, 7, 1984, 10002, 30023, 20100]

export function createMockDb(now = Date.now(), seed = 7): MockDb {
  const rnd = prng(seed)
  const hex = (n = 64) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const sec = Math.floor(now / 1000)
  const pubkeys = Array.from({ length: 12 }, () => hex())

  const apps = NAMES.map((name, i) => ({
    id: hex(12),
    name,
    description: `${name} realm`,
    createdAt: sec - (i + 1) * 86400 * 9,
    enabled: i !== 4,
    plan: i % 2 ? 'pro' : 'free',
    quotas: {
      maxAllocations: 50 * (i + 1),
      maxMbps: 20 * (i + 1),
      gbPerMonth: 100,
      maxStorageBytes: 5 * 1024 ** 3,
      maxBlobBytes: 50 * 1024 ** 2,
      allowedMime: ['image/*', 'video/mp4'],
    },
    turnSecretHint: `…${hex(4)}`,
    apiKeyHint: `…${hex(4)}`,
    usage: {
      bytesMonth: Math.floor(rnd() * 40e9),
      allocations: Math.floor(rnd() * 40),
      events: Math.floor(rnd() * 90000),
      blobsBytes: Math.floor(rnd() * 2e9),
    },
    turnSecret: hex(40),
    apiKey: `bh_${hex(32)}`,
  }))

  const events: NostrEvent[] = Array.from({ length: 140 }, (_, i) => {
    const kind = pick(KINDS)
    const words = Array.from({ length: 3 + Math.floor(rnd() * 10) }, () => pick(WORDS)).join(' ')
    const tags: string[][] = []
    if (rnd() < 0.4) tags.push(['t', pick(WORDS)])
    if (rnd() < 0.3) tags.push(['p', pick(pubkeys)])
    return {
      id: hex(),
      pubkey: pick(pubkeys),
      created_at: sec - i * 37 - Math.floor(rnd() * 30),
      kind,
      tags,
      content:
        kind === 0 ? JSON.stringify({ name: `user${i}`, about: words }) : kind === 7 ? '+' : words,
      sig: hex(128),
    }
  })

  const ips = Array.from(
    { length: 10 },
    () =>
      `${10 + Math.floor(rnd() * 200)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`,
  )

  const subscriptions: Subscription[] = Array.from({ length: 18 }, (_, i) => ({
    id: `sub-${i}-${hex(6)}`,
    clientId: `c${i % 9}`,
    ip: pick(ips),
    realm: rnd() < 0.5 ? null : (pick(apps).id as string),
    filters: [
      { kinds: [pick(KINDS)], limit: 50 },
      ...(rnd() < 0.3 ? [{ authors: [pick(pubkeys)] }] : []),
    ],
    createdAt: sec - Math.floor(rnd() * 7200),
    eventsSent: Math.floor(rnd() * 2000),
  }))

  const allocations: Allocation[] = Array.from({ length: 14 }, (_, i) => {
    const app = pick(apps)
    const pk = pick(pubkeys)
    return {
      id: `alloc-${hex(10)}`,
      username: `${sec + 3600}:${app.id}:${pk.slice(0, 16)}`,
      appId: app.id,
      transport: pick(['udp', 'udp', 'udp', 'tcp', 'tls'] as const),
      client: `${pick(ips)}:${40000 + Math.floor(rnd() * 20000)}`,
      relayed: `203.0.113.7:${49152 + i * 3}`,
      bytesIn: Math.floor(rnd() * 5e8),
      bytesOut: Math.floor(rnd() * 5e8),
      createdAt: sec - Math.floor(rnd() * 3600),
      expiresAt: sec + 600,
    }
  })

  const blobs: MediaBlob[] = Array.from({ length: 24 }, () => {
    const type = pick(['image/png', 'image/jpeg', 'video/mp4', 'application/pdf', 'image/webp'])
    const sha = hex()
    return {
      sha256: sha,
      size: Math.floor(rnd() * 20e6),
      type,
      uploaded: sec - Math.floor(rnd() * 86400 * 30),
      pubkey: pick(pubkeys),
      app: rnd() < 0.7 ? pick(apps).id : undefined,
      url: `/${sha}`,
    } as MediaBlob
  })

  const plans: Plan[] = [
    {
      id: 'free',
      name: 'Free',
      priceSats: 0,
      periodDays: 30,
      description: 'Read + rate-limited writes',
      active: true,
      appId: null,
    },
    {
      id: 'pro',
      name: 'Pro writer',
      priceSats: 5000,
      periodDays: 30,
      description: 'Write access to the public relay',
      active: true,
      appId: null,
    },
    {
      id: 'yearly',
      name: 'Pro yearly',
      priceSats: 50000,
      periodDays: 365,
      active: true,
      appId: null,
    },
  ]
  const invoices: Invoice[] = Array.from({ length: 16 }, (_, i) => {
    const plan = pick(plans.slice(1))
    const status = pick(['paid', 'paid', 'paid', 'pending', 'expired'] as const)
    return {
      id: `inv-${hex(8)}`,
      planId: plan.id,
      pubkey: pick(pubkeys),
      amountSats: plan.priceSats,
      status,
      createdAt: sec - i * 5000,
      paidAt: status === 'paid' ? sec - i * 5000 + 40 : null,
      bolt11: `lnbc${plan.priceSats}n1${hex(40)}`,
    }
  })
  const paid: PaidPubkey[] = invoices
    .filter((i) => i.status === 'paid')
    .map((i) => ({
      pubkey: i.pubkey,
      planId: i.planId,
      since: i.paidAt as number,
      expiresAt: (i.paidAt as number) + 30 * 86400,
      appId: null,
    }))

  const owner = pubkeys[0] as string
  const admins: Admin[] = [
    {
      id: 'adm-1',
      pubkey: owner,
      role: 'owner',
      totpEnabled: false,
      createdAt: sec - 86400 * 60,
      lastLoginAt: sec - 60,
    },
    {
      id: 'adm-2',
      username: 'ops',
      role: 'admin',
      totpEnabled: true,
      createdAt: sec - 86400 * 20,
      lastLoginAt: sec - 86400 * 2,
    },
    {
      id: 'adm-3',
      pubkey: pubkeys[1] as string,
      role: 'admin',
      totpEnabled: false,
      createdAt: sec - 86400 * 3,
      lastLoginAt: null,
    },
  ]
  const sessions: Session[] = [
    {
      id: 'sess-current',
      adminId: 'adm-1',
      label: 'Safari on iPhone',
      ip: ips[0] as string,
      createdAt: sec - 3600,
      lastSeenAt: sec,
      current: true,
    },
    {
      id: 'sess-2',
      adminId: 'adm-2',
      label: 'Firefox on Linux',
      ip: ips[1] as string,
      createdAt: sec - 86400 * 2,
      lastSeenAt: sec - 7200,
    },
    {
      id: 'sess-3',
      adminId: 'adm-1',
      label: 'Chrome on macOS',
      ip: ips[2] as string,
      createdAt: sec - 86400 * 5,
      lastSeenAt: sec - 86400,
    },
  ]
  const actions = [
    'apps.create',
    'apps.rotate-turn-secret',
    'policies.put',
    'bans.add',
    'nostr.delete-event',
    'turn.kill',
    'settings.put',
    'auth.login',
  ]
  const audit: AuditEntry[] = Array.from({ length: 40 }, (_, i) => ({
    id: `aud-${i}`,
    ts: sec - i * 1800,
    actor: pick([owner, 'ops']),
    action: pick(actions),
    scope: pick(['_global', apps[0]?.id as string, apps[1]?.id as string, 'relay']),
    ip: pick(ips),
  }))

  const settings: Settings = {
    publicUrl: 'https://relay.example.com',
    listeners: {
      https: 443,
      turnUdp: 3478,
      turnTcp: 3478,
      turnTls: 5349,
      relayPorts: [49152, 65535],
    },
    tls: {
      cert: '/etc/beamhop/tls/fullchain.pem',
      key: '/etc/beamhop/tls/privkey.pem',
    },
    logging: { level: 'info' },
    metrics: { enabled: true, path: '/metrics', tokenSet: false },
    backups: { enabled: true, hourUtc: 3, retentionDays: 14 },
  }

  return {
    loggedIn: false,
    me: { id: 'adm-1', pubkey: owner, role: 'owner', method: 'nostr' },
    apps,
    events,
    subscriptions,
    policies: {
      _global: {
        ...DEFAULT_POLICY,
        kinds: { allow: [], deny: [4] },
        rateLimits: {
          perIp: { events: 120, windowSec: 60 },
          perPubkey: { events: 60, windowSec: 60 },
        },
        minPow: 0,
        authRequiredKinds: [20100, 20101],
        retention: [
          { kinds: [1, 7], maxAgeSec: 90 * 86400 },
          { kinds: [20100, 20101], maxAgeSec: 60 },
        ],
      },
    },
    nip11: {
      name: 'Beamhop Relay',
      description: 'Nostr relay + TURN for Beamhop Lightspeed apps',
      pubkey: owner,
      contact: 'mailto:ops@example.com',
      supported_nips: [1, 9, 11, 13, 40, 42, 45, 50, 77, 86, 98],
      software: 'https://github.com/beamhop/lightspeed',
      version: '0.1.0',
      limitation: {
        max_message_length: 131072,
        max_subscriptions: 50,
        auth_required: false,
        payment_required: false,
      },
    },
    allocations,
    bans: [
      {
        id: 'ban-1',
        ip: '198.51.100.23',
        reason: 'TURN abuse',
        createdAt: sec - 86400,
        expiresAt: null,
        createdBy: owner,
      },
      {
        id: 'ban-2',
        ip: '203.0.113.0/24',
        reason: 'Spam flood',
        createdAt: sec - 3600,
        expiresAt: sec + 86400,
        createdBy: 'ops',
      },
    ],
    blobs,
    plans,
    invoices,
    paid,
    nwc: {
      connected: true,
      walletPubkey: hex(),
      relay: 'wss://relay.getalby.com/v1',
      lnurl: 'pay@relay.example.com',
      balanceSats: 184_220,
    },
    admins,
    sessions,
    audit,
    settings,
    backups: [
      {
        id: 'bk-2',
        createdAt: sec - 86400 + 3 * 3600,
        sizeBytes: 412e6,
        files: ['nostr.db', 'admin.db'],
        status: 'done',
      },
      {
        id: 'bk-1',
        createdAt: sec - 2 * 86400 + 3 * 3600,
        sizeBytes: 398e6,
        files: ['nostr.db', 'admin.db'],
        status: 'done',
      },
    ],
    alerts: [
      {
        id: 'al-1',
        level: 'warning',
        code: 'turn_quota',
        message: `${apps[1]?.name} is at 92% of its monthly TURN quota`,
        createdAt: sec - 900,
        target: { app: apps[1]?.id as string },
      },
      {
        id: 'al-2',
        level: 'critical',
        code: 'rate_limit',
        message: `Client ${ips[3]} hit the per-IP rate limit 400 times in 5 minutes`,
        createdAt: sec - 120,
        target: { ip: ips[3] as string },
      },
      {
        id: 'al-3',
        level: 'info',
        code: 'cert_expiry',
        message: 'TLS certificate renews in 21 days',
        createdAt: sec - 86400,
      },
    ],
    startedAt: now - (3 * 86400 + 4 * 3600) * 1000,
    totalEvents: 1_284_310,
  }
}
