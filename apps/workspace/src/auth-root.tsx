import { useMemo } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { createAgentWorkspaceApi } from './agent-api.js';
import { createOidcSettings, resolveTenantAlias } from './auth-session.js';
import { SipJsBrowserTransport } from './sip-js-transport.js';
import { BrowserSoftphone } from './softphone.js';
import { WorkspaceApp, type SoftphoneFactory } from './workspace-app.js';

const createProductionSoftphone: SoftphoneFactory = (remoteAudio, callbacks) =>
  new BrowserSoftphone(new SipJsBrowserTransport(remoteAudio, callbacks));

function AuthenticatedWorkspace({ apiBaseUrl, tenantAlias }: AuthenticatedWorkspaceProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () =>
      createAgentWorkspaceApi({
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

  return (
    <WorkspaceApp
      api={api}
      tenantLabel={tenantAlias}
      onSignOut={() => void auth.signoutRedirect()}
      createSoftphone={createProductionSoftphone}
    />
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
      <AuthenticatedWorkspace apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
    </AuthProvider>
  );
}
