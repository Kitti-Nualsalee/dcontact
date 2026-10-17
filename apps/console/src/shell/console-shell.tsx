/**
 * D1.13 (#452): shell ใหม่ของ Console หลัง flag `ui.shell.v2` ระดับ tenant
 *
 * - flag มาจาก Navigation API (`features.shellV2`) และตัดสินครั้งเดียวต่อการโหลดหน้า
 *   ปิด flag = หน้าเดิมทุกประการในการโหลดครั้งถัดไป โดยไม่ต้อง deploy
 * - token (`@d-contact/ui/tokens.css`) โหลดแบบ dynamic เฉพาะเมื่อเปิด shell เพราะมีกฎ global ของ
 *   html/body — หน้าเดิมตอนปิด flag จึงไม่เปลี่ยนแม้แต่ฟอนต์
 * - เนื้อหาของหน้า (Journeys/Governance) ถูกครอบโดยไม่แตะ layout ภายใน — การย้ายหน้าจริงคือ D1.14
 */
import type { ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  ShellFrame,
  LanguageSwitch,
  TopBar,
  UserMenu,
  type ShellNavigationState,
  ShellPageNavProvider,
  SubNav,
  areaOf,
  ToastRegion,
  toastQueue,
  useShellNavigation,
  type HostApp,
  type ShellArea,
  type ShellApp,
  type ShellUser,
  type UserMenuProps,
} from '@d-contact/ui-react';
import { useShellTokens } from './tokens.js';

export type ConsoleShellApp =
  | 'home'
  | 'voice-routing'
  | 'agent-history'
  | 'journeys'
  | 'contact-governance'
  | 'dphone-embedding'
  // AC5 (#598): หน้าบัญชี — ไม่อยู่ใน app registry จึงไม่มี app ใดถูกเลือกใน rail
  | 'account'
  | 'account-policy';

export function hostOrigins(): Partial<Record<HostApp, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    console: env.VITE_CONSOLE_URL ?? window.location.origin,
    // production ต้องตั้ง VITE_WORKSPACE_URL — ไม่ตั้ง = แอปฝั่งนั้นไม่แสดงใน shell (ไม่เดาเป็น localhost)
    workspace:
      env.VITE_WORKSPACE_URL ?? (import.meta.env.DEV ? 'http://localhost:5173' : undefined),
  };
}

/**
 * #651: เมนูย่อยของพื้นที่ — ส่วน "ปักหมุด" (ถ้ามี) อยู่บนสุด ตามด้วยกลุ่มย่อยของพื้นที่ตามลำดับที่ server ส่ง
 * ไอคอนของรายการ = id ของแอป (ShellIcon ใช้ไอคอน fallback เมื่อไม่รู้จัก)
 */
export function areaSections(
  area: ShellArea,
  apps: readonly ShellApp[],
  pinnedIds: readonly string[],
  pinnedLabel: string,
  /** #658: เลือกหน้าย่อยของแอปที่กำลังเปิดโดยไม่โหลดหน้าใหม่ */
  page?: { appId: string; onSelect: (pageId: string) => void },
) {
  const item = (app: {
    id: string;
    pageId?: string;
    label: string;
    href: string;
    external: boolean;
  }) => ({
    // หน้าย่อยใช้ id เฉพาะ (`<appId>:<pageId>`) ให้ไฮไลต์ทีละหน้า; ไอคอนยังเป็นของแอป
    id: app.pageId ? subNavItemId(app.id, app.pageId) : app.id,
    label: app.label,
    href: app.href,
    icon: app.id,
    external: app.external,
    ...(page && app.pageId && app.id === page.appId
      ? { onSelect: () => page.onSelect(app.pageId!) }
      : {}),
  });
  // หมุดที่อยู่ในพื้นที่นี้อยู่แล้วไม่ซ้ำในส่วนปักหมุด
  const inArea = new Set(area.sections.flatMap((section) => section.items.map((i) => i.id)));
  const pinned = pinnedIds.flatMap((id) => {
    if (inArea.has(id)) return [];
    const app = apps.find((candidate) => candidate.id === id);
    return app ? [item(app)] : [];
  });
  return [
    ...(pinned.length > 0 ? [{ id: 'pinned', label: pinnedLabel, items: pinned }] : []),
    ...area.sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map(item),
    })),
  ];
}

/** id ของรายการหน้าย่อยในเมนูย่อย — ใช้เป็น `currentItemId` */
export function subNavItemId(appId: string, pageId: string) {
  return `${appId}:${pageId}`;
}

function legacySubNav(app: ShellApp | undefined) {
  if (!app) return undefined;
  return (
    <SubNav
      title={app.label}
      currentItemId={app.id}
      sections={[
        {
          id: 'work',
          items: [{ id: app.id, label: app.label, href: app.href, icon: app.id }],
        },
      ]}
    />
  );
}

export interface ConsoleShellProps {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  tenantAlias?: string;
  appId: ConsoleShellApp;
  /** #588: เมนูผู้ใช้บนแถบบน (ชื่อ, organization, บทบาท และออกจากระบบ) */
  account?: { user: ShellUser; onSignOut: () => Promise<void> };
  /**
   * #658: หน้าย่อยที่เปิดอยู่ของแอป (เมื่อ server ส่ง `pages`) และตัวเปลี่ยนหน้าแบบไม่โหลดใหม่ —
   * เนื้อหาหน้าเป็นเจ้าของสถานะหน้า shell แค่วาดเมนู
   */
  pageId?: string;
  onPageSelect?: (pageId: string) => void;
  /** Home ใช้ render function เพื่ออ่าน Navigation API request เดียวกับ shell รวม legacy fallback */
  children: ReactNode | ((navigation: ShellNavigationState) => ReactNode);
}

export function ConsoleShell({
  apiBaseUrl,
  accessToken,
  tenantAlias,
  appId,
  account,
  pageId,
  onPageSelect,
  children,
}: ConsoleShellProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const { t: homeText } = useTranslation('home');
  const translate = t as unknown as (key: string) => string;
  const nav = useShellNavigation({
    apiBaseUrl,
    accessToken,
    currentHost: 'console',
    hostOrigins: hostOrigins(),
    tenantAlias,
    translate,
    onPinError: () =>
      toastQueue.add(
        { title: translate('shell.pinSaveFailed'), tone: 'attention' },
        { timeout: 6000 },
      ),
  });
  const tokensReady = useShellTokens(nav.status === 'ready' || appId === 'home');
  const content = typeof children === 'function' ? children(nav) : children;

  if (nav.status === 'legacy' && appId !== 'home') return <>{content}</>;
  if (nav.status === 'loading' || !tokensReady) {
    return (
      <main className="empty" aria-busy="true">
        <p>{t('shell.loading')}</p>
      </main>
    );
  }

  const withTenant = (path: string) => {
    const url = new URL(path, window.location.origin);
    if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
    return `${url.pathname}${url.search}`;
  };
  // #588: redirect ไปออกจากระบบไม่สำเร็จ (เช่น โหลด metadata ไม่ได้) ต้องแจ้งผู้ใช้ ไม่เงียบหาย
  const userMenu = ({
    user,
    onSignOut,
  }: NonNullable<ConsoleShellProps['account']>): UserMenuProps => ({
    user,
    // AC5 (#598): หน้าบัญชีของ Console เปิดในแท็บเดิม
    accountLink: { href: withTenant('/?view=account') },
    onSignOut: () =>
      onSignOut().catch(() => {
        toastQueue.add({ title: t('shell.signOutFailed'), tone: 'attention' }, { timeout: 6000 });
      }),
  });
  const brand = (
    <>
      <img src="/d-contact-icon-64.png" alt="" width={24} height={24} />
      <span>{t('shell.brand')}</span>
    </>
  );
  const onLanguageChange = (next: 'th' | 'en') => {
    void setLocale(next).catch(() =>
      toastQueue.add({ title: t('language.saveFailed'), tone: 'attention' }, { timeout: 6000 }),
    );
  };
  // Home ยังเปิดได้เมื่อปิด shell; ไม่แสดง rail จนกว่าจะเปิด flag ตาม rollout เดิม
  if (nav.status === 'legacy')
    return (
      <div className="home-shell">
        <TopBar brand={brand} breadcrumb={[t('navigation.apps.home')]}>
          <LanguageSwitch value={locale} onChange={onLanguageChange} />
          {account ? <UserMenu {...userMenu(account)} /> : null}
        </TopBar>
        <main>{content}</main>
        <ToastRegion />
      </div>
    );
  const homeApps = nav.apps.filter((app) => app.id !== 'home');
  const homeSubNav = (
    <SubNav
      title={homeText('nav')}
      currentItemId="home"
      sections={[
        {
          id: 'home',
          items: [
            {
              id: 'home',
              label: t('navigation.apps.home'),
              href: withTenant('/?view=home'),
              icon: 'area-home',
            },
          ],
        },
        {
          id: 'workspaces',
          label: homeText('nav'),
          items: homeApps.map((app) => ({
            ...app,
            label:
              app.id === 'agent-workspace'
                ? app.label
                : homeText(`names.${app.id}`, { defaultValue: app.label }),
            icon: app.id === 'dphone-embedding' ? 'area-integrations' : app.id,
          })),
        },
        {
          id: 'account',
          items: [
            {
              id: 'account',
              label: t('shell.account.mine'),
              href: withTenant('/?view=account'),
              icon: 'settings',
            },
          ],
        },
      ]}
    />
  );
  const journeysVisible = nav.apps.some((app) => app.id === 'journeys');
  const isAdmin = account?.user.roles.includes('admin') ?? false;
  const accountPage = appId === 'account' || appId === 'account-policy';
  const area = accountPage ? undefined : nav.areas.find((a) => a.id === areaOf(nav.areas, appId));
  // #658: เมนูย่อยมีหน้าย่อยของแอปนี้ → เนื้อหาไม่ต้องวาดแท็บเอง
  const hasPages =
    area?.sections.some((section) =>
      section.items.some((entry) => entry.id === appId && entry.pageId !== undefined),
    ) ?? false;
  const pageLabel = hasPages
    ? area?.sections
        .flatMap((section) => section.items)
        .find((entry) => entry.id === appId && entry.pageId === pageId)?.label
    : undefined;
  const subNav =
    appId === 'home' ? (
      homeSubNav
    ) : accountPage ? (
      <SubNav
        eyebrow={t('shell.account.eyebrow')}
        title={t('shell.account.title')}
        currentItemId={appId}
        sections={[
          {
            id: 'account',
            label: t('shell.account.section'),
            items: [
              {
                id: 'account',
                label: t('shell.account.mine'),
                href: withTenant('/?view=account'),
                icon: 'settings',
              },
              // role ใช้แค่ซ่อนลิงก์ — API ตรวจ admin ทุก request
              ...(isAdmin
                ? [
                    {
                      id: 'account-policy',
                      label: t('shell.account.policy'),
                      href: withTenant('/?view=account-policy'),
                      icon: 'settings' as const,
                    },
                  ]
                : []),
            ],
          },
        ]}
      />
    ) : area ? (
      // #651: เมนูย่อยคำนวณจากพื้นที่ที่ server ส่งมา — เพิ่มหน้าใหม่ไม่ต้องแก้ไฟล์นี้
      <SubNav
        title={area.label}
        currentItemId={hasPages && pageId ? subNavItemId(appId, pageId) : appId}
        sections={areaSections(
          area,
          nav.apps,
          nav.pinnedIds,
          t('shell.pinned'),
          hasPages && onPageSelect ? { appId, onSelect: onPageSelect } : undefined,
        )}
      />
    ) : (
      // API รุ่นเก่าที่ยังไม่ส่ง `areas` (rollback ของ API ภายใต้ Console ใหม่): เมนูย่อยรายการเดียวของแอปนี้
      legacySubNav(nav.apps.find((app) => app.id === appId))
    );

  const frame = (
    <>
      <ShellFrame
        apps={nav.apps}
        groups={nav.groups}
        pinnedIds={nav.pinnedIds}
        maxPins={nav.maxPins}
        onTogglePin={nav.togglePin}
        currentAppId={appId}
        areas={nav.areas}
        brand={brand}
        breadcrumb={
          appId === 'home'
            ? [t('navigation.apps.home')]
            : appId === 'account' || appId === 'account-policy'
              ? [
                  t('shell.account.title'),
                  t(appId === 'account' ? 'shell.account.mine' : 'shell.account.policy'),
                ]
              : appId === 'voice-routing'
                ? [t('navigation.apps.voiceRouting'), ...(pageLabel ? [pageLabel] : [])]
                : appId === 'journeys'
                  ? [t('navigation.groups.automation'), t('navigation.apps.journeys')]
                  : appId === 'dphone-embedding'
                    ? [t('navigation.groups.settings'), t('navigation.apps.dphoneEmbedding')]
                    : [
                        t('navigation.groups.quality'),
                        t('navigation.apps.contactGovernance'),
                        ...(pageLabel ? [pageLabel] : []),
                      ]
        }
        language={locale}
        onLanguageChange={onLanguageChange}
        subNav={appId === 'home' ? <div className="home-sidebar">{subNav}</div> : subNav}
        user={account ? userMenu(account) : undefined}
        createActions={
          journeysVisible
            ? [
                {
                  id: 'journey',
                  label: t('shell.create.journey'),
                  href: withTenant('/?view=journeys'),
                  external: false,
                },
              ]
            : []
        }
      >
        <ShellPageNavProvider value={hasPages}>{content}</ShellPageNavProvider>
      </ShellFrame>
      <ToastRegion />
    </>
  );
  return appId === 'home' ? <div className="home-shell">{frame}</div> : frame;
}
