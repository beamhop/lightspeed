import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locate the @beamhop/relay-admin build: explicit dir, else packages/relay-admin/dist next to this package. */
export function resolveAdminDist(configured: string): string | null {
  const candidates = configured
    ? [resolve(configured)]
    : [fileURLToPath(new URL('../../relay-admin/dist', import.meta.url)), resolve('admin')]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  return null
}

/**
 * `distDir` exported by `@beamhop/relay-admin`, when the package is installed and built. The
 * specifier is computed so neither tsc nor `bun build --compile` pull the SPA sources in.
 */
export async function adminDistFromPackage(): Promise<string | null> {
  const spec = ['@beamhop', 'relay-admin'].join('/')
  try {
    const mod = (await import(spec)) as { distDir?: unknown }
    const dir = typeof mod.distDir === 'string' ? mod.distDir : null
    return dir && existsSync(join(dir, 'index.html')) ? dir : null
  } catch {
    return null
  }
}

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beamhop relay admin</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0E1A;color:#E6E8F2;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:520px}h1{color:#5EEAD4;font-size:1.4rem}code{color:#8B7BFF}</style></head>
<body><main><h1>Beamhop relay admin</h1>
<p>The admin UI build was not found. Build it with <code>bun run --filter @beamhop/relay-admin build</code>
or set <code>admin.dist_dir</code> in <code>beamhop-relay.toml</code>.</p>
<p>The admin API is available at <code>/api/admin</code>.</p></main></body></html>`

/** Serve `/admin/*` from the SPA build with index.html fallback, or a placeholder page. */
export async function serveAdmin(dist: string | null, pathname: string): Promise<Response> {
  const security = {
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
  if (!dist) {
    return new Response(PLACEHOLDER, {
      headers: { ...security, 'content-type': 'text/html; charset=utf-8' },
    })
  }
  const rel = decodeURIComponent(pathname.replace(/^\/admin\/?/, ''))
  const target = normalize(join(dist, rel))
  if (
    rel &&
    (target === dist || target.startsWith(dist + sep)) &&
    existsSync(target) &&
    statSync(target).isFile()
  ) {
    const immutable = /\/assets\//.test(target)
    return new Response(Bun.file(target), {
      headers: {
        ...security,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  }
  return new Response(Bun.file(join(dist, 'index.html')), {
    headers: {
      ...security,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}
