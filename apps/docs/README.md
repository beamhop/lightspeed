# Beamhop docs (`apps/docs`)

Astro Starlight site published at `https://beamhop.github.io/lightspeed/` (base `/lightspeed/`), with
the demo deployed next to it at `/lightspeed/demo/` by `.github/workflows/pages.yml`.

```sh
bun run --cwd apps/docs dev      # http://localhost:4321/lightspeed/
bun run --cwd apps/docs build    # dist/
bun run --cwd apps/docs test     # spec/test-vector and generator tests
```

Astro runs under the Bun runtime (`bun --bun`) because `starlight-typedoc` ships TypeScript sources.

## UI

Styled with Tailwind v4 and shadcn/ui (`components.json`, components in `src/components/ui/`). The
tokens live in `src/styles/theme.css` (light and dark, keyed on Starlight's `data-theme`):

- Landing page: `src/pages/index.astro` with `src/layouts/Landing.astro` and `src/styles/landing.css`.
  shadcn React components render to static HTML; in `.astro` files style links with `buttonVariants()`
  rather than `<Button asChild>`, which cannot reach into Astro-rendered children.
- Docs pages: Starlight, restyled by `src/styles/starlight.css` (customCss) and the `Header` /
  `ThemeSelect` overrides in `src/components/starlight/`.

## Content

`src/content/docs/`:

| Section | Path |
|---|---|
| Get started | `get-started/` |
| Concepts | `concepts/` (identity, signaling, transports, topologies, channels, state, telemetry) |
| Guides | `guides/` (React, Bun server peer, OIDC, file transfer, calls, Studio, Trystero) |
| Relay operator manual | `relay/` |
| API reference | `api/index.md` + generated `api/reference/` |
| Troubleshooting | `troubleshooting.md` |

## Generated pages (git-ignored)

- `protocol.md` from `docs/PROTOCOL.md` and `changelog.md` from `packages/*/CHANGELOG.md`, written by
  `scripts/sync.ts` before every `dev` and `build`. Edit the sources, not the generated files.
- `api/reference/` from TSDoc via starlight-typedoc (`api.config.mjs`). Only packages whose entry file
  already exports something are included. `DOCS_TYPEDOC=0` skips generation;
  `bun run --cwd apps/docs api` runs TypeDoc standalone (`scripts/typedoc.ts`).

`scripts/vectors.ts` computes the test vectors quoted in `docs/PROTOCOL.md` from
`@beamhop/p2p/wire`; `scripts/docs.test.ts` fails if the spec and the code drift apart.

Every API page carries a "0.x, subject to change" note until 1.0. MIT licensed.
