/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact'
import { cx } from './util'

export interface Column<T> {
  key: string
  header: ComponentChildren
  /** Cell renderer; defaults to `String(row[key])`. */
  render?: (row: T, index: number) => ComponentChildren
  align?: 'left' | 'right' | 'center'
  width?: string
  mono?: boolean
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: readonly T[]
  rowKey: (row: T, index: number) => string | number
  onRowClick?: (row: T, index: number) => void
  selectedKey?: string | number | null
  /** Rendered in place of the body when there are no rows. */
  empty?: ComponentChildren
  dense?: boolean
  class?: string
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  dense,
  class: className,
}: TableProps<T>) {
  return (
    <div class={cx('bh-table-wrap', className)}>
      <table class={cx('bh-table', dense && 'bh-table--dense')}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ textAlign: c.align ?? 'left', width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td class="bh-table__empty" colSpan={columns.length}>
                {empty ?? 'Nothing here yet'}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const key = rowKey(row, i)
            return (
              <tr
                key={key}
                class={cx(
                  onRowClick && 'bh-table__row--clickable',
                  selectedKey === key && 'bh-table__row--selected',
                )}
                onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                aria-selected={selectedKey === key || undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    class={cx(c.mono && 'bh-mono')}
                    style={{ textAlign: c.align ?? 'left' }}
                  >
                    {c.render
                      ? c.render(row, i)
                      : String((row as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
