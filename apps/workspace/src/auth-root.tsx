import { useMemo, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { appI18n } from './i18n/index.js';
import { WorkspaceShell } from './shell/workspace-shell.js';
import { createAgentWorkspaceApi } from './agent-api.js';
import {
  createOidcSettings,
  resolveAuthorizedWorkspaceView,
  resolveTenantAlias,
} from './auth-session.js';
import { SipJsBrowserTransport } from './dphone/sip-js-transport.js';
import { BrowserDphone } from './dphone/dphone.js';
import { createSupervisorWorkspaceApi } from './supervisor-api.js';
import { SupervisorWorkspace } from './supervisor-workspace.js';
import { WorkspaceApp, type DphoneFactory } from './workspace-app.js';

const createProductionDphone: DphoneFactory = (remoteAudio, callbacks) =>
  new BrowserDphone(new SipJsBrowserTransport(remoteAudio, callbacks));

function AuthenticatedWorkspace({ apiBaseUrl, tenantAlias }: AuthenticatedWorkspaceProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const agentApi = useMemo(
    () =>
      createAgentWorkspaceApi({
        baseUrl: apiBaseUrl,
        accessToken: () => accessToken,
      }),
    [accessToken, apiBaseUrl],
  );
  const supervisorApi = useMemo(
    () =>
      createSupervisorWorkspaceApi({
        baseUrl: apiBaseUrl,
        accessToken: () => accessToken,
      }),
    [accessToken, apiBaseUrl],
  );

  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) {
    return <AuthStatus title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ session" />;
  }
  if (auth.activeNavigator === 'signoutRedirect') {
    return <AuthStatus title="กำลังออกจากระบบ" detail="กำลังปิด Workspace session" />;
  }
  if (auth.error) {
    return (
      <AuthStatus
        title="เข้าสู่ระบบไม่สำเร็จ"
        detail="ระบบไม่เปิดรับสายใหม่ โปรดลองเข้าสู่ระบบอีกครั้ง"
        actionLabel="ลองอีกครั้ง"
        onAction={() => void auth.signinRedirect()}
      />
    );
  }
  if (!auth.isAuthenticated || !accessToken) {
    return (
      <AuthStatus
        title="D-Contact Workspace"
        detail={`เข้าสู่ระบบสำหรับ organization ${tenantAlias}`}
        actionLabel="เข้าสู่ระบบ"
        onAction={() => void auth.signinRedirect()}
      />
    );
  }

  const view = resolveAuthorizedWorkspaceView(new URL(window.location.href), auth.user?.profile);
  if (view === 'forbidden') {
    return (
      <AuthStatus
        title="ไม่มีสิทธิ์เปิด Supervisor Workspace"
        detail="บัญชีนี้ไม่มี role supervisor หรือ admin ใน organization ปัจจุบัน"
        actionLabel="กลับ Agent Workspace"
        onAction={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('view');
          window.location.assign(url);
        }}
      />
    );
  }
  const shellProps = { apiBaseUrl, accessToken: () => accessToken, tenantAlias } as const;
  if (view === 'supervisor') {
    return (
      <WorkspaceShell {...shellProps} appId="supervisor-workspace">
        <SupervisorWorkspace
          api={supervisorApi}
          tenantLabel={tenantAlias}
          onSignOut={() => void auth.signoutRedirect()}
        />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell {...shellProps} appId="agent-workspace">
      <WorkspaceApp
        api={agentApi}
        tenantLabel={tenantAlias}
        onSignOut={() => void auth.signoutRedirect()}
        createDphone={createProductionDphone}
      />
    </WorkspaceShell>
  );
}

interface AuthenticatedWorkspaceProps {
  apiBaseUrl: string;
  tenantAlias: string;
}

interface AuthStatusProps {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}

function AuthStatus({ title, detail, actionLabel, onAction }: AuthStatusProps) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-live="polite">
        <div className="auth-mark" aria-hidden="true">
          D
        </div>
        <h1>{title}</h1>
        <p>{detail}</p>
        {actionLabel && onAction ? (
          <button type="button" className="primary-action" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

export function WorkspaceAuthRoot() {
  const issuer = import.meta.env.VITE_KC_ISSUER as string | undefined;
  const clientId = import.meta.env.VITE_KC_CLIENT_ID as string | undefined;
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  let tenantAlias: string;
  try {
    tenantAlias = resolveTenantAlias(new URL(window.location.href));
  } catch {
    return (
      <AuthStatus
        title="ไม่พบ organization"
        detail="เปิด Workspace ด้วย tenant hostname หรือระบุ ?tenant=<alias> สำหรับ local development"
      />
    );
  }
  if (!issuer || !clientId) {
    return (
      <AuthStatus
        title="ยังไม่ได้ตั้งค่า Identity Provider"
        detail="ต้องกำหนด VITE_KC_ISSUER และ VITE_KC_CLIENT_ID ก่อนเปิด Workspace"
      />
    );
  }

  const settings = createOidcSettings({
    issuer,
    clientId,
    origin: window.location.origin,
    tenantAlias,
    stateStorage: window.sessionStorage,
  });
  return (
    <AuthProvider
      {...settings}
      onSigninCallback={() => {
        const cleanUrl = new URL('/', window.location.origin);
        cleanUrl.searchParams.set('tenant', tenantAlias);
        window.history.replaceState({}, document.title, cleanUrl);
      }}
    >
      <WorkspaceLocale apiBaseUrl={apiBaseUrl} issuer={issuer}>
        <AuthenticatedWorkspace apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
      </WorkspaceLocale>
    </AuthProvider>
  );
}

/**
 * D1.11 (#450): ภาษา/timezone ตามลำดับ ผู้ใช้ → tenant → browser → th
 * provider อยู่ตำแหน่งเดิมใน tree ตลอด (มี/ไม่มี session) — Workspace จึงไม่ remount เมื่อ token มาถึง
 * หรือเมื่อสลับภาษา ซึ่งจะตัด WebRTC/WS ของสายที่คุยอยู่ (ADR-026)
 */
function WorkspaceLocale({
  apiBaseUrl,
  issuer,
  children,
}: {
  apiBaseUrl: string;
  issuer: string;
  children: ReactNode;
}) {
  const auth = useAuth();
  const accessToken = auth.isAuthenticated ? auth.user?.access_token : undefined;
  const session = accessToken
    ? { claims: auth.user?.profile, accessToken, apiBaseUrl, issuer }
    : undefined;
  return (
    <SessionLocaleProvider i18n={appI18n} session={session}>
      {children}
    </SessionLocaleProvider>
  );
}
