import { useMemo, useState } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Popover,
  ToggleButton,
} from 'react-aria-components';
import { SearchField } from '../components/TextField.js';
import { useUiText } from '../i18n.js';
import { ShellIcon, WaffleIcon } from './icons.js';
import { railStyles } from './Rail.js';
import type { ShellApp, ShellCreateAction, ShellGroup } from './types.js';
import styles from './AppLauncher.module.css';

export interface AppLauncherProps {
  /** แอปที่มองเห็นทั้งหมด (server คัดตาม role/plan แล้ว — ไม่มีสถานะ "ล็อก") */
  apps: readonly ShellApp[];
  /** กลุ่มตามลำดับที่แสดง — กลุ่มที่ไม่มีแอปถูกซ่อน */
  groups: readonly ShellGroup[];
  pinnedIds: readonly string[];
  maxPins: number;
  onTogglePin: (appId: string) => void;
  /** แถว "สร้างใหม่" — ลิงก์ด้วย ID/route เท่านั้น */
  createActions?: readonly ShellCreateAction[];
}

/**
 * ปุ่มตาราง 9 จุดบน rail + popover รวมแอปแบ่งกลุ่ม ค้นหาได้ ปักหมุดได้ (D1.2)
 * React Aria ดูแล focus: เปิดแล้ว focus ที่ช่องค้นหา, Esc ปิดแล้ว focus กลับที่ปุ่ม
 */
export function AppLauncher({
  apps,
  groups,
  pinnedIds,
  maxPins,
  onTogglePin,
  createActions = [],
}: AppLauncherProps) {
  const t = useUiText();
  const [query, setQuery] = useState('');
  const pinned = new Set(pinnedIds);
  const atLimit = pinnedIds.length >= maxPins;

  const sections = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return groups
      .map((group) => ({
        group,
        apps: apps.filter(
          (app) => app.groupId === group.id && (!q || app.label.toLocaleLowerCase().includes(q)),
        ),
      }))
      .filter((section) => section.apps.length > 0);
  }, [apps, groups, query]);

  return (
    <DialogTrigger onOpenChange={(open) => !open && setQuery('')}>
      <AriaButton className={railStyles.button} aria-label={t('shell.allApps')}>
        <WaffleIcon />
        <span className={railStyles.label} aria-hidden="true">
          {t('shell.apps')}
        </span>
      </AriaButton>
      <Popover className={styles.popover} placement="end top" offset={6}>
        <AriaDialog className={styles.dialog} aria-label={t('launcher.title')}>
          <Heading slot="title" className={styles.srOnly}>
            {t('launcher.title')}
          </Heading>
          <div className={styles.search}>
            <SearchField
              aria-label={t('launcher.search')}
              placeholder={t('launcher.search')}
              value={query}
              onChange={setQuery}
              autoFocus
            />
          </div>
          <div className={styles.body}>
            {sections.map(({ group, apps: groupApps }) => (
              <section
                key={group.id}
                className={styles.section}
                aria-labelledby={`dc-launcher-${group.id}`}
              >
                <h3 id={`dc-launcher-${group.id}`} className={styles.groupLabel}>
                  {group.label}
                </h3>
                <ul className={styles.grid}>
                  {groupApps.map((app) => {
                    const isPinned = pinned.has(app.id);
                    return (
                      <li key={app.id} className={styles.tile}>
                        <a
                          className={styles.tileLink}
                          href={app.href}
                          {...(app.external
                            ? { target: '_blank', rel: 'noopener noreferrer' }
                            : {})}
                        >
                          <span className={styles.tileIcon} data-group={group.id}>
                            <ShellIcon name={app.id} size={24} />
                          </span>
                          <span className={styles.tileLabel}>
                            {app.label}
                            {app.external ? (
                              <>
                                <span aria-hidden="true"> ↗</span>
                                <span className={styles.srOnly}> {t('shell.opensInNewTab')}</span>
                              </>
                            ) : null}
                          </span>
                        </a>
                        <ToggleButton
                          className={styles.pin}
                          isSelected={isPinned}
                          isDisabled={!isPinned && atLimit}
                          onChange={() => onTogglePin(app.id)}
                          aria-label={t(isPinned ? 'launcher.unpin' : 'launcher.pin', {
                            app: app.label,
                          })}
                        >
                          <ShellIcon name="pin" size={12} filled={isPinned} />
                        </ToggleButton>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {sections.length === 0 ? (
              <p className={styles.empty} role="status">
                {t('launcher.noMatch')}
              </p>
            ) : null}
          </div>
          {createActions.length > 0 ? (
            <section className={styles.create} aria-labelledby="dc-launcher-create">
              <h3 id="dc-launcher-create" className={styles.groupLabel}>
                {t('launcher.create')}
              </h3>
              <ul className={styles.createGrid}>
                {createActions.map((action) => (
                  <li key={action.id}>
                    <a
                      className={styles.createLink}
                      href={action.href}
                      {...(action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      <span className={styles.createIcon}>
                        <ShellIcon name="plus" size={20} />
                      </span>
                      {action.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <footer className={styles.footer}>
            <span role="status">
              {t('launcher.pinned', { count: pinnedIds.length, max: maxPins })}
            </span>
            <span>{atLimit ? t('launcher.pinLimit', { max: maxPins }) : t('launcher.hint')}</span>
          </footer>
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  );
}
