// Gives Markdown tables the markup and classes of shadcn/ui's <Table> (components/ui/table.tsx):
// an overflow container, a muted header row, bordered rows and the same cell padding.
// A Sätteri hast plugin (Astro's default Markdown processor).

const CLASSES = {
  container: 'relative w-full overflow-x-auto rounded-lg border',
  table: 'w-full caption-bottom text-sm',
  thead: 'bg-muted/50 [&_tr]:border-b',
  tbody: '[&_tr:last-child]:border-0',
  tr: 'border-b transition-colors hover:bg-muted/50',
  th: 'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground first:pl-4 last:pr-4 [&[align=center]]:text-center [&[align=right]]:text-right',
  td: 'p-2 align-top first:pl-4 last:pr-4 [&[align=center]]:text-center [&[align=right]]:text-right',
}

const SLOTS = {
  table: 'table',
  thead: 'table-header',
  tbody: 'table-body',
  tr: 'table-row',
  th: 'table-head',
  td: 'table-cell',
}

function decorate(node, ctx) {
  const own = node.properties?.className ?? []
  ctx.setProperty(node, 'className', [
    ...(Array.isArray(own) ? own : [own]),
    ...CLASSES[node.tagName].split(' '),
  ])
  ctx.setProperty(node, 'dataSlot', SLOTS[node.tagName])
}

export const shadcnTable = {
  name: 'beamhop-shadcn-table',
  element: [
    {
      filter: ['table'],
      visit(node, ctx) {
        decorate(node, ctx)
        ctx.wrapNode(node, {
          type: 'element',
          tagName: 'div',
          properties: { className: CLASSES.container.split(' '), dataSlot: 'table-container' },
          children: [],
        })
      },
    },
    { filter: ['thead', 'tbody', 'tr', 'th', 'td'], visit: decorate },
  ],
}
