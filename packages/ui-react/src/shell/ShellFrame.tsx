import type { ReactNode } from 'react';
import { AppLauncher } from './AppLauncher.js';
import { AppShell } from './AppShell.js';
import { areaOf } from './areas.js';
import { Rail } from './Rail.js';
import { Breadcrumb, LanguageSwitch, TopBar } from './TopBar.js';
import type { ShellApp, ShellArea, ShellCreateAction, ShellGroup } from './types.js';
import { UserMenu, type UserMenuProps } from './UserMenu.js';

export interface ShellFrameProps {
  apps: readonly ShellApp[];
  groups: readonly ShellGroup[];
  pinnedIds: readonly string[];
  maxPins: number;
  onTogglePin: (appId: string) => void;
  currentAppId: string;
  /** the host router can take internal links, so Workspace does not need to change its existing navigation */
  onNavigate?: (href: string) => boolean;
  /** #651: work areas on the rail (empty/not passed = the rail shows the old app pins) */
  areas?: readonly ShellArea[];
  /** moves some app entries to the top bar without changing the launcher data or saved pins */
  railExcludedAppIds?: readonly string[];
  brand: ReactNode;
  breadcrumb: readonly string[];
  /** Console moves the position above the content; Workspace's default stays on the top bar */
  breadcrumbPlacement?: 'topbar' | 'content';
  language: 'th' | 'en';
  onLanguageChange: (language: 'th' | 'en') => void;
  /** Console passes `<SubNav>`; Workspace does not (D1.2) */
  subNav?: ReactNode;
  createActions?: readonly ShellCreateAction[];
  railFooter?: ReactNode;
  /** right part of the top bar before the language button, e.g. Workspace's ready-for-work status */
  topBarActions?: ReactNode;
  /** #588: user menu at the far right of the top bar — not passed = the top bar stays as before */
  user?: UserMenuProps;
  children: ReactNode;
}

/** composes the same AppShell + Rail + AppLauncher + TopBar for both apps */
export function ShellFrame(props: ShellFrameProps) {
  const excluded = new Set(props.railExcludedAppIds);
  const pinnedApps = props.pinnedIds
    .filter((id) => !excluded.has(id))
    .map((id) => props.apps.find((app) => app.id === id))
    .filter((app): app is ShellApp => app !== undefined);
  const railAreas = excluded.size
    ? props.areas?.flatMap((area) => {
        const sections = area.sections
          .map((section) => ({
            ...section,
            items: section.items.filter((item) => !excluded.has(item.id)),
          }))
          .filter((section) => section.items.length);
        const first = sections[0]?.items[0];
        return first ? [{ ...area, href: first.href, external: first.external, sections }] : [];
      })
    : props.areas;
  return (
    <AppShell
      rail={
        <Rail
          pinnedApps={pinnedApps}
          currentAppId={props.currentAppId}
          onNavigate={props.onNavigate}
          areas={railAreas}
          currentAreaId={areaOf(railAreas, props.currentAppId)}
          footer={props.railFooter}
          launcher={
            <AppLauncher
              apps={props.apps}
              groups={props.groups}
              pinnedIds={props.pinnedIds}
              maxPins={props.maxPins}
              onTogglePin={props.onTogglePin}
              createActions={props.createActions}
            />
          }
        />
      }
      subNav={props.subNav}
      topBar={
        <TopBar
          brand={props.brand}
          breadcrumb={props.breadcrumbPlacement === 'content' ? [] : props.breadcrumb}
        >
          {props.topBarActions}
          <LanguageSwitch value={props.language} onChange={props.onLanguageChange} />
          {props.user ? <UserMenu {...props.user} /> : null}
        </TopBar>
      }
    >
      {props.breadcrumbPlacement === 'content' ? (
        <>
          <Breadcrumb items={props.breadcrumb} placement="content" />
          {props.children}
        </>
      ) : (
        props.children
      )}
    </AppShell>
  );
}
