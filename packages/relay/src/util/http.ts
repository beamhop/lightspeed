/** Error with an HTTP status and a stable machine code; rendered as `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { ...init, headers })
}

export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status })
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message)
  return errorResponse(500, 'internal', 'internal server error')
}

export async function readJson<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 1 << 20,
): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > maxBytes) throw new HttpError(413, 'too-large', 'request body too large')
  const text = await req.text()
  if (text.length > maxBytes) throw new HttpError(413, 'too-large', 'request body too large')
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Simple fixed-window rate limiter keyed by string (IP, pubkey...). */
export class RateLimiter {
  private buckets = new Map<string, { n: number; reset: number }>()
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns true when the request is allowed. limit <= 0 disables limiting. */
  hit(key: string, cost = 1): boolean {
    if (this.limit <= 0) return true
    const t = this.now()
    let b = this.buckets.get(key)
    if (!b || b.reset <= t) {
      b = { n: 0, reset: t + this.windowMs }
      this.buckets.set(key, b)
      if (this.buckets.size > 50_000) this.sweep(t)
    }
    b.n += cost
    return b.n <= this.limit
  }

  private sweep(t: number) {
    for (const [k, b] of this.buckets) if (b.reset <= t) this.buckets.delete(k)
  }
}
