import type { ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import styles from './AppShell.module.css';

export interface AppShellProps {
  rail: ReactNode;
  /** Console มีแผงเมนูย่อย; Workspace ไม่มี (D1.2) */
  subNav?: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
}

/**
 * โครงร่วมของ Console/Workspace: rail | (SubNav) | แถบบน + เนื้อหา
 * มี skip link ไปที่เนื้อหา เพราะ rail + SubNav มีลิงก์ก่อนถึงเนื้อหาหลายสิบจุด
 */
export function AppShell({ rail, subNav, topBar, children }: AppShellProps) {
  const t = useUiText();
  return (
    <div className={styles.shell} data-has-subnav={subNav ? 'true' : undefined}>
      <a className={styles.skip} href="#dc-main">
        {t('shell.skipToContent')}
      </a>
      {rail}
      {subNav}
      <div className={styles.column}>
        {topBar}
        <main id="dc-main" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
