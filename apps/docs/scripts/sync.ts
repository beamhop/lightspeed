// Generates docs pages that have a single source of truth elsewhere in the repo:
//   docs/PROTOCOL.md            -> src/content/docs/protocol.md
//   packages/*/CHANGELOG.md     -> src/content/docs/changelog.md (written by Changesets)
// Run automatically by `bun run dev` and `bun run build`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../..')
const docsDir = join(import.meta.dir, '../src/content/docs')

const GENERATED = (source: string) =>
  `<!-- Generated from ${source} by apps/docs/scripts/sync.ts. Edit the source, not this file. -->`

/** Turns docs/PROTOCOL.md into a Starlight page: title from the H1, body unchanged. */
export function protocolPage(markdown: string): string {
  const lines = markdown.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  const title = h1 >= 0 ? (lines[h1] as string).slice(2).trim() : 'Protocol spec'
  const body = h1 >= 0 ? lines.slice(h1 + 1).join('\n') : markdown
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'description: Normative wire format for Beamhop rooms, signaling, data frames, the data relay and TURN credentials.',
    'tableOfContents: { maxHeadingLevel: 3 }',
    '---',
    '',
    GENERATED('docs/PROTOCOL.md'),
    body.trimStart(),
  ].join('\n')
}

/** Collects package changelogs (newest package releases first within each package). */
export function changelogPage(entries: { name: string; markdown: string }[]): string {
  const head = [
    '---',
    'title: Changelog',
    'description: Release notes for every published Beamhop package, generated from Changesets.',
    '---',
    '',
    GENERATED('packages/*/CHANGELOG.md'),
    '',
    'All packages are **0.x**: minor versions may contain breaking changes until 1.0. Releases are',
    'cut with [Changesets](https://github.com/changesets/changesets); relay binaries and the Docker',
    'image are tagged `relay-v*`.',
    '',
  ]
  if (entries.length === 0) {
    return [...head, 'No releases yet. The first 0.x releases will appear here.', ''].join('\n')
  }
  const sections = entries.map(({ name, markdown }) => {
    // Demote headings so each package's "# name" becomes "## name" and versions become "###".
    const body = markdown
      .split('\n')
      .filter((l, i) => !(i === 0 && l.startsWith('# ')))
      .map((l) => (l.startsWith('#') ? `#${l}` : l))
      .join('\n')
      .trim()
    return `## \`${name}\`\n\n${body}\n`
  })
  return [...head, ...sections].join('\n')
}

function readChangelogs(): { name: string; markdown: string }[] {
  const pkgs = join(root, 'packages')
  if (!existsSync(pkgs)) return []
  return readdirSync(pkgs)
    .sort()
    .flatMap((dir) => {
      const file = join(pkgs, dir, 'CHANGELOG.md')
      const pkgJson = join(pkgs, dir, 'package.json')
      if (!existsSync(file) || !existsSync(pkgJson)) return []
      const name = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { name: string }).name
      return [{ name, markdown: readFileSync(file, 'utf8') }]
    })
}

if (import.meta.main) {
  const protocol = readFileSync(join(root, 'docs/PROTOCOL.md'), 'utf8')
  writeFileSync(join(docsDir, 'protocol.md'), protocolPage(protocol))
  writeFileSync(join(docsDir, 'changelog.md'), changelogPage(readChangelogs()))
  console.log('[docs] synced protocol.md and changelog.md')
}
