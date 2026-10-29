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
  /** host router รับลิงก์ภายในได้ โดย Workspace ไม่ต้องเปลี่ยนการนำทางเดิม */
  onNavigate?: (href: string) => boolean;
  /** #651: พื้นที่งานบน rail (ว่าง/ไม่ส่ง = rail แสดงหมุดแอปแบบเดิม) */
  areas?: readonly ShellArea[];
  /** ย้ายทางเข้าบางแอปไปแถบบน โดยไม่เปลี่ยนข้อมูล launcher หรือหมุดที่บันทึกไว้ */
  railExcludedAppIds?: readonly string[];
  brand: ReactNode;
  breadcrumb: readonly string[];
  /** Console ย้ายตำแหน่งมาเหนือเนื้อหา; ค่าเดิมของ Workspace ยังอยู่แถบบน */
  breadcrumbPlacement?: 'topbar' | 'content';
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
