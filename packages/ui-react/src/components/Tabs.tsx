import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import styles from './Tabs.module.css';

type WithClass<P> = Omit<P, 'className'> & { className?: string };

/** ลูกศรซ้าย/ขวาเลื่อนแท็บ (React Aria) — แท็บสูง `--dc-control-sm` */
export function Tabs({ className, ...props }: WithClass<TabsProps>) {
  return <AriaTabs {...props} className={cx(styles.tabs, className)} />;
}

export function TabList<T extends object>({ className, ...props }: WithClass<TabListProps<T>>) {
  return <AriaTabList {...props} className={cx(styles.list, className)} />;
}

export function Tab({ className, ...props }: WithClass<TabProps>) {
  return <AriaTab {...props} className={cx(styles.tab, className)} />;
}

export function TabPanel({ className, ...props }: WithClass<TabPanelProps>) {
  return <AriaTabPanel {...props} className={cx(styles.panel, className)} />;
}
