import {
  Cell as AriaCell,
  Column as AriaColumn,
  Row as AriaRow,
  Table as AriaTable,
  TableBody as AriaTableBody,
  TableHeader as AriaTableHeader,
  type CellProps,
  type ColumnProps,
  type RowProps,
  type TableBodyProps,
  type TableHeaderProps,
  type TableProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import { useUiText } from '../i18n.js';
import styles from './Table.module.css';

type WithClass<P> = Omit<P, 'className'> & { className?: string };

/** แถวสูง ≈ `--dc-row-table` (36px) — ต้องมี `aria-label` หรือ `aria-labelledby` */
export function Table({ className, ...props }: WithClass<TableProps>) {
  return <AriaTable {...props} className={cx(styles.table, className)} />;
}

export function TableHeader<T extends object>({
  className,
  ...props
}: WithClass<TableHeaderProps<T>>) {
  return <AriaTableHeader {...props} className={cx(styles.header, className)} />;
}

export function Column({ className, ...props }: WithClass<ColumnProps>) {
  return <AriaColumn {...props} className={cx(styles.column, className)} />;
}

export function TableBody<T extends object>({ className, ...props }: WithClass<TableBodyProps<T>>) {
  const t = useUiText();
  return (
    <AriaTableBody
      renderEmptyState={() => <div className={styles.empty}>{t('table.empty')}</div>}
      {...props}
      className={cx(styles.body, className)}
    />
  );
}

export function Row<T extends object>({ className, ...props }: WithClass<RowProps<T>>) {
  return <AriaRow {...props} className={cx(styles.row, className)} />;
}

export function Cell({ className, ...props }: WithClass<CellProps>) {
  return <AriaCell {...props} className={cx(styles.cell, className)} />;
}
