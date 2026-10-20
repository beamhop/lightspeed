// API reference via starlight-typedoc. Generated pages land in src/content/docs/api/reference/ at
// build time (git-ignored). Set DOCS_TYPEDOC=0 to skip generation (the hand-written api/index.md page
// stays), or run `bun run api` for a standalone TypeDoc run (scripts/typedoc.ts).
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** Library packages whose public API is documented, in sidebar order. */
export const apiPackages = ['p2p', 'signaling-nostr', 'react']

/** True when the entry file exports something (packages still being scaffolded only `export {}`). */
function hasExports(file) {
  if (!existsSync(file)) return false
  const src = readFileSync(file, 'utf8')
  return /export\s+(\*|\{\s*\w|const|let|function|async|class|interface|type|enum|default|abstract)/.test(
    src,
  )
}

// Entry files of packages that already export something.
const entryPoints = apiPackages.map((p) => `${root}packages/${p}/src/index.ts`).filter(hasExports)

const overview = { label: 'Overview', slug: 'api' }

let plugins = []
let apiSidebar = { label: 'API reference', items: [overview] }

if (process.env.DOCS_TYPEDOC !== '0' && entryPoints.length > 0) {
  try {
    const { createStarlightTypeDocPlugin } = await import('starlight-typedoc')
    const [plugin, group] = createStarlightTypeDocPlugin()
    plugins = [
      plugin({
        entryPoints,
        output: 'api/reference',
        tsconfig: fileURLToPath(new URL('./tsconfig.api.json', import.meta.url)),
        errorOnEmptyDocumentation: false,
        sidebar: { label: 'Reference', collapsed: true },
        typeDoc: {
          skipErrorChecking: true,
          excludePrivate: true,
          excludeInternal: true,
          entryPointStrategy: 'resolve',
          gitRevision: 'main',
        },
      }),
    ]
    apiSidebar = { label: 'API reference', items: [overview, group] }
  } catch (err) {
    console.warn(`[docs] starlight-typedoc unavailable, using placeholder API page: ${err}`)
  }
}

export const typedocPlugins = plugins
export { apiSidebar }
