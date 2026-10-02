import type { ReactNode } from 'react';
import { AppLauncher } from './AppLauncher.js';
import { AppShell } from './AppShell.js';
import { Rail } from './Rail.js';
import { LanguageSwitch, TopBar } from './TopBar.js';
import type { ShellApp, ShellCreateAction, ShellGroup } from './types.js';
import { UserMenu, type UserMenuProps } from './UserMenu.js';

export interface ShellFrameProps {
  apps: readonly ShellApp[];
  groups: readonly ShellGroup[];
  pinnedIds: readonly string[];
  maxPins: number;
  onTogglePin: (appId: string) => void;
  currentAppId: string;
  brand: ReactNode;
  breadcrumb: readonly string[];
  language: 'th' | 'en';
  onLanguageChange: (language: 'th' | 'en') => void;
  /** Console ส่ง `<SubNav>`; Workspace ไม่ส่ง (D1.2) */
  subNav?: ReactNode;
  createActions?: readonly ShellCreateAction[];
  railFooter?: ReactNode;
  /** ส่วนขวาของแถบบนก่อนปุ่มภาษา เช่น สถานะพร้อมรับงานของ Workspace */
  topBarActions?: ReactNode;
  /** #588: เมนูผู้ใช้ขวาสุดของแถบบน — ไม่ส่ง = แถบบนเหมือนเดิม */
  user?: UserMenuProps;
  children: ReactNode;
}

/** ประกอบ AppShell + Rail + AppLauncher + TopBar ชุดเดียวกันให้ทั้งสองแอป */
export function ShellFrame(props: ShellFrameProps) {
  const pinnedApps = props.pinnedIds
    .map((id) => props.apps.find((app) => app.id === id))
    .filter((app): app is ShellApp => app !== undefined);
  return (
    <AppShell
      rail={
        <Rail
          pinnedApps={pinnedApps}
          currentAppId={props.currentAppId}
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
        <TopBar brand={props.brand} breadcrumb={props.breadcrumb}>
          {props.topBarActions}
          <LanguageSwitch value={props.language} onChange={props.onLanguageChange} />
          {props.user ? <UserMenu {...props.user} /> : null}
        </TopBar>
      }
    >
      {props.children}
    </AppShell>
  );
}
