import { useMemo, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { appI18n } from './i18n/index.js';
import { ConsoleShell } from './shell/console-shell.js';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import { GovernanceConsole } from './governance-console.js';
import { createGovernanceApi } from './governance-api.js';
import { createCg5ConsoleApi } from './cg5-console-api.js';
import { parseGovernanceLocation, type GovernanceViewer } from './governance-model.js';
import { PreferenceCenter } from './preference-center.js';
import { createJourneyAuthoringApi } from './journey-authoring/api.js';
import { JourneyAuthoringConsole } from './journey-authoring/journey-authoring.js';
import { clearRecovery } from './journey-authoring/state.js';
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
  const governanceView = url.searchParams.get('view') === 'governance';
  const journeyView = url.searchParams.get('view') === 'journeys';
  const contactId = preferenceView ? (url.searchParams.get('contactId') ?? undefined) : undefined;
  try {
    tenantAlias = resolveTenantAlias(url);
    contextId =
      preferenceView || governanceView || journeyView ? undefined : resolveConsoleContextId(url);
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
      <ConsoleLocale apiBaseUrl={apiBaseUrl} issuer={issuer}>
        {journeyView ? (
          <JourneySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : governanceView ? (
          <GovernanceSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : (
          <ConsoleSurface apiBaseUrl={apiBaseUrl} contextId={contextId} contactId={contactId} />
        )}
      </ConsoleLocale>
    </AuthProvider>
  );
}

/**
 * D1.11 (#450): ภาษา/timezone ตามลำดับ ผู้ใช้ → tenant → browser → th — ก่อน login ใช้ภาษา browser
 * ผู้ใช้เปลี่ยนภาษาแล้วบันทึกลง Keycloak attribute `locale` ด้วย token ของตัวเอง
 */
function ConsoleLocale({
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

/**
 * CG4.9 (#192): viewer มาจาก role ใน token เพื่อซ่อนปุ่มที่รู้ว่าจะไม่ผ่านเท่านั้น — สิทธิ์จริงถูก
 * re-authorize ที่ API ทุก command และระดับการเห็น evidence มาจาก capability ฝั่ง server
 */
function GovernanceSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createGovernanceApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  const cg5Api = useMemo(
    () => createCg5ConsoleApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <Status
        title="Contact Governance"
        detail="เข้าสู่ระบบก่อนเปิด Exceptions, Policies และ Audit"
        action={() => void auth.signinRedirect()}
      />
    );
  const roles = (auth.user?.profile.realm_access as { roles?: unknown } | undefined)?.roles;
  const viewer: GovernanceViewer =
    Array.isArray(roles) && roles.includes('compliance')
      ? 'COMPLIANCE'
      : Array.isArray(roles) && roles.includes('admin')
        ? 'TENANT_ADMIN'
        : 'SUPERVISOR';
  return (
    <ConsoleShell
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="contact-governance"
    >
      <GovernanceConsole
        api={api}
        cg5Api={cg5Api}
        viewer={viewer}
        initialLocation={parseGovernanceLocation(new URL(window.location.href))}
      />
    </ConsoleShell>
  );
}

/**
 * J5.6 (#344): Journey authoring — สิทธิ์ทั้งหมดตัดสินที่ API ด้วย capability ของ IAM ไม่อ่าน role ใน
 * token; session recovery ผูก tenant alias + session และถูกล้างเมื่อ logout
 */
function JourneySurface({ apiBaseUrl, tenantAlias }: { apiBaseUrl: string; tenantAlias: string }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createJourneyAuthoringApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken) {
    // ออกจากระบบหรือ session หมด: การแก้ที่ค้างของ tenant นี้ต้องไม่ติดไปกับผู้ใช้คนถัดไป
    clearRecovery(window.sessionStorage, tenantAlias);
    return (
      <Status
        title="Journey authoring"
        detail="เข้าสู่ระบบก่อนแก้ไข Journey"
        action={() => void auth.signinRedirect()}
      />
    );
  }
  const session = String(auth.user?.profile.sid ?? auth.user?.profile.sub ?? 'session');
  return (
    <ConsoleShell
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="journeys"
    >
      <JourneyAuthoringConsole
        api={api}
        scope={`${tenantAlias}:${session}`}
        initialJourneyId={new URL(window.location.href).searchParams.get('journey') ?? undefined}
      />
    </ConsoleShell>
  );
}
