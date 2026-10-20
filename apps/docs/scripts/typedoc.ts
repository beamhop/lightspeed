// Standalone API reference generation, without starting Astro. The docs build normally does this
// through starlight-typedoc (api.config.mjs); this script is for inspecting the output or for CI
// jobs that only need the Markdown. Output: src/content/docs/api/reference/ (git-ignored).
import { join } from 'node:path'
import { Application } from 'typedoc'

const docs = join(import.meta.dir, '..')
const root = join(docs, '../..')
const packages = ['p2p', 'signaling-nostr', 'react']

const app = await Application.bootstrapWithPlugins({
  entryPoints: packages.map((p) => join(root, 'packages', p, 'src/index.ts')),
  entryPointStrategy: 'resolve',
  tsconfig: join(docs, 'tsconfig.api.json'),
  plugin: ['typedoc-plugin-markdown'],
  out: join(docs, 'src/content/docs/api/reference'),
  skipErrorChecking: true,
  excludePrivate: true,
  excludeInternal: true,
  readme: 'none',
})

const project = await app.convert()
if (!project) {
  console.error('[typedoc] conversion failed')
  process.exit(1)
}
await app.generateOutputs(project)
console.log('[typedoc] wrote', app.options.getValue('out'))
