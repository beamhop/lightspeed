import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AppStore } from './apps'
import type { AdminDb } from './db'
import type { NostrEvent } from './engines'
import type { BanStore } from './policy'
import type { UsageMeter } from './usage'
import { isHex64, randomHex, tagValue, tagValues, verifyEvent } from './util/crypto'

export const BLOSSOM_AUTH_KIND = 24242
const SHA_PATH = /^\/([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/

export interface BlobDescriptor {
  url: string
  sha256: string
  size: number
  type: string
  uploaded: number
}

export interface BlossomOptions {
  dir: string
  maxUploadBytes: number
  allowedMime: string[]
  defaultQuotaBytes: number
  perPubkeyQuotaBytes: number
  requireAuthForList: boolean
  /** Fetch used by PUT /mirror (injectable for tests). */
  fetch?: typeof fetch
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/html': '.html',
}

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'Authorization, Content-Type, Content-Length, X-SHA-256, X-Content-Type, X-Content-Length',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, POST, OPTIONS',
  'access-control-expose-headers': 'X-Reason, Content-Length, Content-Range, Accept-Ranges',
  'access-control-max-age': '86400',
}

function reason(status: number, message: string): Response {
  return new Response(status === 204 || status === 304 ? null : JSON.stringify({ message }), {
    status,
    headers: { ...CORS_HEADERS, 'x-reason': message, 'content-type': 'application/json' },
  })
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  })
}

export function mimeAllowed(type: string, allowed: string[]): boolean {
  if (!allowed.length) return true
  const t = type.split(';')[0]?.trim().toLowerCase() ?? ''
  return allowed.some((a) =>
    a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a.toLowerCase(),
  )
}

interface BlobRow {
  sha256: string
  size: number
  type: string
  created_at: number
}

/** Blossom BUD-01 (get/head), BUD-02 (upload/list/delete), BUD-04 (mirror), BUD-06 (upload preflight). */
export class Blossom {
  uploads = 0

  constructor(
    private adb: AdminDb,
    private apps: AppStore,
    private bans: BanStore,
    private meter: UsageMeter,
    readonly opts: BlossomOptions,
  ) {
    mkdirSync(opts.dir, { recursive: true })
  }

  private path(sha: string) {
    return join(this.opts.dir, sha.slice(0, 2), sha)
  }

  /** Parse and validate `Authorization: Nostr <base64 event>` for a verb. Returns event or error text. */
  auth(req: Request, verb: string, sha?: string): NostrEvent | string {
    const h = req.headers.get('authorization')
    if (!h?.startsWith('Nostr ')) return 'missing Nostr authorization'
    let ev: unknown
    try {
      ev = JSON.parse(atob(h.slice(6).trim()))
    } catch {
      return 'malformed authorization'
    }
    if (!verifyEvent(ev)) return 'invalid auth event signature'
    const now = this.adb.now()
    if (ev.kind !== BLOSSOM_AUTH_KIND) return `auth event must be kind ${BLOSSOM_AUTH_KIND}`
    if (ev.created_at > now + 60) return 'auth event created in the future'
    const exp = Number(tagValue(ev, 'expiration'))
    if (!Number.isFinite(exp) || exp <= now) return 'auth event expired or missing expiration'
    if (tagValue(ev, 't') !== verb) return `auth event t tag must be ${verb}`
    if (sha) {
      const xs = tagValues(ev, 'x')
      if ((verb === 'delete' || xs.length) && !xs.includes(sha))
        return 'auth event x tag does not match blob'
    }
    if (this.bans.pubkeyBanned(ev.pubkey)) return 'pubkey is banned'
    return ev
  }

  /**
   * Handle a Blossom request. `subpath` is the path relative to the scope root ("/upload",
   * "/<sha256>.png"...); scope is '' for the public root or an appId for /a/<appId>/...
   */
  async handle(
    req: Request,
    subpath: string,
    scope: string,
    base: string,
  ): Promise<Response | null> {
    const m = req.method
    if (
      m === 'OPTIONS' &&
      (subpath === '/upload' ||
        subpath === '/mirror' ||
        subpath.startsWith('/list/') ||
        SHA_PATH.test(subpath))
    ) {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (subpath === '/upload') {
      if (m === 'PUT') return this.upload(req, scope, base)
      if (m === 'HEAD') return this.preflight(req, scope)
      return null
    }
    if (subpath === '/mirror' && m === 'PUT') return this.mirror(req, scope, base)
    if (subpath.startsWith('/list/') && m === 'GET')
      return this.listRoute(req, subpath.slice(6), scope, base)
    const sm = SHA_PATH.exec(subpath)
    if (!sm) return null
    const sha = sm[1] as string
    if (m === 'GET' || m === 'HEAD') return this.get(req, sha, m === 'HEAD')
    if (m === 'DELETE') return this.deleteRoute(req, sha, scope)
    return null
  }

  private scopeQuota(scope: string): number {
    if (!scope) return this.opts.defaultQuotaBytes
    return (this.apps.get(scope) ?? this.apps.active(scope))?.blossomQuotaBytes ?? 0
  }

  scopeUsage(scope: string): number {
    const r = this.adb.db
      .query(
        'SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE sha256 IN (SELECT sha256 FROM blob_owners WHERE scope = ?)',
      )
      .get(scope) as { n: number }
    return r.n
  }

  pubkeyUsage(scope: string, pubkey: string): number {
    const r = this.adb.db
      .query(
        'SELECT COALESCE(SUM(b.size), 0) AS n FROM blob_owners o JOIN blobs b ON b.sha256 = o.sha256 WHERE o.scope = ? AND o.pubkey = ?',
      )
      .get(scope, pubkey) as { n: number }
    return r.n
  }

  /** Reason the upload must be refused, or null. */
  private checkLimits(scope: string, pubkey: string, size: number, type: string): string | null {
    const app = scope ? this.apps.active(scope) : null
    if (scope && !app) return 'unknown app'
    const max =
      app && app.blossomMaxBlobBytes > 0
        ? Math.min(app.blossomMaxBlobBytes, this.opts.maxUploadBytes)
        : this.opts.maxUploadBytes
    if (size > max) return `blob exceeds ${max} bytes`
    if (!mimeAllowed(type, this.opts.allowedMime)) return `type ${type} not allowed`
    if (app?.blossomAllowedMime.length && !mimeAllowed(type, app.blossomAllowedMime)) {
      return `type ${type} not allowed`
    }
    const quota = this.scopeQuota(scope)
    if (quota > 0 && this.scopeUsage(scope) + size > quota) return 'storage quota exceeded'
    if (
      this.opts.perPubkeyQuotaBytes > 0 &&
      this.pubkeyUsage(scope, pubkey) + size > this.opts.perPubkeyQuotaBytes
    ) {
      return 'per-pubkey storage quota exceeded'
    }
    return null
  }

  private preflight(req: Request, scope: string): Response {
    const sha = req.headers.get('x-sha-256') ?? undefined
    const auth = this.auth(req, 'upload', sha)
    if (typeof auth === 'string') return reason(401, auth)
    const size = Number(req.headers.get('x-content-length') ?? 0)
    const type = req.headers.get('x-content-type') ?? 'application/octet-stream'
    const bad = this.checkLimits(scope, auth.pubkey, size, type)
    if (bad)
      return reason(
        bad.includes('quota')
          ? 413
          : bad === 'unknown app'
            ? 404
            : bad.startsWith('type')
              ? 415
              : 413,
        bad,
      )
    return new Response(null, { status: 200, headers: CORS_HEADERS })
  }

  private async store(
    bytes: Uint8Array,
    type: string,
    scope: string,
    pubkey: string,
    base: string,
  ): Promise<Response> {
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const existing = this.adb.db
      .query('SELECT * FROM blobs WHERE sha256 = ?')
      .get(sha) as BlobRow | null
    const t = this.adb.now()
    if (!existing) {
      const p = this.path(sha)
      mkdirSync(join(this.opts.dir, sha.slice(0, 2)), { recursive: true })
      const tmp = `${p}.${randomHex(4)}.tmp`
      await Bun.write(tmp, bytes)
      renameSync(tmp, p)
      this.adb.db
        .query('INSERT INTO blobs (sha256, size, type, created_at) VALUES (?, ?, ?, ?)')
        .run(sha, bytes.byteLength, type, t)
    }
    this.adb.db
      .query(
        'INSERT OR IGNORE INTO blob_owners (sha256, scope, pubkey, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(sha, scope, pubkey, t)
    this.uploads++
    this.meter.add(scope || '_public', 'blossom_bytes_uploaded', bytes.byteLength)
    const row = (existing ?? {
      sha256: sha,
      size: bytes.byteLength,
      type,
      created_at: t,
    }) as BlobRow
    return ok(this.descriptor(row, base))
  }

  private async upload(req: Request, scope: string, base: string): Promise<Response> {
    const auth = this.auth(req, 'upload')
    if (typeof auth === 'string') return reason(401, auth)
    const type =
      (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ||
      'application/octet-stream'
    const declared = Number(req.headers.get('content-length') ?? 0)
    const pre = this.checkLimits(scope, auth.pubkey, declared, type)
    if (pre) return reason(pre === 'unknown app' ? 404 : pre.startsWith('type') ? 415 : 413, pre)
    const bytes = new Uint8Array(await req.arrayBuffer())
    const post = this.checkLimits(scope, auth.pubkey, bytes.byteLength, type)
    if (post) return reason(413, post)
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const xs = tagValues(auth, 'x')
    if (xs.length && !xs.includes(sha)) return reason(409, 'blob hash does not match auth x tag')
    return this.store(bytes, type, scope, auth.pubkey, base)
  }

  private async mirror(req: Request, scope: string, base: string): Promise<Response> {
    const auth = this.auth(req, 'upload')
    if (typeof auth === 'string') return reason(401, auth)
    let url: string
    try {
      url = String(((await req.json()) as { url?: unknown }).url ?? '')
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
    } catch {
      return reason(400, 'body must be { url } with an http(s) URL')
    }
    const xs = tagValues(auth, 'x')
    if (!xs.length) return reason(400, 'mirror auth needs an x tag')
    const res = await (this.opts.fetch ?? fetch)(url, { redirect: 'follow' }).catch(() => null)
    if (!res?.ok) return reason(502, 'could not fetch the blob to mirror')
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > this.opts.maxUploadBytes) return reason(413, 'blob too large')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const type =
      (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ||
      'application/octet-stream'
    const bad = this.checkLimits(scope, auth.pubkey, bytes.byteLength, type)
    if (bad) return reason(bad.startsWith('type') ? 415 : 413, bad)
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    if (!xs.includes(sha)) return reason(409, 'mirrored blob hash does not match auth x tag')
    return this.store(bytes, type, scope, auth.pubkey, base)
  }

  private async get(req: Request, sha: string, head: boolean): Promise<Response> {
    const row = this.adb.db.query('SELECT * FROM blobs WHERE sha256 = ?').get(sha) as BlobRow | null
    if (!row) return reason(404, 'blob not found')
    const file = Bun.file(this.path(sha))
    if (!(await file.exists())) return reason(404, 'blob missing on disk')
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'content-type': row.type,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${sha}"`,
    }
    const range = req.headers.get('range')
    const rm = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (rm && (rm[1] || rm[2])) {
      let start = rm[1] ? Number(rm[1]) : row.size - Number(rm[2])
      let end = rm[1] && rm[2] ? Number(rm[2]) : row.size - 1
      start = Math.max(0, start)
      end = Math.min(end, row.size - 1)
      if (start > end)
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${row.size}` },
        })
      headers['content-range'] = `bytes ${start}-${end}/${row.size}`
      headers['content-length'] = String(end - start + 1)
      return new Response(head ? null : file.slice(start, end + 1), { status: 206, headers })
    }
    headers['content-length'] = String(row.size)
    return new Response(head ? null : file, { status: 200, headers })
  }

  private deleteRoute(req: Request, sha: string, scope: string): Response {
    const auth = this.auth(req, 'delete', sha)
    if (typeof auth === 'string') return reason(401, auth)
    const r = this.adb.db
      .query('DELETE FROM blob_owners WHERE sha256 = ? AND scope = ? AND pubkey = ?')
      .run(sha, scope, auth.pubkey)
    if (!r.changes) return reason(404, 'blob not found for this pubkey')
    this.gc(sha)
    return ok({ deleted: sha })
  }

  /** Remove the blob file and row when nobody owns it anymore. */
  private gc(sha: string) {
    const left = this.adb.db
      .query('SELECT COUNT(*) AS n FROM blob_owners WHERE sha256 = ?')
      .get(sha) as { n: number }
    if (left.n > 0) return
    this.adb.db.query('DELETE FROM blobs WHERE sha256 = ?').run(sha)
    rmSync(this.path(sha), { force: true })
  }

  private listRoute(req: Request, pubkey: string, scope: string, base: string): Response {
    if (!isHex64(pubkey)) return reason(400, 'pubkey must be 64 hex chars')
    if (this.opts.requireAuthForList) {
      const auth = this.auth(req, 'list')
      if (typeof auth === 'string') return reason(401, auth)
    }
    const u = new URL(req.url)
    const since = Number(u.searchParams.get('since') ?? 0)
    const until = Number(u.searchParams.get('until') ?? 2 ** 40)
    const rows = this.adb.db
      .query(
        `SELECT b.*, o.created_at AS owned_at FROM blob_owners o JOIN blobs b ON b.sha256 = o.sha256
         WHERE o.scope = ? AND o.pubkey = ? AND o.created_at >= ? AND o.created_at <= ? ORDER BY o.created_at DESC`,
      )
      .all(scope, pubkey, since, until) as (BlobRow & { owned_at: number })[]
    return ok(rows.map((r) => this.descriptor({ ...r, created_at: r.owned_at }, base)))
  }

  descriptor(r: BlobRow, base: string): BlobDescriptor {
    return {
      url: `${base}/${r.sha256}${EXT[r.type] ?? ''}`,
      sha256: r.sha256,
      size: r.size,
      type: r.type,
      uploaded: r.created_at,
    }
  }

  // ------------------------------------------------------------ admin

  adminList(opts: { scope?: string; pubkey?: string; limit?: number } = {}) {
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.scope !== undefined) {
      where.push('o.scope = ?')
      args.push(opts.scope)
    }
    if (opts.pubkey) {
      where.push('o.pubkey = ?')
      args.push(opts.pubkey)
    }
    args.push(Math.min(opts.limit ?? 200, 1000))
    return this.adb.db
      .query(
        `SELECT b.sha256, b.size, b.type, b.created_at AS uploaded, o.scope AS app, o.pubkey FROM blob_owners o
         JOIN blobs b ON b.sha256 = o.sha256 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY o.created_at DESC LIMIT ?`,
      )
      .all(...args) as {
      sha256: string
      size: number
      type: string
      uploaded: number
      app: string
      pubkey: string
    }[]
  }

  adminDelete(sha: string): boolean {
    const r = this.adb.db.query('DELETE FROM blob_owners WHERE sha256 = ?').run(sha)
    const b = this.adb.db.query('DELETE FROM blobs WHERE sha256 = ?').run(sha)
    rmSync(this.path(sha), { force: true })
    return r.changes > 0 || b.changes > 0
  }

  stats() {
    const r = this.adb.db
      .query('SELECT COUNT(*) AS blobs, COALESCE(SUM(size), 0) AS bytes FROM blobs')
      .get() as {
      blobs: number
      bytes: number
    }
    return { ...r, uploads: this.uploads }
  }
}
