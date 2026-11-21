import { Fragment, type ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import type { ShellApp, ShellArea } from './types.js';
import styles from './Rail.module.css';

export interface RailProps {
  /** หมุดที่มีผล (≤15) ตามลำดับ — จาก Navigation API */
  pinnedApps: readonly ShellApp[];
  currentAppId?: string;
  onNavigate?: (href: string) => boolean;
  /** #651: พื้นที่งาน — ส่งแล้ว rail แสดงพื้นที่แทนหมุด (ว่าง/ไม่ส่ง = หมุดแอปแบบเดิม) */
  areas?: readonly ShellArea[];
  /** พื้นที่ที่กำลังใช้อยู่ (ไม่ส่ง = ไม่มีพื้นที่ใดถูกเลือก เช่นหน้าบัญชี) */
  currentAreaId?: string;
  /** ปุ่มเปิด launcher (`<AppLauncher>`) — อยู่กับที่ด้านบน */
  launcher: ReactNode;
  /** ปุ่มตั้งค่า/อื่น ๆ — อยู่กับที่ด้านล่าง */
  footer?: ReactNode;
}

/**
 * แถบซ้ายสีแบรนด์: launcher ด้านบน, หมุดเลื่อนได้ตรงกลาง, footer ด้านล่าง
 * เส้นแบ่งเมื่อหมุดติดกันอยู่คนละกลุ่ม; ลิงก์ของอีก host app เปิดแท็บใหม่
 */
export function Rail({
  pinnedApps,
  currentAppId,
  onNavigate,
  areas,
  currentAreaId,
  launcher,
  footer,
}: RailProps) {
  const t = useUiText();
  const items = areas && areas.length > 0 ? areas : null;
  const select = (event: React.MouseEvent<HTMLAnchorElement>, href: string, external: boolean) => {
    if (
      external ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (onNavigate?.(href)) event.preventDefault();
  };
  return (
    <nav
      className={styles.rail}
      aria-label={t('shell.mainNav')}
      data-areas={items ? 'true' : undefined}
    >
      <div className={styles.fixed}>{launcher}</div>
      <div className={styles.divider} aria-hidden="true" />
      <ul className={styles.pins}>
        {items
          ? items.map((area) => (
              <li key={area.id}>
                <a
                  className={`${styles.item} ${styles.area}`}
                  href={area.href}
                  onClick={(event) => select(event, area.href, area.external)}
                  title={area.label}
                  aria-current={area.id === currentAreaId ? 'page' : undefined}
                  data-area={area.id}
                  {...(area.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <ShellIcon name={`area-${area.id}`} />
                  <span className={styles.label}>{area.label}</span>
                  {area.external ? (
                    <span className={styles.srOnly}>{t('shell.opensInNewTab')}</span>
                  ) : null}
                </a>
              </li>
            ))
          : null}
        {items
          ? null
          : pinnedApps.map((app, index) => (
              <Fragment key={app.id}>
                {index > 0 && pinnedApps[index - 1]!.groupId !== app.groupId ? (
                  <li className={styles.divider} aria-hidden="true" />
                ) : null}
                <li>
                  <a
                    className={styles.item}
                    href={app.href}
                    onClick={(event) => select(event, app.href, app.external)}
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
