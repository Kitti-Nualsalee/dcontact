import { Fragment, type ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import type { ShellApp } from './types.js';
import styles from './Rail.module.css';

export interface RailProps {
  /** หมุดที่มีผล (≤15) ตามลำดับ — จาก Navigation API */
  pinnedApps: readonly ShellApp[];
  currentAppId?: string;
  /** ปุ่มเปิด launcher (`<AppLauncher>`) — อยู่กับที่ด้านบน */
  launcher: ReactNode;
  /** ปุ่มตั้งค่า/อื่น ๆ — อยู่กับที่ด้านล่าง */
  footer?: ReactNode;
}

/**
 * แถบซ้ายสีแบรนด์: launcher ด้านบน, หมุดเลื่อนได้ตรงกลาง, footer ด้านล่าง
 * เส้นแบ่งเมื่อหมุดติดกันอยู่คนละกลุ่ม; ลิงก์ของอีก host app เปิดแท็บใหม่
 */
export function Rail({ pinnedApps, currentAppId, launcher, footer }: RailProps) {
  const t = useUiText();
  return (
    <nav className={styles.rail} aria-label={t('shell.mainNav')}>
      <div className={styles.fixed}>{launcher}</div>
      <div className={styles.divider} aria-hidden="true" />
      <ul className={styles.pins}>
        {pinnedApps.map((app, index) => (
          <Fragment key={app.id}>
            {index > 0 && pinnedApps[index - 1]!.groupId !== app.groupId ? (
              <li className={styles.divider} aria-hidden="true" />
            ) : null}
            <li>
              <a
                className={styles.item}
                href={app.href}
                aria-current={app.id === currentAppId ? 'page' : undefined}
                {...(app.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                <ShellIcon name={app.id} />
                <span className={styles.label}>{app.label}</span>
                {app.external ? (
                  <span className={styles.srOnly}>{t('shell.opensInNewTab')}</span>
                ) : null}
              </a>
            </li>
          </Fragment>
        ))}
      </ul>
      {footer ? <div className={styles.fixed}>{footer}</div> : null}
    </nav>
  );
}

/** ปุ่ม/ลิงก์ของ rail ที่ไม่ใช่หมุด (เช่น ตั้งค่า) — ใช้ใน `footer` */
export function RailLink({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <a className={styles.item} href={href}>
      <ShellIcon name={icon} />
      <span className={styles.label}>{label}</span>
    </a>
  );
}

export const railStyles = styles;
