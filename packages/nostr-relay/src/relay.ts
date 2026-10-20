import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import {
  canonical,
  computeId,
  expiration,
  isEphemeral,
  isProtected,
  nowSec,
  powDifficulty,
  powTarget,
  tagValue,
  validateShape,
  verifyEvent,
} from './event'
import { matchFilters, parseFilter } from './filter'
import { ModerationStore } from './moderation'
import { Negentropy, NegentropyStorageVector } from './negentropy'
import { allowAll, RateLimiter } from './policy'
import { EventStore, realmKey } from './store'
import type {
  Filter,
  Nip11Info,
  NostrEvent,
  NostrRelay,
  NostrRelayOptions,
  NostrSocketData,
  NostrWebSocket,
  Policy,
  PublishResult,
  SubscriptionInfo,
} from './types'
import { createVerifyPool } from './verify-pool'

export const SUPPORTED_NIPS = [1, 9, 11, 13, 40, 42, 45, 50, 70, 77, 86]
const DEFAULT_MAX_LIMIT = 5000
const DEFAULT_MAX_NEG_RECORDS = 500_000
const MAX_SUBID_LENGTH = 64

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface IngestContext {
  trusted: boolean
  ws?: NostrWebSocket
  ip?: string
}

const ok = (message = ''): PublishResult => ({ ok: true, message })
const fail = (message: string): PublishResult => ({ ok: false, message })

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u)
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return null
  }
}

function randomHex(bytes: number) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function createNostrRelay(opts: NostrRelayOptions): NostrRelay {
  const store = new EventStore(opts.dbPath)
  const moderation = new ModerationStore(store.db)
  const policies = opts.policy ?? allowAll
  const verifier = createVerifyPool(opts.verifyWorkers ?? 0)
  const limiter = new RateLimiter()
  const sockets = new Set<NostrWebSocket>()
  /** realm key -> sockets that currently hold at least one subscription */
  const subscribers = new Map<string, Set<NostrWebSocket>>()
  const listeners = new Set<(e: NostrEvent, realm: string | null) => void>()
  let connCounter = 0
  let subCount = 0
  let closed = false

  // events/second over a 5 s sliding window of 1 s buckets
  const epsBuckets = new Array<number>(6).fill(0)
  let epsSecond = Math.floor(Date.now() / 1000)
  const tickEps = (n: number) => {
    const s = Math.floor(Date.now() / 1000)
    if (s !== epsSecond) {
      const steps = Math.min(s - epsSecond, epsBuckets.length)
      for (let i = 1; i <= steps; i++) epsBuckets[(epsSecond + i) % epsBuckets.length] = 0
      epsSecond = s
    }
    epsBuckets[s % epsBuckets.length] = (epsBuckets[s % epsBuckets.length] as number) + n
  }
  let cachedCount = { at: 0, n: 0 }

  const policyFor = (realm: string | null): Policy => policies.get(realm) ?? {}

  const send = (ws: NostrWebSocket, msg: unknown[]) => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // socket already closed
    }
  }

  const authRequiredKindsFor = (policy: Policy, ws: NostrWebSocket | undefined) =>
    ws && ws.data.authed.size === 0 && policy.authRequiredKinds?.length
      ? policy.authRequiredKinds
      : undefined

  function ipBlocked(realm: string | null, ip: string) {
    return moderation.snapshot(realm).blockedIps.has(ip) || moderation.snapshot(null).blockedIps.has(ip)
  }

  // ---------------------------------------------------------------- ingest pipeline

  async function ingest(raw: unknown, realm: string | null, ctx: IngestContext): Promise<PublishResult> {
    const shapeErr = validateShape(raw)
    if (shapeErr) return fail(`invalid: ${shapeErr}`)
    const ev = canonical(raw as NostrEvent)
    const policy = policyFor(realm)
    const mod = moderation.snapshot(realm)
    const gmod = realm === null ? mod : moderation.snapshot(null)
    const now = nowSec()

    if (policy.maxEventBytes !== undefined) {
      const size = encoder.encode(JSON.stringify(ev)).length
      if (size > policy.maxEventBytes)
        return fail(`invalid: event is ${size} bytes, maximum is ${policy.maxEventBytes}`)
    }
    if (!ctx.trusted) {
      const ip = ctx.ip ?? ''
      if (ipBlocked(realm, ip)) return fail('blocked: your IP address is blocked')
      if (policy.rateLimits?.ip && !limiter.take(`ip:${realmKey(realm)}:${ip}`, policy.rateLimits.ip))
        return fail('rate-limited: slow down, too many events from your IP')
      if (policy.authRequired && ctx.ws && ctx.ws.data.authed.size === 0)
        return fail('auth-required: this relay requires authentication')
    }
    if (ev.kind === 22242) return fail('invalid: AUTH events must be sent in an AUTH message')
    if (ev.created_at > now + (policy.maxFutureSeconds ?? 900))
      return fail('invalid: created_at is too far in the future')
    if (policy.maxPastSeconds !== undefined && ev.created_at < now - policy.maxPastSeconds)
      return fail('invalid: created_at is too far in the past')
    if (policy.maxEventTags !== undefined && ev.tags.length > policy.maxEventTags)
      return fail(`invalid: too many tags (max ${policy.maxEventTags})`)
    if (policy.maxContentLength !== undefined && ev.content.length > policy.maxContentLength)
      return fail(`invalid: content too long (max ${policy.maxContentLength})`)
    const exp = expiration(ev)
    if (exp !== null && exp <= now) return fail('invalid: event has expired')
    if (mod.bannedEvents.has(ev.id)) return fail('blocked: this event is banned')

    if (policy.kinds?.deny?.includes(ev.kind) || mod.disallowedKinds.has(ev.kind))
      return fail(`blocked: kind ${ev.kind} is not allowed`)
    const kindAllow = policy.kinds?.allow ?? []
    if (
      (kindAllow.length > 0 || mod.allowedKinds.size > 0) &&
      !kindAllow.includes(ev.kind) &&
      !mod.allowedKinds.has(ev.kind)
    )
      return fail(`blocked: kind ${ev.kind} is not allowed`)
    if (
      policy.pubkeys?.deny?.includes(ev.pubkey) ||
      mod.bannedPubkeys.has(ev.pubkey) ||
      gmod.bannedPubkeys.has(ev.pubkey)
    )
      return fail('blocked: pubkey is banned')

    if (policy.minPow) {
      const target = powTarget(ev)
      if (target !== null && target < policy.minPow)
        return fail(`pow: committed target ${target} is less than ${policy.minPow}`)
      const d = powDifficulty(ev.id)
      if (d < policy.minPow) return fail(`pow: difficulty ${d} is less than ${policy.minPow}`)
    }

    if (!ctx.trusted && ctx.ws) {
      const authed = ctx.ws.data.authed
      if (policy.authRequiredKinds?.includes(ev.kind) && authed.size === 0)
        return fail(`auth-required: kind ${ev.kind} requires authentication`)
      if (isProtected(ev)) {
        if (authed.size === 0)
          return fail('auth-required: this event may only be published by its author')
        if (!authed.has(ev.pubkey))
          return fail('restricted: this event may only be published by its author')
      }
    }

    if (computeId(ev) !== ev.id) return fail('invalid: event id does not match')
    if (!(await verifier.verify(ev))) return fail('invalid: bad signature')

    if (!ctx.trusted && policy.rateLimits?.pubkey) {
      if (!limiter.take(`pk:${realmKey(realm)}:${ev.pubkey}`, policy.rateLimits.pubkey))
        return fail('rate-limited: slow down, too many events from this pubkey')
    }

    const allow = policy.pubkeys?.allow ?? []
    if (allow.length > 0 || mod.allowedPubkeys.size > 0 || policy.writeAllowed) {
      let permitted = allow.includes(ev.pubkey) || mod.allowedPubkeys.has(ev.pubkey)
      if (!permitted && policy.writeAllowed) {
        try {
          permitted = await policy.writeAllowed(ev.pubkey, ev)
        } catch {
          permitted = false
        }
      }
      if (!permitted) {
        const pay = policy.info?.payments_url ?? opts.info.payments_url
        return fail(
          pay
            ? `restricted: payment required to write, see ${pay}`
            : 'restricted: this pubkey is not allowed to write here',
        )
      }
    }

    if (closed) return fail('error: relay is shutting down')
    if (isEphemeral(ev.kind)) {
      deliver(ev, realm)
      return ok()
    }
    let res: PublishResult & { stored?: boolean }
    try {
      res = store.insert(ev, realmKey(realm))
    } catch (err) {
      return fail(`error: could not store event: ${(err as Error).message}`)
    }
    if (res.stored) deliver(ev, realm)
    return { ok: res.ok, message: res.message }
  }

  /** Fan out to live subscriptions in the same realm and to onEvent listeners. */
  function deliver(ev: NostrEvent, realm: string | null) {
    tickEps(1)
    const subs = subscribers.get(realmKey(realm))
    if (subs && subs.size > 0) {
      const raw = JSON.stringify(ev)
      const authKinds = policyFor(realm).authRequiredKinds
      const restricted = authKinds?.includes(ev.kind) ?? false
      for (const ws of subs) {
        if (restricted && ws.data.authed.size === 0) continue
        for (const [subId, filters] of ws.data.subs) {
          if (matchFilters(filters, ev)) {
            try {
              ws.send(`["EVENT",${JSON.stringify(subId)},${raw}]`)
            } catch {
              // closed
            }
          }
        }
      }
    }
    for (const cb of listeners) {
      try {
        cb(ev, realm)
      } catch {
        // listener errors never break the pipeline
      }
    }
  }

  // ---------------------------------------------------------------- message handlers

  /** Shared REQ/COUNT/NEG-OPEN gatekeeping. Returns an error message or null. */
  function readGate(ws: NostrWebSocket, policy: Policy, filters: Filter[]): string | null {
    if (ipBlocked(ws.data.realm, ws.data.ip)) return 'blocked: your IP address is blocked'
    if (policy.authRequired && ws.data.authed.size === 0)
      return 'auth-required: this relay requires authentication'
    if (policy.rateLimits?.reqIp &&
      !limiter.take(`req:${realmKey(ws.data.realm)}:${ws.data.ip}`, policy.rateLimits.reqIp))
      return 'rate-limited: slow down, too many requests'
    const authKinds = policy.authRequiredKinds
    if (authKinds?.length && ws.data.authed.size === 0) {
      for (const f of filters)
        if (f.kinds?.some((k) => authKinds.includes(k)))
          return 'auth-required: these kinds require authentication'
    }
    return null
  }

  function parseFilters(raws: unknown[], policy: Policy): Filter[] | string {
    if (raws.length === 0) return 'invalid: at least one filter is required'
    if (policy.maxFilters !== undefined && raws.length > policy.maxFilters)
      return `invalid: too many filters (max ${policy.maxFilters})`
    const out: Filter[] = []
    for (const r of raws) {
      const f = parseFilter(r)
      if (typeof f === 'string') return `invalid: ${f}`
      out.push(f)
    }
    return out
  }

  const validSubId = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= MAX_SUBID_LENGTH

  function removeSub(ws: NostrWebSocket, subId: string) {
    if (ws.data.subs.delete(subId)) subCount--
    if (ws.data.subs.size === 0) subscribers.get(realmKey(ws.data.realm))?.delete(ws)
  }

  function onReq(ws: NostrWebSocket, msg: unknown[]) {
    const subId = msg[1]
    if (!validSubId(subId)) return send(ws, ['NOTICE', 'invalid: bad subscription id'])
    const policy = policyFor(ws.data.realm)
    const filters = parseFilters(msg.slice(2), policy)
    if (typeof filters === 'string') return send(ws, ['CLOSED', subId, filters])
    const gate = readGate(ws, policy, filters)
    if (gate) {
      removeSub(ws, subId)
      return send(ws, ['CLOSED', subId, gate])
    }
    if (
      policy.maxSubscriptions !== undefined &&
      !ws.data.subs.has(subId) &&
      ws.data.subs.size >= policy.maxSubscriptions
    )
      return send(ws, ['CLOSED', subId, `error: too many subscriptions (max ${policy.maxSubscriptions})`])
    let rows: string[]
    try {
      rows = store.queryRaw(filters, realmKey(ws.data.realm), {
        maxLimit: policy.maxLimit ?? DEFAULT_MAX_LIMIT,
        excludeKinds: authRequiredKindsFor(policy, ws),
      })
    } catch (err) {
      return send(ws, ['CLOSED', subId, `error: ${(err as Error).message}`])
    }
    const sid = JSON.stringify(subId)
    for (const raw of rows) ws.send(`["EVENT",${sid},${raw}]`)
    ws.send(`["EOSE",${sid}]`)
    if (!ws.data.subs.has(subId)) subCount++
    ws.data.subs.set(subId, filters)
    const rk = realmKey(ws.data.realm)
    let set = subscribers.get(rk)
    if (!set) subscribers.set(rk, (set = new Set()))
    set.add(ws)
  }

  function onCount(ws: NostrWebSocket, msg: unknown[]) {
    const subId = msg[1]
    if (!validSubId(subId)) return send(ws, ['NOTICE', 'invalid: bad subscription id'])
    const policy = policyFor(ws.data.realm)
    const filters = parseFilters(msg.slice(2), policy)
    if (typeof filters === 'string') return send(ws, ['CLOSED', subId, filters])
    const gate = readGate(ws, policy, filters)
    if (gate) return send(ws, ['CLOSED', subId, gate])
    try {
      const count = store.count(filters, realmKey(ws.data.realm), {
        excludeKinds: authRequiredKindsFor(policy, ws),
      })
      send(ws, ['COUNT', subId, { count }])
    } catch (err) {
      send(ws, ['CLOSED', subId, `error: ${(err as Error).message}`])
    }
  }

  async function onEventMsg(ws: NostrWebSocket, msg: unknown[]) {
    const ev = msg[1] as Record<string, unknown> | undefined
    const id = ev && typeof ev.id === 'string' ? ev.id : ''
    const res = await ingest(ev, ws.data.realm, { trusted: false, ws, ip: ws.data.ip })
    send(ws, ['OK', id, res.ok, res.message])
  }

  function onAuth(ws: NostrWebSocket, msg: unknown[]) {
    const ev = msg[1] as NostrEvent
    const id = ev && typeof ev.id === 'string' ? ev.id : ''
    const reply = (good: boolean, m: string) => send(ws, ['OK', id, good, m])
    const shapeErr = validateShape(ev)
    if (shapeErr) return reply(false, `invalid: ${shapeErr}`)
    if (ev.kind !== 22242) return reply(false, 'invalid: AUTH event must be kind 22242')
    if (Math.abs(nowSec() - ev.created_at) > 600)
      return reply(false, 'invalid: AUTH event created_at is too far from now')
    if (tagValue(ev, 'challenge') !== ws.data.challenge)
      return reply(false, 'invalid: challenge does not match')
    if (opts.auth?.relayUrl) {
      const relayTag = tagValue(ev, 'relay')
      let good = false
      try {
        good =
          relayTag !== undefined &&
          new URL(relayTag).host.toLowerCase() === new URL(opts.auth.relayUrl).host.toLowerCase()
      } catch {
        good = false
      }
      if (!good) return reply(false, 'invalid: relay tag does not match this relay')
    }
    if (!verifyEvent(ev)) return reply(false, 'invalid: bad signature')
    const mod = moderation.snapshot(ws.data.realm)
    if (mod.bannedPubkeys.has(ev.pubkey) || moderation.snapshot(null).bannedPubkeys.has(ev.pubkey))
      return reply(false, 'blocked: pubkey is banned')
    ws.data.authed.add(ev.pubkey)
    reply(true, '')
  }

  function onNegOpen(ws: NostrWebSocket, msg: unknown[]) {
    const subId = msg[1]
    if (!validSubId(subId)) return send(ws, ['NOTICE', 'invalid: bad subscription id'])
    ws.data.negs.delete(subId)
    const policy = policyFor(ws.data.realm)
    const f = parseFilter(msg[2])
    if (typeof f === 'string') return send(ws, ['NEG-ERR', subId, `invalid: ${f}`])
    if (typeof msg[3] !== 'string') return send(ws, ['NEG-ERR', subId, 'invalid: missing message'])
    const gate = readGate(ws, policy, [f])
    if (gate) return send(ws, ['NEG-ERR', subId, gate])
    const max = policy.maxNegentropyRecords ?? DEFAULT_MAX_NEG_RECORDS
    const items = store.negentropyItems(f, realmKey(ws.data.realm), max, {
      excludeKinds: authRequiredKindsFor(policy, ws),
    })
    if (items.length > max) return send(ws, ['NEG-ERR', subId, 'blocked: too many records'])
    const storage = new NegentropyStorageVector()
    for (const it of items) storage.insert(it.created_at, it.id)
    storage.seal()
    const neg = new Negentropy(storage, opts.negentropyFrameSizeLimit ?? 0)
    try {
      const [reply] = neg.reconcile(msg[3])
      ws.data.negs.set(subId, neg)
      send(ws, ['NEG-MSG', subId, reply])
    } catch (err) {
      send(ws, ['NEG-ERR', subId, `error: ${(err as Error).message}`])
    }
  }

  function onNegMsg(ws: NostrWebSocket, msg: unknown[]) {
    const subId = msg[1]
    if (!validSubId(subId)) return send(ws, ['NOTICE', 'invalid: bad subscription id'])
    const neg = ws.data.negs.get(subId)
    if (!neg) return send(ws, ['NEG-ERR', subId, 'closed: unknown subscription'])
    if (typeof msg[2] !== 'string') return send(ws, ['NEG-ERR', subId, 'invalid: missing message'])
    try {
      const [reply] = neg.reconcile(msg[2])
      send(ws, ['NEG-MSG', subId, reply])
    } catch (err) {
      ws.data.negs.delete(subId)
      send(ws, ['NEG-ERR', subId, `error: ${(err as Error).message}`])
    }
  }

  function onMessage(ws: NostrWebSocket, data: string | Buffer) {
    const text = typeof data === 'string' ? data : decoder.decode(data)
    const policy = policyFor(ws.data.realm)
    if (policy.maxMessageBytes !== undefined && text.length > policy.maxMessageBytes)
      return send(ws, ['NOTICE', `error: message exceeds ${policy.maxMessageBytes} bytes`])
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return send(ws, ['NOTICE', 'error: could not parse message as JSON'])
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string')
      return send(ws, ['NOTICE', 'error: message must be a JSON array with a type'])
    switch (msg[0]) {
      case 'EVENT':
        void onEventMsg(ws, msg)
        return
      case 'REQ':
        return onReq(ws, msg)
      case 'CLOSE':
        if (typeof msg[1] === 'string') removeSub(ws, msg[1])
        return
      case 'COUNT':
        return onCount(ws, msg)
      case 'AUTH':
        return onAuth(ws, msg)
      case 'NEG-OPEN':
        return onNegOpen(ws, msg)
      case 'NEG-MSG':
        return onNegMsg(ws, msg)
      case 'NEG-CLOSE':
        if (typeof msg[1] === 'string') ws.data.negs.delete(msg[1])
        return
      default:
        return send(ws, ['NOTICE', `error: unknown message type ${JSON.stringify(msg[0]).slice(0, 32)}`])
    }
  }

  // ---------------------------------------------------------------- NIP-11

  function infoDocument(realm: string | null): Nip11Info {
    const policy = policyFor(realm)
    const meta = moderation.snapshot(realm).meta
    const doc: Nip11Info = {
      supported_nips: SUPPORTED_NIPS,
      software: 'https://github.com/beamhop/lightspeed',
      version: '0.0.0',
      ...opts.info,
      ...policy.info,
      ...meta,
    }
    const restricted =
      (policy.pubkeys?.allow?.length ?? 0) > 0 ||
      !!policy.writeAllowed ||
      (policy.kinds?.allow?.length ?? 0) > 0
    doc.limitation = {
      max_limit: policy.maxLimit ?? DEFAULT_MAX_LIMIT,
      max_subid_length: MAX_SUBID_LENGTH,
      ...(policy.maxMessageBytes !== undefined && { max_message_length: policy.maxMessageBytes }),
      ...(policy.maxSubscriptions !== undefined && { max_subscriptions: policy.maxSubscriptions }),
      ...(policy.maxEventTags !== undefined && { max_event_tags: policy.maxEventTags }),
      ...(policy.maxContentLength !== undefined && { max_content_length: policy.maxContentLength }),
      ...(policy.minPow !== undefined && { min_pow_difficulty: policy.minPow }),
      auth_required: !!policy.authRequired,
      restricted_writes: restricted,
      ...(policy.writeAllowed && { payment_required: !!(policy.info?.payments_url ?? opts.info.payments_url) }),
      created_at_upper_limit: policy.maxFutureSeconds ?? 900,
      ...(policy.maxPastSeconds !== undefined && { created_at_lower_limit: policy.maxPastSeconds }),
      ...opts.info.limitation,
      ...policy.info?.limitation,
    }
    if (policy.retention?.length) {
      doc.retention = policy.retention.map((r) => ({
        ...(r.kinds && { kinds: r.kinds }),
        ...(r.maxAgeSeconds !== undefined && { time: r.maxAgeSeconds }),
        ...(r.maxCount !== undefined && { count: r.maxCount }),
      }))
    }
    return doc
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }

  // ---------------------------------------------------------------- NIP-86 + NIP-98

  function isAdmin(pubkey: string, realm: string | null) {
    return (
      (opts.admins?.includes(pubkey) ?? false) ||
      (policyFor(realm).admins?.includes(pubkey) ?? false) ||
      (realm !== null && (policyFor(null).admins?.includes(pubkey) ?? false))
    )
  }

  function checkNip98(req: Request, body: string): { pubkey: string } | string {
    const header = req.headers.get('authorization') ?? ''
    const m = /^Nostr\s+(\S+)$/i.exec(header.trim())
    if (!m) return 'missing NIP-98 Authorization header'
    let ev: NostrEvent
    try {
      ev = JSON.parse(decoder.decode(Uint8Array.from(atob(m[1] as string), (c) => c.charCodeAt(0))))
    } catch {
      return 'malformed NIP-98 Authorization header'
    }
    if (validateShape(ev)) return 'invalid NIP-98 event'
    if (ev.kind !== 27235) return 'NIP-98 event must be kind 27235'
    if (Math.abs(nowSec() - ev.created_at) > 60) return 'NIP-98 event is too old or in the future'
    const u = tagValue(ev, 'u')
    if (!u || normalizeUrl(u) !== normalizeUrl(req.url)) return 'NIP-98 u tag does not match'
    if ((tagValue(ev, 'method') ?? '').toUpperCase() !== req.method.toUpperCase())
      return 'NIP-98 method tag does not match'
    const payload = tagValue(ev, 'payload')
    if (payload === undefined || payload !== bytesToHex(sha256(encoder.encode(body))))
      return 'NIP-98 payload tag does not match the body'
    if (!verifyEvent(ev)) return 'NIP-98 event has a bad signature'
    return { pubkey: ev.pubkey }
  }

  const MGMT_METHODS = [
    'supportedmethods',
    'banpubkey',
    'unbanpubkey',
    'listbannedpubkeys',
    'allowpubkey',
    'unallowpubkey',
    'listallowedpubkeys',
    'listeventsneedingmoderation',
    'allowevent',
    'banevent',
    'unbanevent',
    'listbannedevents',
    'changerelayname',
    'changerelaydescription',
    'changerelayicon',
    'allowkind',
    'disallowkind',
    'listallowedkinds',
    'listdisallowedkinds',
    'blockip',
    'unblockip',
    'listblockedips',
  ]

  function runManagement(realm: string | null, method: string, params: unknown[]): unknown {
    const str = (i: number) => {
      const v = params[i]
      if (typeof v !== 'string') throw new Error(`param ${i} must be a string`)
      return v
    }
    const optStr = (i: number) => (typeof params[i] === 'string' ? (params[i] as string) : '')
    const hex = (i: number) => {
      const v = str(i)
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`param ${i} must be 64-char hex`)
      return v
    }
    const kind = (i: number) => {
      const v = params[i]
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535)
        throw new Error(`param ${i} must be a kind number`)
      return v
    }
    switch (method) {
      case 'supportedmethods':
        return MGMT_METHODS
      case 'banpubkey':
        moderation.banPubkey(realm, hex(0), optStr(1))
        return true
      case 'unbanpubkey':
        moderation.unbanPubkey(realm, hex(0))
        return true
      case 'listbannedpubkeys':
        return moderation.listBannedPubkeys(realm)
      case 'allowpubkey':
        moderation.allowPubkey(realm, hex(0), optStr(1))
        return true
      case 'unallowpubkey':
        moderation.unallowPubkey(realm, hex(0))
        return true
      case 'listallowedpubkeys':
        return moderation.listAllowedPubkeys(realm)
      case 'listeventsneedingmoderation':
        return []
      case 'allowevent':
      case 'unbanevent':
        moderation.unbanEvent(realm, hex(0))
        return true
      case 'banevent': {
        const id = hex(0)
        moderation.banEvent(realm, id, optStr(1))
        store.deleteById(realmKey(realm), id)
        return true
      }
      case 'listbannedevents':
        return moderation.listBannedEvents(realm)
      case 'changerelayname':
        moderation.setInfo(realm, 'name', str(0))
        return true
      case 'changerelaydescription':
        moderation.setInfo(realm, 'description', str(0))
        return true
      case 'changerelayicon':
        moderation.setInfo(realm, 'icon', str(0))
        return true
      case 'allowkind':
        moderation.allowKind(realm, kind(0))
        return true
      case 'disallowkind':
        moderation.disallowKind(realm, kind(0))
        return true
      case 'listallowedkinds':
        return moderation.listAllowedKinds(realm)
      case 'listdisallowedkinds':
        return moderation.listDisallowedKinds(realm)
      case 'blockip':
        moderation.blockIp(realm, str(0), optStr(1))
        return true
      case 'unblockip':
        moderation.unblockIp(realm, str(0))
        return true
      case 'listblockedips':
        return moderation.listBlockedIps(realm)
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }

  // ---------------------------------------------------------------- sweeper

  function sweep(): number {
    let n = store.sweepExpired()
    for (const rk of store.realms()) {
      const rules = policyFor(rk === '' ? null : rk).retention
      if (rules?.length) n += store.applyRetention(rk, rules)
    }
    limiter.prune()
    return n
  }
  const sweepMs = opts.sweepIntervalMs ?? 60_000
  const sweepTimer =
    sweepMs > 0
      ? setInterval(() => {
          try {
            sweep()
          } catch {
            // keep sweeping on the next tick
          }
        }, sweepMs)
      : null
  sweepTimer?.unref?.()

  // ---------------------------------------------------------------- public API

  const mgmtJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/nostr+json+rpc', ...corsHeaders },
    })

  return {
    websocket: {
      open(ws) {
        sockets.add(ws)
        send(ws, ['AUTH', ws.data.challenge])
      },
      message: onMessage,
      close(ws) {
        sockets.delete(ws)
        subCount -= ws.data.subs.size
        ws.data.subs.clear()
        ws.data.negs.clear()
        subscribers.get(realmKey(ws.data.realm))?.delete(ws)
      },
      drain() {},
    },

    socketData({ realm, ip }): NostrSocketData {
      return {
        kind: 'nostr',
        connId: ++connCounter,
        realm: realm === '' ? null : realm,
        ip,
        challenge: randomHex(16),
        authed: new Set(),
        subs: new Map(),
        negs: new Map(),
        connectedAt: Date.now(),
      }
    },

    handleInfo(req, realm) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
      return new Response(JSON.stringify(infoDocument(realm)), {
        headers: { 'Content-Type': 'application/nostr+json', ...corsHeaders },
      })
    },

    async handleManagement(req, realm) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
      if (req.method !== 'POST') return mgmtJson({ result: null, error: 'use POST' }, 405)
      const body = await req.text()
      const auth = checkNip98(req, body)
      if (typeof auth === 'string') return mgmtJson({ result: null, error: auth }, 401)
      if (!isAdmin(auth.pubkey, realm)) return mgmtJson({ result: null, error: 'not an admin' }, 401)
      let rpc: { method?: unknown; params?: unknown }
      try {
        rpc = JSON.parse(body)
      } catch {
        return mgmtJson({ result: null, error: 'invalid JSON body' }, 400)
      }
      if (typeof rpc.method !== 'string')
        return mgmtJson({ result: null, error: 'missing method' }, 400)
      const params = Array.isArray(rpc.params) ? rpc.params : []
      try {
        return mgmtJson({ result: runManagement(realm, rpc.method, params) })
      } catch (err) {
        return mgmtJson({ result: null, error: (err as Error).message })
      }
    },

    publish(event, realm = null) {
      return ingest(event, realm ?? null, { trusted: true })
    },

    query(filters, realm = null) {
      return store.query(filters, realmKey(realm), { maxLimit: Number.MAX_SAFE_INTEGER })
    },

    count(filters, realm = null) {
      return store.count(filters, realmKey(realm))
    },

    deleteEvent(id, realm = null) {
      return store.deleteById(realmKey(realm), id)
    },

    stats() {
      const now = Date.now()
      if (now - cachedCount.at > 1000) cachedCount = { at: now, n: store.totalEvents() }
      tickEps(0)
      const cur = Math.floor(now / 1000)
      let sum = 0
      for (let i = 1; i <= 5; i++) sum += epsBuckets[(cur - i) % epsBuckets.length] as number
      return {
        events: cachedCount.n,
        subscriptions: subCount,
        clients: sockets.size,
        eventsPerSec: sum / 5,
      }
    },

    subscriptions(): SubscriptionInfo[] {
      const out: SubscriptionInfo[] = []
      for (const ws of sockets)
        for (const [subId, filters] of ws.data.subs)
          out.push({
            connId: ws.data.connId,
            realm: ws.data.realm,
            ip: ws.data.ip,
            subId,
            filters,
            authed: [...ws.data.authed],
          })
      return out
    },

    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    moderation,
    sweep,

    backup(path) {
      store.backup(path)
    },

    close() {
      if (closed) return
      closed = true
      if (sweepTimer) clearInterval(sweepTimer)
      for (const ws of sockets) {
        try {
          ws.close(1001, 'relay shutting down')
        } catch {
          // ignore
        }
      }
      sockets.clear()
      subscribers.clear()
      listeners.clear()
      verifier.close()
      store.close()
    },
  }
}
