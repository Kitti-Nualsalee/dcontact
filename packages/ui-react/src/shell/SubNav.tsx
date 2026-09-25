import { ShellIcon } from './icons.js';
import styles from './SubNav.module.css';

export interface SubNavItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  count?: number;
}

export interface SubNavSection {
  id: string;
  label?: string;
  items: readonly SubNavItem[];
}

export interface SubNavProps {
  /** ชื่อแอป เช่น "Journeys" และชื่อกลุ่มเหนือชื่อแอป */
  title: string;
  eyebrow?: string;
  sections: readonly SubNavSection[];
  currentItemId?: string;
}

/** แผงเมนูย่อยของแอปใน Console (หน้าตาแบบ B: ชื่อกลุ่ม, ไอคอนนำ, แถว 36px) */
export function SubNav({ title, eyebrow, sections, currentItemId }: SubNavProps) {
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
                >
                  <ShellIcon name={item.icon ?? 'fallback'} />
                  <span className={styles.itemLabel}>{item.label}</span>
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
