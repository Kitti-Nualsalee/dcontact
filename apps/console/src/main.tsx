import { VoiceRoutingPage } from './voice-routing/voice-routing-page.js';
import { TenantPeoplePage } from './tenant-people/tenant-people.js';
import { createPeopleApi } from './tenant-people/api.js';
import { createCatalogApi } from './voice-routing/api.js';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { AuthProvider } from 'react-oidc-context';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { createRoot } from 'react-dom/client';
import { ConsoleAuthRoot, HistorySurface } from './auth-root.js';
import { ConsoleApp } from './console-app.js';
import { createConsoleApi } from './console-api.js';
import { GovernancePage } from './governance-page.js';
import { createGovernanceApi } from './governance-api.js';
import { createCg5ConsoleApi } from './cg5-console-api.js';
import { parseGovernanceLocation, type GovernanceViewer } from './governance-model.js';
import { PreferenceCenter } from './preference-center.js';
import { createJourneyAuthoringApi } from './journey-authoring/api.js';
import { createUatApi } from './journey-authoring/uat-api.js';
import { resolveConsoleView } from './auth-session.js';
import { JourneyAuthoringConsole } from './journey-authoring/journey-authoring.js';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { shellUserFromClaims } from '@d-contact/ui-react';
import { appI18n } from './i18n/index.js';
import { LocaleProbe } from './i18n/locale-probe.js';
import { ConsoleHome } from './home/home.js';
import { ConsoleShell } from './shell/console-shell.js';
import { createEmbedOriginApi } from './dphone-embedding/api.js';
import { DphoneEmbedding } from './dphone-embedding/dphone-embedding.js';
import { createTeamScopeApi } from './team-scopes/api.js';
import { createLineInboundApi } from './line-inbound/api.js';
import { LineInbound } from './line-inbound/line-inbound.js';
import { createAccountApi, createAccountPolicyApi } from './account/api.js';
import { AccountPage, AccountPolicyPage } from './account/account.js';
import { stashVerifyToken } from './account/model.js';
import './style.css';

// AC5 (#598): ลิงก์ยืนยัน email — ย้าย token ออกจาก URL/history ก่อน render และก่อน login redirect
if (new URL(window.location.href).searchParams.get('view') === 'account') {
  stashVerifyToken(new URL(window.location.href), window.sessionStorage, window.history);
}

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
createRoot(root).render(
  <StrictMode>
    {import.meta.env.MODE === 'e2e' ? (
      <SessionLocaleProvider i18n={appI18n}>
        <ConsoleE2eRoot />
      </SessionLocaleProvider>
    ) : (
      <ConsoleAuthRoot />
    )}
  </StrictMode>,
);

// #588: ผู้ใช้จำลองของเมนูผู้ใช้ — การออกจากระบบนับใน `window.__signOuts` ให้ spec ตรวจ
function e2eShellUser(tenantAlias: string | undefined) {
  return {
    account: {
      user: shellUserFromClaims(
        {
          name: 'ผู้ทดสอบ คอนโซล',
          email: 'console-e2e@demo.example',
          realm_access: { roles: ['admin', 'offline_access'] },
        },
        tenantAlias,
      ),
      // `?signout=fail` จำลอง redirect ไปออกจากระบบไม่สำเร็จ
      onSignOut: async () => {
        const w = window as unknown as { __signOuts?: number };
        w.__signOuts = (w.__signOuts ?? 0) + 1;
        if (new URL(window.location.href).searchParams.get('signout') === 'fail') {
          throw new Error('signout failed');
        }
      },
    },
  };
}

function HistoryE2eRoot() {
  const url = new URL(window.location.href);
  const [identity, setIdentity] = useState('first');
  const manager = useMemo(
    () =>
      new UserManager({
        authority: 'https://synthetic-idp.example',
        client_id: 'history-e2e',
        redirect_uri: window.location.origin,
        automaticSilentRenew: false,
        monitorSession: false,
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      }),
    [],
  );
  useEffect(() => {
    const user = new User({
      access_token: `e2e-${identity}`,
      token_type: 'Bearer',
      profile: {
        iss: 'https://synthetic-idp.example',
        aud: 'history-e2e',
        sub: identity,
        exp: 2000000000,
        iat: 1700000000,
        tenant_slug: url.searchParams.get('tenant') ?? 'demo',
        tenant_id: 'synthetic-tenant',
        dc_user_id: identity,
      },
    });
    void manager.storeUser(user).then(() => manager.events.load(user));
  }, [manager, identity]);
  return (
    <>
      {url.searchParams.has('identityHarness') ? (
        <button onClick={() => setIdentity('second')}>Switch identity fixture</button>
      ) : null}
      <AuthProvider userManager={manager} skipSigninCallback>
        <HistorySurface
          apiBaseUrl={window.location.origin}
          tenantAlias={url.searchParams.get('tenant') ?? 'demo'}
        />
      </AuthProvider>
    </>
  );
}

function ConsoleE2eRoot() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('authRootHarness')) return <ConsoleAuthRoot />;
  const contextId = url.searchParams.get('context');
  const contactId = url.searchParams.get('contactId');
  const api = createConsoleApi({
    baseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
    accessToken: () => 'e2e-access-token',
  });
  // กติกาเดียวกับ ConsoleAuthRoot: ไม่มี view/context เปิด Home
  const view = resolveConsoleView(
    url,
    import.meta.env.VITE_CONSOLE_DEFAULT_VIEW as string | undefined,
  );
  if (view === 'home')
    return (
      <ConsoleShell
        {...e2eShellUser(url.searchParams.get('tenant') ?? undefined)}
        apiBaseUrl={
          (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin
        }
        accessToken={() => 'e2e-access-token'}
        tenantAlias={url.searchParams.get('tenant') ?? undefined}
        appId="home"
      >
        {(navigation) => <ConsoleHome navigation={navigation} />}
      </ConsoleShell>
    );
  if (view === 'i18n') return <LocaleProbe />;
  if (view === 'voice-routing')
    return (
      <VoiceRoutingPage
        shell={{
          ...e2eShellUser(url.searchParams.get('tenant') ?? undefined),
          apiBaseUrl: window.location.origin,
          accessToken: () => 'e2e-access-token',
          tenantAlias: url.searchParams.get('tenant') ?? undefined,
        }}
        api={createCatalogApi({
          baseUrl: window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        identityKey="e2e-voice"
      />
    );
  if (view === 'agent-history') return <HistoryE2eRoot />;
  if (view === 'tenant-people')
    return (
      <TenantPeoplePage
        shell={{
          ...e2eShellUser(url.searchParams.get('tenant') ?? undefined),
          apiBaseUrl: window.location.origin,
          accessToken: () => 'e2e-access-token',
          tenantAlias: url.searchParams.get('tenant') ?? undefined,
        }}
        api={createPeopleApi({
          baseUrl: window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        identityKey="e2e-people"
      />
    );
  if (view === 'dphone-embedding') {
    // viewer จาก query ใช้ได้เฉพาะ e2e harness; production อ่าน role จาก token
    return (
      <ConsoleShell
        {...e2eShellUser(url.searchParams.get('tenant') ?? undefined)}
        apiBaseUrl={
          (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin
        }
        accessToken={() => 'e2e-access-token'}
        tenantAlias={url.searchParams.get('tenant') ?? 'demo'}
        appId="dphone-embedding"
      >
        <DphoneEmbedding
          api={createEmbedOriginApi({
            baseUrl:
              (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
            accessToken: () => 'e2e-access-token',
          })}
          canEdit={url.searchParams.get('viewer') !== 'SUPERVISOR'}
          tenantAlias={url.searchParams.get('tenant') ?? 'demo'}
          embedBaseUrl="https://api.dcontact.test"
          dev={false}
          teamScopes={createTeamScopeApi({
            baseUrl:
              (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
            accessToken: () => 'e2e-access-token',
          })}
        />
      </ConsoleShell>
    );
  }
  if (view === 'account' || view === 'account-policy') {
    const baseUrl =
      (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;
    // บทบาทจาก query ใช้ได้เฉพาะ e2e harness; production อ่าน role จาก token
    const admin = url.searchParams.get('viewer') !== 'AGENT';
    const shell = e2eShellUser(url.searchParams.get('tenant') ?? undefined);
    if (!admin) shell.account.user = { ...shell.account.user, roles: ['agent'] };
    return (
      <ConsoleShell
        {...shell}
        apiBaseUrl={baseUrl}
        accessToken={() => 'e2e-access-token'}
        tenantAlias={url.searchParams.get('tenant') ?? 'demo'}
        appId={view}
      >
        {view === 'account' ? (
          <AccountPage
            api={createAccountApi({ baseUrl, accessToken: () => 'e2e-access-token' })}
            verifyStorage={window.sessionStorage}
          />
        ) : (
          <AccountPolicyPage
            api={createAccountPolicyApi({ baseUrl, accessToken: () => 'e2e-access-token' })}
            canEdit={admin}
          />
        )}
      </ConsoleShell>
    );
  }
  if (view === 'line-inbound') {
    // #566/#567: หน้า LINE inbound ของ pilot — e2e harness ใช้ API จำลองที่ VITE_API_BASE_URL
    return (
      <ConsoleShell
        {...e2eShellUser(url.searchParams.get('tenant') ?? undefined)}
        apiBaseUrl={
          (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin
        }
        accessToken={() => 'e2e-access-token'}
        tenantAlias={url.searchParams.get('tenant') ?? undefined}
        appId="journeys"
      >
        <LineInbound
          api={createLineInboundApi({
            baseUrl:
              (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
            accessToken: () => 'e2e-access-token',
          })}
        />
      </ConsoleShell>
    );
  }
  if (view === 'journeys') {
    return (
      <ConsoleShell
        {...e2eShellUser(url.searchParams.get('tenant') ?? undefined)}
        apiBaseUrl={
          (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin
        }
        accessToken={() => 'e2e-access-token'}
        tenantAlias={url.searchParams.get('tenant') ?? undefined}
        appId="journeys"
      >
        <JourneyAuthoringConsole
          api={createJourneyAuthoringApi({
            baseUrl:
              (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
            accessToken: () => 'e2e-access-token',
          })}
          uatApi={createUatApi({
            baseUrl:
              (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
            accessToken: () => 'e2e-access-token',
          })}
          scope="e2e"
          initialJourneyId={url.searchParams.get('journey') ?? undefined}
        />
      </ConsoleShell>
    );
  }
  if (view === 'governance') {
    // viewer จาก query ใช้ได้เฉพาะ e2e harness; production อ่าน role จาก token เท่านั้น
    const requested = url.searchParams.get('viewer');
    const viewer: GovernanceViewer =
      requested === 'SUPERVISOR' || requested === 'TENANT_ADMIN' ? requested : 'COMPLIANCE';
    // #654/#658: ครอบด้วย ConsoleShell เหมือนหน้าอื่น — flag ปิด/API ล้ม = หน้าเดิมทุกประการ (fail-safe)
    return (
      <GovernancePage
        shell={{
          ...e2eShellUser(url.searchParams.get('tenant') ?? undefined),
          apiBaseUrl:
            (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
          accessToken: () => 'e2e-access-token',
          tenantAlias: url.searchParams.get('tenant') ?? undefined,
        }}
        api={createGovernanceApi({
          baseUrl:
            (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        cg5Api={createCg5ConsoleApi({
          baseUrl:
            (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
          accessToken: () => 'e2e-access-token',
        })}
        viewer={viewer}
        initialLocation={parseGovernanceLocation(url)}
      />
    );
  }
  return view === 'preferences' && contactId ? (
    <PreferenceCenter api={api} contactId={contactId} viewer="ADMIN" />
  ) : contextId ? (
    <ConsoleApp api={api} contextId={contextId} />
  ) : (
    <main className="empty">missing context</main>
  );
}
