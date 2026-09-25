import type { ReactNode } from 'react';
import { cx } from '../cx.js';
import styles from './Badge.module.css';

/** severity ของ token (tokens.css) — "เรื่องนี้หนักแค่ไหน" */
export type BadgeTone = 'success' | 'attention' | 'critical' | 'info' | 'neutral' | 'accent';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

/** ป้ายข้อความสั้น มุมโค้ง `--dc-radius-sm` */
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], className)}>{children}</span>;
}

/** สถานะของเอเจนต์ (identity ของ token) — สีต้องไม่ใช่ตัวบอกความหมายตัวเดียว จึงมีข้อความเสมอ */
export type AgentStatus = 'available' | 'busy' | 'acw' | 'break' | 'offline' | 'cooldown';

export interface StatusChipProps {
  status: AgentStatus | BadgeTone;
  children: ReactNode;
  className?: string;
}

/** ป้ายทรง pill พร้อมจุดสถานะ — ใช้กับสถานะที่เปลี่ยนตามเวลา */
export function StatusChip({ status, children, className }: StatusChipProps) {
  return <span className={cx(styles.chip, styles[status], className)}>{children}</span>;
}
