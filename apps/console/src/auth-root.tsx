import { VoiceRouting } from './voice-routing/voice-routing.js';
import { createCatalogApi } from './voice-routing/api.js';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth, type AuthContextProps } from 'react-oidc-context';
import { Button, shellUserFromClaims } from '@d-contact/ui-react';
import { SessionLocaleProvider, useTranslation } from '@d-contact/i18n/react';
import { appI18n } from './i18n/index.js';
import { createEmbedOriginApi } from './dphone-embedding/api.js';
import { AgentHistory } from './agent-history/agent-history.js';
import { createAgentHistoryApi } from './agent-history/api.js';
import { DphoneEmbedding } from './dphone-embedding/dphone-embedding.js';
import { createAccountApi, createAccountPolicyApi } from './account/api.js';
import { AccountPage, AccountPolicyPage } from './account/account.js';
import { createTeamScopeApi } from './team-scopes/api.js';
import { ConsoleHome } from './home/home.js';
import { ConsoleShell } from './shell/console-shell.js';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import { GovernancePage } from './governance-page.js';
import { createGovernanceApi } from './governance-api.js';
import { createCg5ConsoleApi } from './cg5-console-api.js';
import { parseGovernanceLocation, type GovernanceViewer } from './governance-model.js';
import { PreferenceCenter } from './preference-center.js';
import { createJourneyAuthoringApi } from './journey-authoring/api.js';
import { createUatApi } from './journey-authoring/uat-api.js';
import { createLineInboundApi } from './line-inbound/api.js';
import { LineInbound, LineInboundLink } from './line-inbound/line-inbound.js';
import { JourneyAuthoringConsole } from './journey-authoring/journey-authoring.js';
import { clearRecovery } from './journey-authoring/state.js';
import {
  accessTokenRealmRoles,
  clearConsoleSignOut,
  consumeConsoleReturnLocation,
  createConsoleOidcSettings,
  isConsoleSignedOutLanding,
  rememberConsoleReturnUrl,
  rememberConsoleSignOut,
  resolveConsoleContextId,
  resolveConsoleLocation,
  resolveConsoleView,
  resolveTenantAlias,
} from './auth-session.js';

function signInFromCurrentPage(auth: AuthContextProps) {
  clearConsoleSignOut(window.sessionStorage);
  rememberConsoleReturnUrl(new URL(window.location.href), window.sessionStorage);
  return auth.signinRedirect();
}

/**
 * #677: หน้าที่ Keycloak พากลับมาหลัง sign-out — บอกสถานะและให้เข้าสู่ระบบอีกครั้ง
 * ไม่จำ URL ใหม่ (หน้านี้ไม่มี view) ให้ callback พากลับหน้าที่จำไว้ก่อน sign-out
 */
function SignedOutSurface() {
  const auth = useAuth();
  const { t } = useTranslation('common');
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <main className="empty">
        <h1>{t('auth.signedOut.title')}</h1>
      </main>
    );
  return (
    <main className="empty">
      <h1>{t('auth.signedOut.title')}</h1>
      <p>{t('auth.signedOut.detail')}</p>
      <button
        className="primary"
        onClick={() => {
          clearConsoleSignOut(window.sessionStorage);
          void auth.signinRedirect();
        }}
      >
        {t('auth.signedOut.action')}
      </button>
    </main>
  );
}

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
        action={() => void signInFromCurrentPage(auth)}
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
  // #676: บน callback ของ OIDC ใช้ URL ปลายทางที่จำไว้ เพราะ `redirect_uri` ไม่มี view/context
  const url = resolveConsoleLocation(new URL(window.location.href), window.sessionStorage);
  // #677: กลับมาหลัง sign-out (ไม่มี view/context) — มาก่อน default view เพื่อไม่ให้ไปหน้าที่ไม่ได้เลือก
  const signedOut = isConsoleSignedOutLanding(url, window.sessionStorage);
  // #684: ไม่มี view/context → Home; argument ของ deployment เก่าไม่เปลี่ยน default ใหม่
  const defaultView = import.meta.env.VITE_CONSOLE_DEFAULT_VIEW as string | undefined;
  const [view, setView] = useState(() => resolveConsoleView(url, defaultView));
  const homeView = view === 'home';
  const preferenceView = view === 'preferences';
  const governanceView = view === 'governance';
  const journeyView = view === 'journeys';
  const embeddingView = view === 'dphone-embedding';
  const routingView = view === 'voice-routing';
  // #566: read-only ของ LINE pilot — มีเฉพาะ UAT ที่ใส่ overlay `uat-line` (ไม่มี = หน้าแจ้งว่าไม่ได้เปิด)
  const lineInboundView = view === 'line-inbound';
  // AC5 (#598): บัญชีของฉัน (ทุก role) และนโยบายบัญชี (admin)
  const accountView = view === 'account' || view === 'account-policy';
  const contactId = preferenceView ? (url.searchParams.get('contactId') ?? undefined) : undefined;
  try {
    tenantAlias = resolveTenantAlias(url);
    contextId =
      signedOut ||
      homeView ||
      preferenceView ||
      governanceView ||
      journeyView ||
      embeddingView ||
      routingView ||
      lineInboundView ||
      accountView
        ? undefined
        : resolveConsoleContextId(url);
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
    <AuthProvider
      {...settings}
      onSigninCallback={() => {
        clearConsoleSignOut(window.sessionStorage);
        const restored = consumeConsoleReturnLocation(
          new URL(window.location.href),
          window.sessionStorage,
          defaultView,
        );
        window.history.replaceState(null, '', restored.url);
        setView(restored.view);
      }}
    >
      <ConsoleLocale apiBaseUrl={apiBaseUrl} issuer={issuer}>
        {signedOut ? (
          <SignedOutSurface />
        ) : homeView ? (
          <HomeSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : routingView ? (
          <VoiceRoutingSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : view === 'agent-history' ? (
          <HistorySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : accountView ? (
          <AccountSurface
            apiBaseUrl={apiBaseUrl}
            tenantAlias={tenantAlias}
            policy={view === 'account-policy'}
          />
        ) : journeyView ? (
          <JourneySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : lineInboundView ? (
          <LineInboundSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
        ) : embeddingView ? (
          <DphoneEmbeddingSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
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

/** #588: เมนูผู้ใช้บนแถบบนของ shell — ข้อมูลจาก claims ของ token ใช้แสดงผลอย่างเดียว */
function shellUserProps(auth: AuthContextProps, tenantAlias: string) {
  return {
    account: {
      user: shellUserFromClaims(auth.user?.profile ?? {}, tenantAlias),
      onSignOut: () => {
        rememberConsoleSignOut(new URL(window.location.href), window.sessionStorage);
        return auth.signoutRedirect();
      },
    },
  };
}

export function HistorySurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('history');
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createAgentHistoryApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
    [apiBaseUrl],
  );
  if (auth.isLoading)
    return (
      <main className="empty" aria-busy="true">
        {t('loading')}
      </main>
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <main className="empty">
        <p>{t('unauthorized')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile?.iss !== auth.settings.authority ||
    profile?.tenant_slug !== tenantAlias ||
    !identity.every((field) => typeof field === 'string' && field.length > 0)
  ) {
    return (
      <main className="empty" role="alert">
        {t('forbidden')}
      </main>
    );
  }
  const identityKey = JSON.stringify(identity);
  return (
    <ConsoleShell
      key={identityKey}
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="agent-history"
    >
      <AgentHistory
        api={api}
        identityKey={identityKey}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}

function HomeSurface({ apiBaseUrl, tenantAlias }: { apiBaseUrl: string; tenantAlias: string }) {
  const auth = useAuth();
  const { t } = useTranslation('home');
  const { t: commonText } = useTranslation();
  const accessToken = auth.user?.access_token;
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <main className="empty" aria-busy="true">
        <p>{t('loading')}</p>
      </main>
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <main className="empty">
        <h1>{commonText('app.name')}</h1>
        <p>{t('signInDetail')}</p>
        <button className="primary" onClick={() => void signInFromCurrentPage(auth)}>
          {t('signIn')}
        </button>
      </main>
    );
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="home"
    >
      {(navigation) => <ConsoleHome navigation={navigation} />}
    </ConsoleShell>
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
  const roles = accessTokenRealmRoles(auth.user?.access_token);
  const viewer = roles.includes('compliance')
    ? 'COMPLIANCE'
    : roles.includes('admin')
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
        action={() => void signInFromCurrentPage(auth)}
      />
    );
  const roles = accessTokenRealmRoles(accessToken);
  const viewer: GovernanceViewer = roles.includes('compliance')
    ? 'COMPLIANCE'
    : roles.includes('admin')
      ? 'TENANT_ADMIN'
      : 'SUPERVISOR';
  return (
    <GovernancePage
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => accessToken,
        tenantAlias,
      }}
      api={api}
      cg5Api={cg5Api}
      viewer={viewer}
      initialLocation={parseGovernanceLocation(new URL(window.location.href))}
    />
  );
}

/**
 * E1.11 (#485): Integrations › dphone embedding — ADMIN แก้ได้ (สิทธิ์จริงตัดสินที่ API ทุก request)
 */
function DphoneEmbeddingSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createEmbedOriginApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  const teamScopes = useMemo(
    () => createTeamScopeApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <Status
        title="dphone embedding"
        detail="เข้าสู่ระบบก่อนจัดการ origin ที่ฝัง dphone"
        action={() => void signInFromCurrentPage(auth)}
      />
    );
  const roles = accessTokenRealmRoles(accessToken);
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="dphone-embedding"
    >
      <DphoneEmbedding
        api={api}
        canEdit={roles.includes('admin')}
        tenantAlias={tenantAlias}
        embedBaseUrl={apiBaseUrl || window.location.origin}
        dev={import.meta.env.DEV}
        docsUrl={import.meta.env.VITE_DPHONE_EMBED_DOCS_URL as string | undefined}
        teamScopes={teamScopes}
      />
    </ConsoleShell>
  );
}

/** #566: สิทธิ์ (role admin ของ tenant pilot) ตัดสินที่ `line-webhook` — Console แสดงผลตาม status เท่านั้น */
function LineInboundSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createLineInboundApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <Status
        title="LINE inbound (pilot)"
        detail="เข้าสู่ระบบก่อนดูข้อความขาเข้า"
        action={() => void signInFromCurrentPage(auth)}
      />
    );
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="journeys"
    >
      <LineInbound api={api} />
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
  const uatApi = useMemo(
    () => createUatApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  const lineInboundApi = useMemo(
    () => createLineInboundApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
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
        action={() => void signInFromCurrentPage(auth)}
      />
    );
  }
  const session = String(auth.user?.profile.sid ?? auth.user?.profile.sub ?? 'session');
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="journeys"
    >
      <LineInboundLink
        api={lineInboundApi}
        href={`/?tenant=${encodeURIComponent(tenantAlias)}&view=line-inbound`}
      />
      <JourneyAuthoringConsole
        api={api}
        uatApi={uatApi}
        uatDefaults={{
          environment: import.meta.env.VITE_UAT_ENVIRONMENT as string | undefined,
          packVersion: import.meta.env.VITE_UAT_PACK_VERSION as string | undefined,
        }}
        onSignInAgain={() => void signInFromCurrentPage(auth)}
        scope={`${tenantAlias}:${session}`}
        initialJourneyId={new URL(window.location.href).searchParams.get('journey') ?? undefined}
      />
    </ConsoleShell>
  );
}

/**
 * AC5 (#598): บัญชีของฉัน / นโยบายบัญชี — token ยืนยัน email ถูกย้ายออกจาก URL ใน main.tsx ก่อน render
 * (จึงไม่ติดไปกับ return URL ของ login) และหน้าอ่านจาก sessionStorage ครั้งเดียว
 */
function AccountSurface({
  apiBaseUrl,
  tenantAlias,
  policy,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
  policy: boolean;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const accountApi = useMemo(
    () => createAccountApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  const policyApi = useMemo(
    () => createAccountPolicyApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading)
    return (
      <Status title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ Console session" />
    );
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return (
      <Status
        title="D-Contact"
        detail="เข้าสู่ระบบก่อนจัดการบัญชีของคุณ"
        action={() => void signInFromCurrentPage(auth)}
      />
    );
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId={policy ? 'account-policy' : 'account'}
    >
      {policy ? (
        <AccountPolicyPage
          api={policyApi}
          canEdit={accessTokenRealmRoles(accessToken).includes('admin')}
        />
      ) : (
        <AccountPage api={accountApi} verifyStorage={window.sessionStorage} />
      )}
    </ConsoleShell>
  );
}

export function VoiceRoutingSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('voiceRouting');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCatalogApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  if (auth.isLoading) return <main aria-busy="true">{t('loading')}</main>;
  if (auth.error || !auth.isAuthenticated || !token)
    return (
      <main>
        <p>{t('errors.UNAUTHORIZED')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile?.iss !== auth.settings.authority ||
    profile?.tenant_slug !== tenantAlias ||
    !identity.every((x) => typeof x === 'string' && x.length > 0)
  )
    return <main role="alert">{t('errors.FORBIDDEN')}</main>;
  const identityKey = JSON.stringify(identity);
  return (
    <ConsoleShell
      key={identityKey}
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => tokenRef.current}
      tenantAlias={tenantAlias}
      appId="voice-routing"
    >
      <VoiceRouting
        api={api}
        identityKey={identityKey}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}
