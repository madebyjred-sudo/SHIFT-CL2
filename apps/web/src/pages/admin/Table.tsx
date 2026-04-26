/**
 * Lightweight admin table — wraps a real <table> so we keep semantics
 * for screen readers and copy-paste, but with the design system styling
 * baked in (uppercase headers, hairline rows, hover, monospace numbers).
 *
 * Sort + pagination intentionally NOT in here — every section that
 * needs them adds its own. Keeps this file tiny.
 */
import { type ReactNode } from 'react';

interface ColumnDef<T> {
  /** Header label. */
  header: ReactNode;
  /** Renderer for one row. */
  cell: (row: T) => ReactNode;
  /** Right-align? defaults to false. */
  align?: 'left' | 'right';
  /** Width hint as a CSS length string (e.g. '120px'). Optional. */
  width?: string;
  /** Custom CSS class on <td>. */
  cellClassName?: string;
}

interface TableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T, idx: number) => string;
  /** Optional row-level click. Wires the row as <tr role="button"> if set. */
  onRowClick?: (row: T) => void;
  /** Empty-state slot when `rows.length === 0`. */
  empty?: ReactNode;
}

export function AdminTable<T>(props: TableProps<T>): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] shadow-[0_2px_10px_rgba(14,23,69,0.04)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.20)]">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {props.columns.map((col, i) => (
              <th
                key={i}
                className={`border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.015] dark:bg-white/[0.02] px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/45 dark:text-white/45 ${
                  col.align === 'right' ? 'text-right' : ''
                }`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td colSpan={props.columns.length} className="px-4 py-8">
                {props.empty ?? (
                  <div className="text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                    Sin datos para mostrar.
                  </div>
                )}
              </td>
            </tr>
          ) : (
            props.rows.map((row, idx) => (
              <tr
                key={props.rowKey(row, idx)}
                className={`text-[#0e1745] dark:text-white/90 transition-colors hover:bg-[#0e1745]/[0.02] dark:hover:bg-white/[0.04] ${
                  props.onRowClick ? 'cursor-pointer' : ''
                }`}
                onClick={props.onRowClick ? () => props.onRowClick!(row) : undefined}
              >
                {props.columns.map((col, ci) => (
                  <td
                    key={ci}
                    className={`border-b border-[#0e1745]/[0.05] dark:border-white/[0.05] px-3.5 py-3 align-middle last:border-r-0 ${
                      col.align === 'right' ? 'text-right' : ''
                    } ${col.cellClassName ?? ''}`.trim()}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
