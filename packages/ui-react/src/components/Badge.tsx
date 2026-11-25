import type { ReactNode } from 'react';
import { cx } from '../cx.js';
import styles from './Badge.module.css';

/** severity of the token (tokens.css) — "how serious is this" */
export type BadgeTone = 'success' | 'attention' | 'critical' | 'info' | 'neutral' | 'accent';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

/** short text badge, corner radius `--dc-radius-sm` */
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], className)}>{children}</span>;
}

/** agent status (token identity) — color must not be the only carrier of meaning, so there is always text */
export type AgentStatus = 'available' | 'busy' | 'acw' | 'break' | 'offline' | 'cooldown';

export interface StatusChipProps {
  status: AgentStatus | BadgeTone;
  children: ReactNode;
  className?: string;
}

/** pill-shaped badge with a status dot — for statuses that change over time */
export function StatusChip({ status, children, className }: StatusChipProps) {
  return <span className={cx(styles.chip, styles[status], className)}>{children}</span>;
}
