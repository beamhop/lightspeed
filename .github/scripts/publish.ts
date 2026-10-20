// Publishes every public workspace package whose current version is not on npm yet.
// Used as the `publish` command of changesets/action in release.yml.
//
// `bun pm pack` resolves `workspace:*` ranges to real versions (npm publish would not), then
// `npm publish <tarball> --provenance` uploads it with a signed provenance statement from GitHub
// Actions OIDC. Prints "New tag:" lines so changesets/action creates GitHub releases.
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'

interface Pkg {
  name: string
  version: string
  private?: boolean
  scripts?: Record<string, string>
}

const root = join(import.meta.dir, '../..')
const outDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'beamhop-release')
const dryRun = process.argv.includes('--dry-run')

export function publicPackages(dir = join(root, 'packages')): { dir: string; pkg: Pkg }[] {
  return readdirSync(dir)
    .sort()
    .map((d) => ({ dir: join(dir, d), file: join(dir, d, 'package.json') }))
    .flatMap(({ dir: pkgDir, file }) => {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as Pkg
        return pkg.private ? [] : [{ dir: pkgDir, pkg }]
      } catch {
        return []
      }
    })
}

async function isPublished(name: string, version: string): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`)
  return res.ok
}

if (import.meta.main) {
  await $`mkdir -p ${outDir}`
  let published = 0
  for (const { dir, pkg } of publicPackages()) {
    if (await isPublished(pkg.name, pkg.version)) {
      console.log(`skip ${pkg.name}@${pkg.version} (already on npm)`)
      continue
    }
    if (pkg.scripts?.build) await $`bun run build`.cwd(dir)
    const tarball = (await $`bun pm pack --quiet --destination ${outDir}`.cwd(dir).text()).trim()
    const file = tarball.startsWith('/') ? tarball : join(outDir, tarball.split('/').pop() ?? '')
    const tag = pkg.version.includes('-') ? 'next' : 'latest'
    if (dryRun) {
      console.log(`would publish ${file} with tag ${tag}`)
      continue
    }
    await $`npm publish ${file} --access public --provenance --tag ${tag}`
    console.log(`New tag: ${pkg.name}@${pkg.version}`)
    published++
  }
  if (published > 0 && !dryRun) await $`bunx @changesets/cli tag`.cwd(root)
  console.log(`published ${published} package(s)`)
}
