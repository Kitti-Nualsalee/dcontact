import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import type { ShellApp } from './types.js';
import styles from './TopBar.module.css';

export interface TopBarProps {
  /** logo/app name */
  brand: ReactNode;
  /** current location, e.g. ["Automation", "Journeys"] — the last one is this page */
  breadcrumb: readonly string[];
  /** right part: language switch, ready-for-work status (Workspace), profile */
  children?: ReactNode;
}

export interface BreadcrumbProps {
  items: readonly string[];
  placement?: 'topbar' | 'content';
}

/** the current location can be shared by both the top bar and above the content */
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

/** top bar height `--dc-bar-top` (44px) */
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

/** entry points to other systems on the top bar, using links/permissions the host app builds from the Navigation API */
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

/** switches TH/EN immediately without a reload (D1.5) — the language name is always shown in its own language */
export function LanguageSwitch({ value, onChange }: LanguageSwitchProps) {
  const t = useUiText();
  // Each language is named in itself, so both catalogs hold the same names
  const options = [
    { id: 'th', short: 'TH', name: t('shell.languageNames.th'), lang: 'th' },
    { id: 'en', short: 'EN', name: t('shell.languageNames.en'), lang: 'en' },
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
