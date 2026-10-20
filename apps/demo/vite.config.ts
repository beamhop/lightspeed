import { existsSync } from 'node:fs'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Library entry points that may not exist yet while @beamhop/p2p is being built. When one cannot be
 * resolved to a real file it is replaced by an empty module, so the build succeeds and the demo
 * falls back to its BroadcastChannel implementation at runtime (see src/net/beamhop.ts).
 */
function optionalModules(ids: string[]): Plugin {
  const PREFIX = '\0beamhop-missing:'
  return {
    name: 'beamhop-optional-modules',
    enforce: 'pre',
    async resolveId(id, importer, options) {
      if (!ids.includes(id)) return null
      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true }).catch(
        () => null,
      )
      if (resolved && !resolved.external && existsSync(resolved.id.split('?')[0] ?? '')) {
        return resolved
      }
      this.warn(`${id} not found; the demo will use its local fallback`)
      return PREFIX + id
    },
    load(id) {
      if (id.startsWith(PREFIX)) {
        return `export const __beamhopMissing = ${JSON.stringify(id.slice(PREFIX.length))}`
      }
      return null
    },
  }
}

export default defineConfig({
  base: '/lightspeed/demo/',
  plugins: [optionalModules(['@beamhop/p2p/webrtc', '@beamhop/signaling-nostr']), preact()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
})
