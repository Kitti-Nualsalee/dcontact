import type { ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import styles from './TopBar.module.css';

export interface TopBarProps {
  /** โลโก้/ชื่อแอป */
  brand: ReactNode;
  /** ตำแหน่งปัจจุบัน เช่น ["ระบบอัตโนมัติ", "Journeys"] — ตัวสุดท้ายคือหน้านี้ */
  breadcrumb: readonly string[];
  /** ส่วนขวา: สลับภาษา, สถานะพร้อมรับงาน (Workspace), โปรไฟล์ */
  children?: ReactNode;
}

/** แถบบนสูง `--dc-bar-top` (44px) */
export function TopBar({ brand, breadcrumb, children }: TopBarProps) {
  const t = useUiText();
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>{brand}</div>
      <nav aria-label={t('shell.breadcrumb')}>
        <ol className={styles.crumbs}>
          {breadcrumb.map((part, index) => (
            <li
              key={`${index}-${part}`}
              className={styles.crumb}
              aria-current={index === breadcrumb.length - 1 ? 'page' : undefined}
            >
              {part}
            </li>
          ))}
        </ol>
      </nav>
      <div className={styles.spacer} />
      <div className={styles.actions}>{children}</div>
    </header>
  );
}

export interface LanguageSwitchProps {
  value: 'th' | 'en';
  onChange: (value: 'th' | 'en') => void;
}

/** สลับ TH/EN ทันทีโดยไม่ reload (D1.5) — ชื่อภาษาแสดงเป็นภาษาของตัวเองเสมอ */
export function LanguageSwitch({ value, onChange }: LanguageSwitchProps) {
  const t = useUiText();
  const options = [
    { id: 'th', short: 'TH', name: 'ไทย', lang: 'th' },
    { id: 'en', short: 'EN', name: 'English', lang: 'en' },
  ] as const;
  return (
    <div role="group" aria-label={t('shell.language')} className={styles.language}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          lang={option.lang}
          aria-label={option.name}
          aria-pressed={value === option.id}
          className={styles.languageButton}
          onClick={() => onChange(option.id)}
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}
