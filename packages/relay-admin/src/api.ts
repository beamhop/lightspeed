// Typed client for the relay admin REST API (base /api/admin, cookie session `bh_admin`).
// Mirrors the endpoint list in CLAUDE.md. Responses are normalized so list endpoints may return
// either a bare array or `{ items: [...] }`.

import type {
  Admin,
  Allocation,
  App,
  AppCreated,
  AppPatch,
  AppUsage,
  AuditEntry,
  Backup,
  Ban,
  EventQuery,
  Invoice,
  Me,
  MediaBlob,
  NewAdmin,
  NewBan,
  Nip11Info,
  NostrEvent,
  NwcStatus,
  Overview,
  PaidPubkey,
  Plan,
  Policy,
  Session,
  Settings,
  Subscription,
} from './types'
import { GLOBAL_REALM } from './types'

export * from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
  get unauthorized(): boolean {
    return this.status === 401
  }
}

export interface ApiOptions {
  /** Base URL of the admin API. Default '/api/admin'. */
  baseUrl?: string
  fetch?: typeof fetch
  /** Called on every 401 so the app can drop the session. */
  onUnauthorized?: () => void
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>

export function buildQuery(q: Query | undefined): string {
  if (!q) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','))
    } else p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Accept `[...]`, `{ items: [...] }` or `{ <key>: [...] }`. */
export function asList<T>(body: unknown, key?: string): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (Array.isArray(o.items)) return o.items as T[]
    if (key && Array.isArray(o[key])) return o[key] as T[]
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as T[]
  }
  return []
}

export const DEFAULT_POLICY: Policy = {
  pubkeys: { allow: [], deny: [] },
  kinds: { allow: [], deny: [] },
  rateLimits: { perIp: { events: 0, windowSec: 60 }, perPubkey: { events: 0, windowSec: 60 } },
  maxEventSize: 65536,
  minPow: 0,
  authRequiredKinds: [],
  retention: [],
}

export function normalizePolicy(p: Partial<Policy> | null | undefined): Policy {
  const d = DEFAULT_POLICY
  const x = p ?? {}
  return {
    pubkeys: { allow: x.pubkeys?.allow ?? [], deny: x.pubkeys?.deny ?? [] },
    kinds: { allow: x.kinds?.allow ?? [], deny: x.kinds?.deny ?? [] },
    rateLimits: {
      perIp: { ...d.rateLimits.perIp, ...x.rateLimits?.perIp },
      perPubkey: { ...d.rateLimits.perPubkey, ...x.rateLimits?.perPubkey },
    },
    maxEventSize: x.maxEventSize ?? d.maxEventSize,
    minPow: x.minPow ?? d.minPow,
    authRequiredKinds: x.authRequiredKinds ?? [],
    retention: x.retention ?? [],
  }
}

export function createApi(opts: ApiOptions = {}) {
  const base = (opts.baseUrl ?? '/api/admin').replace(/\/$/, '')
  const f = () => opts.fetch ?? globalThis.fetch

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers:
        body !== undefined
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    let res: Response
    try {
      res = await f()(`${base}${path}${buildQuery(query)}`, init)
    } catch (e) {
      throw new ApiError(0, 'network', e instanceof Error ? e.message : 'Network error')
    }
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error
      if (res.status === 401) opts.onUnauthorized?.()
      throw new ApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? (res.statusText || `HTTP ${res.status}`),
      )
    }
    return data as T
  }

  const get = <T>(p: string, q?: Query) => request<T>('GET', p, undefined, q)
  const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {})
  const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b)
  const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b)
  const del = <T = unknown>(p: string) => request<T>('DELETE', p)
  const enc = encodeURIComponent

  return {
    request,
    auth: {
      challenge: () => post<{ challenge: string }>('/auth/challenge'),
      nostr: (event: NostrEvent) => post<Me>('/auth/nostr', { event }),
      password: (username: string, password: string, totp: string) =>
        post<Me>('/auth/password', { username, password, totp }),
      bootstrap: (body: { token: string; pubkey?: string; username?: string; password?: string }) =>
        post<Me & { totpSecret?: string; totpUri?: string }>('/auth/bootstrap', body),
      logout: () => post<void>('/auth/logout'),
      me: () => get<Me>('/me'),
    },
    overview: {
      get: () => get<Overview>('/overview'),
      /** Extension: acknowledge an alert. */
      ackAlert: (id: string) => post<void>(`/overview/alerts/${enc(id)}/ack`),
    },
    apps: {
      list: async () => asList<App>(await get('/apps'), 'apps'),
      create: (body: { name: string; description?: string; plan?: string }) =>
        post<AppCreated>('/apps', body),
      get: (id: string) => get<App>(`/apps/${enc(id)}`),
      update: (id: string, body: AppPatch) => patch<App>(`/apps/${enc(id)}`, body),
      remove: (id: string) => del(`/apps/${enc(id)}`),
      rotateTurnSecret: (id: string) =>
        post<{ turnSecret: string }>(`/apps/${enc(id)}/rotate-turn-secret`),
      rotateApiKey: (id: string) => post<{ apiKey: string }>(`/apps/${enc(id)}/rotate-api-key`),
      usage: (id: string, q?: { from?: number; to?: number }) =>
        get<AppUsage>(`/apps/${enc(id)}/usage`, q),
    },
    nostr: {
      events: async (q: EventQuery = {}) =>
        asList<NostrEvent>(
          await get('/nostr/events', {
            kind: Array.isArray(q.kind) ? q.kind : q.kind,
            author: q.author,
            tag: q.tag,
            search: q.search,
            limit: q.limit,
            until: q.until,
            realm: q.realm,
          }),
          'events',
        ),
      deleteEvent: (id: string) => del(`/nostr/events/${enc(id)}`),
      subscriptions: async () =>
        asList<Subscription>(await get('/nostr/subscriptions'), 'subscriptions'),
    },
    policies: {
      get: async (realm: string = GLOBAL_REALM) =>
        normalizePolicy(await get<Partial<Policy>>(`/policies/${enc(realm)}`)),
      put: (realm: string, policy: Policy) => put<Policy>(`/policies/${enc(realm)}`, policy),
    },
    nip11: {
      get: () => get<Nip11Info>('/nip11'),
      put: (info: Nip11Info) => put<Nip11Info>('/nip11', info),
    },
    turn: {
      allocations: async () => asList<Allocation>(await get('/turn/allocations'), 'allocations'),
      kill: (id: string) => del(`/turn/allocations/${enc(id)}`),
    },
    bans: {
      list: async () => asList<Ban>(await get('/bans'), 'bans'),
      add: (b: NewBan) => post<Ban>('/bans', b),
      remove: (idOrIp: string) => del(`/bans/${enc(idOrIp)}`),
    },
    media: {
      blobs: async (q: { app?: string; pubkey?: string } = {}) =>
        asList<MediaBlob>(await get('/media/blobs', q), 'blobs'),
      remove: (sha256: string) => del(`/media/blobs/${enc(sha256)}`),
    },
    payments: {
      plans: async () => asList<Plan>(await get('/payments/plans'), 'plans'),
      createPlan: (p: Omit<Plan, 'id'>) => post<Plan>('/payments/plans', p),
      invoices: async () => asList<Invoice>(await get('/payments/invoices'), 'invoices'),
      paid: async () => asList<PaidPubkey>(await get('/payments/paid'), 'paid'),
      /** GET is an extension; PUT is in the contract. */
      nwc: () => get<NwcStatus>('/payments/nwc'),
      setNwc: (body: { uri?: string | null; lnurl?: string }) =>
        put<NwcStatus>('/payments/nwc', body),
    },
    admins: {
      list: async () => asList<Admin>(await get('/admins'), 'admins'),
      add: (a: NewAdmin) => post<Admin & { totpUri?: string }>('/admins', a),
      remove: (id: string) => del(`/admins/${enc(id)}`),
      /** Extension: clear TOTP so the admin re-enrolls at next password login. */
      resetTotp: (id: string) => post<{ totpUri?: string }>(`/admins/${enc(id)}/reset-totp`),
      sessions: async () => asList<Session>(await get('/sessions'), 'sessions'),
      revokeSession: (id: string) => del(`/sessions/${enc(id)}`),
      audit: async (q: { limit?: number; before?: number; actor?: string } = {}) =>
        asList<AuditEntry>(await get('/audit', q), 'entries'),
    },
    settings: {
      get: () => get<Settings>('/settings'),
      put: (s: Settings) => put<Settings>('/settings', s),
    },
    backups: {
      list: async () => asList<Backup>(await get('/backups'), 'backups'),
      run: () => post<Backup>('/backups'),
    },
  }
}

export type AdminApi = ReturnType<typeof createApi>
