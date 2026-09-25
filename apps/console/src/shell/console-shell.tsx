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
  SubNav,
  ToastRegion,
  toastQueue,
  useShellNavigation,
  type HostApp,
} from '@d-contact/ui-react';
import { useShellTokens } from './tokens.js';

export type ConsoleShellApp = 'journeys' | 'contact-governance';

export function hostOrigins(): Record<HostApp, string> {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    console: env.VITE_CONSOLE_URL ?? window.location.origin,
    workspace: env.VITE_WORKSPACE_URL ?? 'http://localhost:5173',
  };
}

export interface ConsoleShellProps {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  tenantAlias?: string;
  appId: ConsoleShellApp;
  children: ReactNode;
}

export function ConsoleShell({
  apiBaseUrl,
  accessToken,
  tenantAlias,
  appId,
  children,
}: ConsoleShellProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
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
  const tokensReady = useShellTokens(nav.status === 'ready');

  if (nav.status === 'legacy') return <>{children}</>;
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
  const journeysVisible = nav.apps.some((app) => app.id === 'journeys');
  const subNav =
    appId === 'journeys' ? (
      <SubNav
        eyebrow={t('navigation.groups.automation')}
        title={t('navigation.apps.journeys')}
        currentItemId="list"
        sections={[
          {
            id: 'work',
            label: t('shell.journeys.sectionWork'),
            items: [
              {
                id: 'list',
                label: t('shell.journeys.list'),
                href: withTenant('/?view=journeys'),
                icon: 'journeys',
              },
            ],
          },
        ]}
      />
    ) : (
      <SubNav
        eyebrow={t('navigation.groups.quality')}
        title={t('navigation.apps.contactGovernance')}
        currentItemId="overview"
        sections={[
          {
            id: 'work',
            label: t('shell.governance.sectionWork'),
            items: [
              {
                id: 'overview',
                label: t('shell.governance.overview'),
                href: withTenant('/?view=governance'),
                icon: 'contact-governance',
              },
            ],
          },
        ]}
      />
    );

  return (
    <>
      <ShellFrame
        apps={nav.apps}
        groups={nav.groups}
        pinnedIds={nav.pinnedIds}
        maxPins={nav.maxPins}
        onTogglePin={nav.togglePin}
        currentAppId={appId}
        brand={
          <>
            <img src="/d-contact-icon-64.png" alt="" width={24} height={24} />
            <span>{t('shell.brand')}</span>
          </>
        }
        breadcrumb={
          appId === 'journeys'
            ? [t('navigation.groups.automation'), t('navigation.apps.journeys')]
            : [t('navigation.groups.quality'), t('navigation.apps.contactGovernance')]
        }
        language={locale}
        onLanguageChange={(next) => {
          void setLocale(next).catch(() =>
            toastQueue.add(
              { title: t('language.saveFailed'), tone: 'attention' },
              { timeout: 6000 },
            ),
          );
        }}
        subNav={subNav}
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
        {children}
      </ShellFrame>
      <ToastRegion />
    </>
  );
}
