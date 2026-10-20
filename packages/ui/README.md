# @beamhop/ui

Beamhop design tokens and the shared Preact components used by the relay admin panel, Studio and
the demo, so the tools look like one product. MIT.

```ts
import '@beamhop/ui/tokens.css'      // --bh-* custom properties
import '@beamhop/ui/components.css'  // component styles (plain CSS, only uses --bh-* variables)
import { Button, Card, PathBadge, Mascot, toast, ToastHost } from '@beamhop/ui'
```

Wrap your app in an element with class `bh-root` to get the base font, colours and box-sizing.

## Tokens

`tokens.ts` / `tokens.css`: `colors` (midnight, surface, surfaceRaised, border, text, textMuted, teal,
violet, success, warning, danger), `pathColors` (direct = teal, turn = violet, relay = amber),
`radii`, `fonts`, and the `MascotState` type.

## Components

| Component | Notes |
|---|---|
| `Button` | `variant`: primary · secondary · ghost · danger; `size`: sm · md; `loading` |
| `IconButton` | Square button; `label` is required (aria-label + title) |
| `Card` | `title`, `actions`, `flush` (no body padding for tables/graphs) |
| `Badge` | `tone`: neutral · teal · violet · success · warning · danger; `dot` |
| `PathBadge` | `path`: direct · turn · relay · memory, coloured per `pathColors` |
| `Table<T>` | `columns` with `render`, `align`, `mono`; `rowKey`, `onRowClick`, `selectedKey`, `empty`, `dense` |
| `Tabs` | Controlled; roving keyboard focus (←/→/Home/End), optional `count` per tab |
| `Dialog` / `Confirm` | Modal; Escape and backdrop close; `Confirm` has a `danger` style |
| `Toast` | `createToaster()` store or the shared `toaster` / `toast()`, rendered by `<ToastHost />` |
| `Input` / `Select` / `Toggle` | Labelled fields with `hint` / `error`; `Toggle` is a `role="switch"` |
| `Stat` | KPI tile with unit, delta and optional sparkline `trend` |
| `Sparkline` | SVG line/area; `sparklinePoints()` is exported for custom charts |
| `EmptyState` | Title, description, action and a mascot mood |
| `Mascot` | The Beamhop bunny, `state`: idle · spinner · smile · angry · secret |

Mascot moods: **idle** for empty states, **spinner** (orbiting ring) for loading, **smile** for
success, **angry** for errors, **secret** (paw over the mouth) for private / encrypted content.
The SVG renders standalone (token hex values as attributes) and picks up the CSS variables when
`components.css` is loaded. Animations respect `prefers-reduced-motion`.

Helpers: `cx()`, `formatBytes()`, `shortKey()`.

## Development

```sh
bun test packages/ui          # preact-render-to-string + happy-dom tests
bunx tsc --noEmit -p packages/ui
```

Source is consumed directly as TypeScript inside the workspace. `.tsx` files carry a
`/** @jsxImportSource preact */` pragma so they compile the same way from any tsconfig.
