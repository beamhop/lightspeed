import {
  parseTurnUsername,
  type TurnCredentialsResponse,
  turnPassword,
  turnUsername,
} from '@beamhop/p2p/wire'
import type { AppStore } from './apps'
import { CORS_HEADERS } from './blossom'
import type { RelayContext } from './context'
import type { TurnQuota } from './engines'
import { TURN_METRICS, type UsageMeter } from './usage'
import { isHex64, tagValue, verifyEvent } from './util/crypto'
import { HttpError, json } from './util/http'

export const NIP98_KIND = 27235

/** Validate a NIP-98 `Authorization: Nostr <base64>` header for this request; returns the pubkey. */
export function verifyNip98(req: Request, now: number): string {
  const h = req.headers.get('authorization') ?? ''
  if (!h.startsWith('Nostr '))
    throw new HttpError(401, 'unauthenticated', 'Bearer API key or NIP-98 auth required')
  let ev: unknown
  try {
    ev = JSON.parse(atob(h.slice(6).trim()))
  } catch {
    throw new HttpError(401, 'bad-auth', 'malformed NIP-98 authorization')
  }
  if (!verifyEvent(ev) || ev.kind !== NIP98_KIND)
    throw new HttpError(401, 'bad-auth', 'invalid NIP-98 event')
  if (Math.abs(ev.created_at - now) > 60)
    throw new HttpError(401, 'bad-auth', 'NIP-98 event is stale')
  if ((tagValue(ev, 'method') ?? '').toUpperCase() !== req.method)
    throw new HttpError(401, 'bad-auth', 'NIP-98 method tag mismatch')
  let u: URL
  try {
    u = new URL(tagValue(ev, 'u') ?? '')
  } catch {
    throw new HttpError(401, 'bad-auth', 'NIP-98 u tag missing')
  }
  const reqUrl = new URL(req.url)
  // Compare path and host only: a TLS-terminating proxy may change the scheme the relay sees.
  const host = req.headers.get('host') ?? reqUrl.host
  if (u.pathname !== reqUrl.pathname || u.host !== host)
    throw new HttpError(401, 'bad-auth', 'NIP-98 u tag does not match this URL')
  return ev.pubkey
}

/** POST /a/<appId>/turn-credentials → TurnCredentialsResponse (TURN REST credentials, HMAC-SHA1). */
export async function handleTurnCredentials(
  req: Request,
  appId: string,
  ctx: RelayContext,
): Promise<Response> {
  const headers = CORS_HEADERS
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST')
  const app = ctx.apps.active(appId)
  if (!app) throw new HttpError(404, 'not-found', `app ${appId} not found`)
  if (!ctx.config.turn.enabled)
    throw new HttpError(503, 'turn-disabled', 'TURN is disabled on this relay')
  const authz = req.headers.get('authorization') ?? ''
  let pubkey: string
  if (authz.startsWith('Bearer ')) {
    if (!ctx.apps.verifyApiKey(appId, authz.slice(7).trim()))
      throw new HttpError(401, 'bad-api-key', 'invalid API key')
    const text = await req.text()
    let body: { pubkey?: unknown } = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
    }
    const pk = typeof body.pubkey === 'string' ? body.pubkey.toLowerCase() : ''
    if (pk && !isHex64(pk)) throw new HttpError(400, 'invalid', 'pubkey must be 64 hex chars')
    pubkey = pk || 'anonymous'
  } else {
    pubkey = verifyNip98(req, ctx.adb.now())
  }
  if (pubkey !== 'anonymous' && ctx.bans.pubkeyBanned(pubkey))
    throw new HttpError(403, 'banned', 'pubkey is banned')
  if (app.turnMonthlyBytes > 0 && ctx.meter.month(app.id, TURN_METRICS) >= app.turnMonthlyBytes) {
    throw new HttpError(429, 'quota-exceeded', 'monthly TURN quota exhausted for this app')
  }
  const ttl = ctx.config.turn.credentialTtl
  const username = turnUsername(ctx.adb.now() + ttl, app.id, pubkey)
  const credential = turnPassword(app.turnSecret, username)
  const host = ctx.config.turn.publicHost || new URL(ctx.baseUrl(req)).hostname
  const t = ctx.config.turn
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const turnUrls = [`turn:${h}:${t.udpPort}?transport=udp`, `turn:${h}:${t.tcpPort}?transport=tcp`]
  if (t.tlsPort > 0 && ctx.config.http.tlsCert)
    turnUrls.push(`turns:${h}:${t.tlsPort}?transport=tcp`)
  const body: TurnCredentialsResponse = {
    iceServers: [{ urls: `stun:${h}:${t.udpPort}` }, { urls: turnUrls, username, credential }],
    ttl,
  }
  ctx.meter.add(app.id, 'turn_credentials', 1)
  return json(body, { headers })
}

/**
 * Callbacks for createTurnServer: long-term credential lookup from the app secret, per-app quotas
 * and byte accounting.
 */
export function turnHooks(
  apps: AppStore,
  meter: UsageMeter,
  isBanned: (pubkey: string) => boolean,
  now: () => number,
) {
  return {
    credentials(username: string): { password: string } | null {
      const u = parseTurnUsername(username)
      if (!u || u.expiry < now()) return null
      const app = apps.active(u.appId)
      if (!app) return null
      if (u.pubkey !== 'anonymous' && isBanned(u.pubkey)) return null
      return { password: turnPassword(app.turnSecret, username) }
    },
    quota(username: string): TurnQuota {
      const u = parseTurnUsername(username)
      const app = u ? apps.active(u.appId) : null
      if (!app) return { allowed: false }
      const exhausted =
        app.turnMonthlyBytes > 0 && meter.month(app.id, TURN_METRICS) >= app.turnMonthlyBytes
      return {
        allowed: !exhausted,
        maxAllocations: app.turnMaxAllocations || undefined,
        maxBps: app.turnMaxBps || undefined,
      }
    },
    onUsage(u: { username: string; bytesIn: number; bytesOut: number }) {
      const p = parseTurnUsername(u.username)
      if (!p) return
      meter.add(p.appId, 'turn_bytes_in', u.bytesIn)
      meter.add(p.appId, 'turn_bytes_out', u.bytesOut)
    },
  }
}
