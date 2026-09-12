import { useMemo } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import { PreferenceCenter } from './preference-center.js';
import {
  createConsoleOidcSettings,
  resolveConsoleContextId,
  resolveTenantAlias,
} from './auth-session.js';

function Status({ title, detail, action }: { title: string; detail: string; action?: () => void }) {
  return (
    <main className="empty">
      <h1>{title}</h1>
      <p>{detail}</p>
      {action ? (
        <button className="primary" onClick={action}>
          เข้าสู่ระบบ
        </button>
      ) : null}
    </main>
  );
}

function AuthenticatedConsole({
  apiBaseUrl,
  contextId,
  contactId,
  viewer,
}: {
  apiBaseUrl: string;
  contextId?: string;
  contactId?: string;
  viewer: 'AGENT' | 'ADMIN' | 'COMPLIANCE';
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createConsoleApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <Status
        title="D-Contact Console"
        detail="เข้าสู่ระบบก่อนเปิดหลักฐาน QM"
        action={() => void auth.signinRedirect()}
      />
    );
  if (contactId) return <PreferenceCenter api={api} contactId={contactId} viewer={viewer} />;
  if (contextId) return <ConsoleApp api={api} contextId={contextId} />;
  return (
    <Status title="ไม่พบหน้าที่ต้องการ" detail="ต้องระบุ Interaction context หรือ contactId" />
  );
}

export function ConsoleAuthRoot() {
  const issuer = import.meta.env.VITE_KC_ISSUER as string | undefined;
  const clientId = import.meta.env.VITE_KC_CLIENT_ID as string | undefined;
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  let tenantAlias: string;
  let contextId: string | undefined;
  const url = new URL(window.location.href);
  const preferenceView = url.searchParams.get('view') === 'preferences';
  const contactId = preferenceView ? (url.searchParams.get('contactId') ?? undefined) : undefined;
  try {
    tenantAlias = resolveTenantAlias(url);
    contextId = preferenceView ? undefined : resolveConsoleContextId(url);
  } catch {
    return (
      <Status
        title="ไม่พบ Interaction context"
        detail="เปิด Console จาก Workspace ด้วย opaque context"
      />
    );
  }
  if (!issuer || !clientId)
    return (
      <Status
        title="ยังไม่ได้ตั้งค่า Identity Provider"
        detail="ต้องกำหนด VITE_KC_ISSUER และ VITE_KC_CLIENT_ID"
      />
    );
  const settings = createConsoleOidcSettings({
    issuer,
    clientId,
    origin: window.location.origin,
    tenantAlias,
    stateStorage: window.sessionStorage,
  });
  return (
    <AuthProvider {...settings}>
      <ConsoleSurface apiBaseUrl={apiBaseUrl} contextId={contextId} contactId={contactId} />
    </AuthProvider>
  );
}

function ConsoleSurface({
  apiBaseUrl,
  contextId,
  contactId,
}: {
  apiBaseUrl: string;
  contextId?: string;
  contactId?: string;
}) {
  const auth = useAuth();
  const roles = (auth.user?.profile.realm_access as { roles?: unknown } | undefined)?.roles;
  const viewer =
    Array.isArray(roles) && roles.includes('compliance')
      ? 'COMPLIANCE'
      : Array.isArray(roles) && roles.includes('admin')
        ? 'ADMIN'
        : 'AGENT';
  return (
    <AuthenticatedConsole
      apiBaseUrl={apiBaseUrl}
      contextId={contextId}
      contactId={contactId}
      viewer={viewer}
    />
  );
}
