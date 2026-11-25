import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import styles from './SubNav.module.css';

export interface SubNavItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  count?: number;
  /** lives in the other host app → opens a new tab (ADR-026 item 3) */
  external?: boolean;
  /**
   * #658: navigate within the same app without loading a new page — plain left click only;
   * a click with ctrl/⌘/shift, a middle click or a new tab uses `href` as usual
   */
  onSelect?: () => void;
}

export interface SubNavSection {
  id: string;
  label?: string;
  items: readonly SubNavItem[];
}

export interface SubNavProps {
  /** app name, e.g. "Journeys", and the group name above the app name */
  title: string;
  eyebrow?: string;
  sections: readonly SubNavSection[];
  currentItemId?: string;
}

/** sub-menu panel of the app in Console (look B: group name, leading icon, 36px rows) */
export function SubNav({ title, eyebrow, sections, currentItemId }: SubNavProps) {
  const t = useUiText();
  return (
    <nav className={styles.subNav} aria-label={title}>
      <div className={styles.header}>
        {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
        <span className={styles.title}>{title}</span>
      </div>
      {sections.map((section) => (
        <div key={section.id} className={styles.section}>
          {section.label ? <span className={styles.sectionLabel}>{section.label}</span> : null}
          <ul className={styles.list}>
            {section.items.map((item) => (
              <li key={item.id}>
                <a
                  className={styles.item}
                  href={item.href}
                  aria-current={item.id === currentItemId ? 'page' : undefined}
                  onClick={(event) => {
                    if (
                      !item.onSelect ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    item.onSelect();
                  }}
                  {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <ShellIcon name={item.icon ?? 'fallback'} />
                  <span className={styles.itemLabel}>{item.label}</span>
                  {item.external ? (
                    <span className={styles.srOnly}>{t('shell.opensInNewTab')}</span>
                  ) : null}
                  {item.count !== undefined ? (
                    <span className={styles.count}>{item.count}</span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
