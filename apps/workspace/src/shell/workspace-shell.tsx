/**
 * D1.13 (#452): shell ใหม่ของ Workspace หลัง flag `ui.shell.v2` ระดับ tenant — ไม่มี SubNav (D1.2)
 *
 * ต้องตัดสิน shell **ก่อน** mount WorkspaceApp และไม่เปลี่ยนอีกตลอดการโหลดหน้า เพราะการ remount จะตัด
 * softphone/WS ของสายที่คุยอยู่ (ADR-026) — ระหว่างรอคำตอบจึงแสดงสถานะเตรียมหน้าจอแทนการ render ก่อน
 * token โหลดแบบ dynamic เฉพาะเมื่อเปิด shell (มีกฎ global ของ html/body) — ปิด flag = หน้าเดิมทุกประการ
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  ShellFrame,
  ToastRegion,
  toastQueue,
  useShellNavigation,
  type HostApp,
} from '@d-contact/ui-react';

export type WorkspaceShellApp = 'agent-workspace' | 'supervisor-workspace';

function hostOrigins(): Partial<Record<HostApp, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    // production ต้องตั้ง VITE_CONSOLE_URL — ไม่ตั้ง = แอปฝั่งนั้นไม่แสดงใน shell (ไม่เดาเป็น localhost)
    console: env.VITE_CONSOLE_URL ?? (import.meta.env.DEV ? 'http://localhost:5174' : undefined),
    workspace: env.VITE_WORKSPACE_URL ?? window.location.origin,
  };
}

let tokensLoaded: Promise<unknown> | undefined;
function loadShellTokens() {
  tokensLoaded ??= import('@d-contact/ui/tokens.css');
  return tokensLoaded;
}

export interface WorkspaceShellProps {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  tenantAlias?: string;
  appId: WorkspaceShellApp;
  children: ReactNode;
}

export function WorkspaceShell({
  apiBaseUrl,
  accessToken,
  tenantAlias,
  appId,
  children,
}: WorkspaceShellProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const translate = t as unknown as (key: string) => string;
  const nav = useShellNavigation({
    apiBaseUrl,
    accessToken,
    currentHost: 'workspace',
    hostOrigins: hostOrigins(),
    tenantAlias,
    translate,
    onPinError: () =>
      toastQueue.add(
        { title: translate('shell.pinSaveFailed'), tone: 'attention' },
        { timeout: 6000 },
      ),
  });
  const [tokensReady, setTokensReady] = useState(false);
  useEffect(() => {
    if (nav.status !== 'ready') return;
    void loadShellTokens().then(() => setTokensReady(true));
  }, [nav.status]);

  if (nav.status === 'legacy') return <>{children}</>;
  if (nav.status === 'loading' || !tokensReady) {
    return (
      <main className="auth-page" aria-busy="true">
        <p>{t('shell.loading')}</p>
      </main>
    );
  }
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
            <span>D-Contact</span>
          </>
        }
        breadcrumb={[
          t('navigation.groups.live'),
          appId === 'agent-workspace'
            ? t('navigation.apps.agentWorkspace')
            : t('navigation.apps.supervisorWorkspace'),
        ]}
        language={locale}
        onLanguageChange={(next) => {
          void setLocale(next).catch(() =>
            toastQueue.add(
              { title: t('language.saveFailed'), tone: 'attention' },
              { timeout: 6000 },
            ),
          );
        }}
      >
        {children}
      </ShellFrame>
      <ToastRegion />
    </>
  );
}
