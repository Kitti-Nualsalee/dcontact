import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import type { ShellApp } from './types.js';
import styles from './TopBar.module.css';

export interface TopBarProps {
  /** โลโก้/ชื่อแอป */
  brand: ReactNode;
  /** ตำแหน่งปัจจุบัน เช่น ["ระบบอัตโนมัติ", "Journeys"] — ตัวสุดท้ายคือหน้านี้ */
  breadcrumb: readonly string[];
  /** ส่วนขวา: สลับภาษา, สถานะพร้อมรับงาน (Workspace), โปรไฟล์ */
  children?: ReactNode;
}

export interface BreadcrumbProps {
  items: readonly string[];
  placement?: 'topbar' | 'content';
}

/** ตำแหน่งปัจจุบันใช้ร่วมกันได้ทั้งแถบบนและเหนือเนื้อหา */
export function Breadcrumb({ items, placement = 'topbar' }: BreadcrumbProps) {
  const t = useUiText();
  if (!items.length) return null;
  return (
    <nav
      aria-label={t('shell.breadcrumb')}
      className={placement === 'content' ? styles.contentBreadcrumb : undefined}
    >
      <ol className={styles.crumbs}>
        {items.map((part, index) => (
          <li
            key={`${index}-${part}`}
            className={styles.crumb}
            aria-current={index === items.length - 1 ? 'page' : undefined}
          >
            {part}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** แถบบนสูง `--dc-bar-top` (44px) */
export function TopBar({ brand, breadcrumb, children }: TopBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>{brand}</div>
      <Breadcrumb items={breadcrumb} />
      <div className={styles.spacer} />
      <div className={styles.actions}>{children}</div>
    </header>
  );
}

/** ทางเข้าระบบอื่นบนแถบบน ใช้ลิงก์/สิทธิ์ที่ host app ประกอบจาก Navigation API */
export function TopBarLinks({ apps, label }: { apps: readonly ShellApp[]; label: string }) {
  const t = useUiText();
  if (!apps.length) return null;
  return (
    <nav aria-label={label} className={styles.systemLinks}>
      {apps.map((app) => (
        <Link
          key={app.id}
          href={app.href}
          aria-label={`${app.label}${app.external ? ` ${t('shell.opensInNewTab')}` : ''}`}
          className={styles.systemLink}
          {...(app.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          <ShellIcon name={app.id} />
          <span className={styles.systemLabel}>{app.label}</span>
        </Link>
      ))}
    </nav>
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
