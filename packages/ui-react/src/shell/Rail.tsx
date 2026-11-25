import { Fragment, type ReactNode } from 'react';
import { useUiText } from '../i18n.js';
import { ShellIcon } from './icons.js';
import type { ShellApp, ShellArea } from './types.js';
import styles from './Rail.module.css';

export interface RailProps {
  /** effective pins (≤15) in order — from the Navigation API */
  pinnedApps: readonly ShellApp[];
  currentAppId?: string;
  onNavigate?: (href: string) => boolean;
  /** #651: work areas — when passed, the rail shows areas instead of pins (empty/not passed = the old app pins) */
  areas?: readonly ShellArea[];
  /** the area currently in use (not passed = no area selected, e.g. the account page) */
  currentAreaId?: string;
  /** button that opens the launcher (`<AppLauncher>`) — fixed at the top */
  launcher: ReactNode;
  /** settings/other button — fixed at the bottom */
  footer?: ReactNode;
}

/**
 * brand-colored left bar: launcher at the top, scrollable pins in the middle, footer at the bottom
 * a divider when adjacent pins belong to different groups; a link to the other host app opens a new tab
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

/** rail button/link that is not a pin (e.g. settings) — used in `footer` */
export function RailLink({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <a className={styles.item} href={href}>
      <ShellIcon name={icon} />
      <span className={styles.label}>{label}</span>
    </a>
  );
}

export const railStyles = styles;
