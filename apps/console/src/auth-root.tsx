import { CustomerActivityPage } from './customer-activity/customer-activity-page.js';
import { createCustomerActivityApi } from './customer-activity/api.js';
import { CustomerOverviewPage } from './customer-overview/customer-overview-page.js';
import { createCustomerOverviewApi } from './customer-overview/api.js';
import { clearCoreCommandReferences } from './core-settings/storage.js';
import { CoreSettingsPage } from './core-settings/core-settings-page.js';
import { createCoreApi } from './core-settings/api.js';
import { VoiceRoutingPage } from './voice-routing/voice-routing-page.js';
import { TenantPeoplePage } from './tenant-people/tenant-people.js';
import { createPeopleApi } from './tenant-people/api.js';
import { CustomersPage } from './customers/customers-page.js';
import { createCustomersApi } from './customers/api.js';
import { CustomerTagsPage } from './customer-tags/customer-tags-page.js';
import { createCustomerTagsApi } from './customer-tags/api.js';
import { CustomerImportPage } from './customer-import/customer-import-page.js';
import { createCustomerImportApi } from './customer-import/api.js';
import { CustomerAccessPage } from './customer-access/customer-access-page.js';
import { createCatalogApi } from './voice-routing/api.js';
import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth, type AuthContextProps } from 'react-oidc-context';
import { Button, shellUserFromClaims } from '@d-contact/ui-react';
import { SessionLocaleProvider, useTranslation } from '@d-contact/i18n/react';
import { appI18n } from './i18n/index.js';
import { createEmbedOriginApi } from './dphone-embedding/api.js';
import { AgentHistory } from './agent-history/agent-history.js';
import { createAgentHistoryApi } from './agent-history/api.js';
import { CasesPage } from './cases/cases-page.js';
import { createTeamRecordingsApi } from './team-recordings/api.js';
import { TeamRecordings } from './team-recordings/team-recordings.js';
import { createTeamHistoryApi } from './team-history/api.js';
import { TeamHistory } from './team-history/team-history.js';
import { createQualityApi } from './quality/api.js';
import { MyQuality } from './quality/my-quality.js';
import { QmForms } from './quality/qm-forms.js';
import { TeamEvaluations } from './quality/team-evaluations.js';
import { createCasesApi } from './cases/api.js';
import { DphoneEmbedding } from './dphone-embedding/dphone-embedding.js';
import { createWebchatApi } from './webchat/api.js';
import { WebchatSettingsPage } from './webchat/webchat-settings.js';
import { createLineApi } from './line-channel/api.js';
import { LineSettingsPage } from './line-channel/line-settings.js';
import { createAccountApi, createAccountPolicyApi } from './account/api.js';
import { AccountPage, AccountPolicyPage } from './account/account.js';
import { createTeamScopeApi } from './team-scopes/api.js';
import { ConsoleHome } from './home/home.js';
import { ConsoleShell } from './shell/console-shell.js';
import { ConsoleNavigationProvider, useConsoleRouter } from './shell/console-navigation.js';
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
  shouldRestoreConsoleSession,
  rememberConsoleReturnUrl,
  rememberConsoleSignOut,
  resolveConsoleContextId,
  resolveConsoleLocation,
  resolveConsoleView,
  resolveTenantAlias,
} from './auth-session.js';

function signInFromCurrentPage(auth: AuthContextProps) {
  clearConsoleSignOut(window.sessionStorage);
  rememberConsoleReturnUrl(
    resolveConsoleLocation(new URL(window.location.href), window.sessionStorage),
    window.sessionStorage,
  );
  return auth.signinRedirect();
}

/**
 * #677: the page Keycloak returns to after sign-out — reports the state and lets the user sign in again.
 * It does not remember a new URL (this page has no view); the callback returns to the page remembered before sign-out.
 */
function SignedOutSurface() {
  useEffect(() => {
    clearCoreCommandReferences();
  }, []);
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
  const { t } = useTranslation('common');
  return (
    <main className="empty">
      <h1>{title}</h1>
      <p>{detail}</p>
      {action ? (
        <button className="primary" onClick={action}>
          {t('auth.signIn')}
        </button>
      ) : null}
    </main>
  );
}

function SigningIn() {
  const { t } = useTranslation('common');
  return <Status title={t('auth.signingIn.title')} detail={t('auth.signingIn.detail')} />;
}

type SignInSurface =
  | 'qm'
  | 'governance'
  | 'dphoneEmbedding'
  | 'webchat'
  | 'line'
  | 'lineInbound'
  | 'journeys'
  | 'account';

function SignInRequired({ surface, auth }: { surface: SignInSurface; auth: AuthContextProps }) {
  const { t } = useTranslation('common');
  return (
    <Status
      title={t(`auth.required.${surface}.title`)}
      detail={t(`auth.required.${surface}.detail`)}
      action={() => void signInFromCurrentPage(auth)}
    />
  );
}

/**
 * userStore lives in memory: SSO is restored at boot through a top-level prompt=none.
 * Console sends X-Frame-Options: DENY, so the root callback cannot be used inside an iframe.
 * A callback (including login_required) does not start a new round; same-page reauth is not part of this bootstrap.
 */
function ConsoleSessionBootstrap({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { t } = useTranslation('common');
  const [eligible] = useState(() =>
    shouldRestoreConsoleSession(new URL(window.location.href), window.sessionStorage),
  );
  const attempted = useRef(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (auth.isLoading || auth.activeNavigator) return;
    if (!eligible || auth.isAuthenticated || auth.error) {
      attempted.current = true;
      setSettled(true);
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    rememberConsoleReturnUrl(new URL(window.location.href), window.sessionStorage);
    void auth
      .signinRedirect({ prompt: 'none', redirectMethod: 'replace' })
      .catch(() => setSettled(true));
  }, [
    eligible,
    auth.isLoading,
    auth.activeNavigator,
    auth.isAuthenticated,
    auth.error,
    auth.signinRedirect,
  ]);
  if (!settled && !auth.isAuthenticated)
    return <Status title={t('auth.restoring.title')} detail={t('auth.restoring.detail')} />;
  return <>{children}</>;
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
  const { t } = useTranslation('common');
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createConsoleApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="qm" auth={auth} />;
  if (contactId) return <PreferenceCenter api={api} contactId={contactId} viewer={viewer} />;
  if (contextId) return <ConsoleApp api={api} contextId={contextId} />;
  return <Status title={t('auth.notFound.title')} detail={t('auth.notFound.detail')} />;
}

export function ConsoleAuthRoot() {
  const { t } = useTranslation('common');
  const issuer = import.meta.env.VITE_KC_ISSUER as string | undefined;
  const clientId = import.meta.env.VITE_KC_CLIENT_ID as string | undefined;
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  let tenantAlias: string;
  let contextId: string | undefined;
  // #676: on an OIDC callback use the remembered destination URL, because `redirect_uri` has no view/context
  const url = resolveConsoleLocation(new URL(window.location.href), window.sessionStorage);
  // #677: returning after sign-out (no view/context) — comes before the default view so an unselected page is not opened
  const signedOut = isConsoleSignedOutLanding(url, window.sessionStorage);
  // #684: no view/context → Home; an argument from an older deployment does not change the new default
  const defaultView = import.meta.env.VITE_CONSOLE_DEFAULT_VIEW as string | undefined;
  const [view, setView] = useState(() => resolveConsoleView(url, defaultView));
  const [routeRevision, setRouteRevision] = useState(0);
  const navigate = useConsoleRouter(
    (next) => {
      setView(resolveConsoleView(next, defaultView));
      setRouteRevision((revision) => revision + 1);
    },
    () => window.confirm(appI18n.t('shell.discardChanges')),
  );
  const homeView = view === 'home';
  const historyView = view === 'agent-history';
  // #956: team cases (list + detail `&case=<id>`)
  const casesView = view === 'team-cases';
  // #967: team call recordings for Supervisor
  const recordingsView = view === 'team-recordings';
  // #986: team work history and summary (Supervisor for own team, Admin for all teams)
  const teamHistoryView = view === 'team-history';
  // #971: quality evaluation (Supervisor), my scores (Agent), evaluation forms (Admin)
  const qualityApp = QUALITY_APPS.find((app) => app === view);
  const preferenceView = view === 'preferences';
  const governanceView = view === 'governance';
  const journeyView = view === 'journeys';
  const embeddingView = view === 'dphone-embedding';
  // #1044: Customer channels › Web Chat (Admin edits, Supervisor reads)
  const webchatView = view === 'webchat-settings';
  // #1054: Customer channels › LINE (Admin edits, Supervisor reads)
  const lineView = view === 'line-settings';
  const routingView = view === 'voice-routing';
  const peopleView = view === 'tenant-people';
  const coreSettingsView = view === 'core-settings';
  // Cus360 C2 (#792): Customers + profile (read-only)
  const customersView = view === 'customers';
  const customerTagsView = view === 'customer-tags';
  const customerImportView = view === 'customer-import';
  const customerAccessView = view === 'customer-access';
  const customerActivityView = view === 'customer-activity';
  const customerOverviewView = view === 'customer-overview' || view === 'customer-rules';
  // #566: read-only LINE pilot — UAT only, where the `uat-line` overlay is applied (without it, a page says it is not enabled)
  const lineInboundView = view === 'line-inbound';
  // AC5 (#598): my account (every role) and account policy (admin)
  const accountView = view === 'account' || view === 'account-policy';
  const contactId = preferenceView ? (url.searchParams.get('contactId') ?? undefined) : undefined;
  try {
    tenantAlias = resolveTenantAlias(url);
    contextId =
      signedOut ||
      homeView ||
      historyView ||
      casesView ||
      recordingsView ||
      teamHistoryView ||
      !!qualityApp ||
      preferenceView ||
      governanceView ||
      journeyView ||
      embeddingView ||
      webchatView ||
      lineView ||
      routingView ||
      peopleView ||
      customersView ||
      customerTagsView ||
      customerImportView ||
      customerAccessView ||
      customerOverviewView ||
      customerActivityView ||
      coreSettingsView ||
      lineInboundView ||
      accountView
        ? undefined
        : resolveConsoleContextId(url);
  } catch {
    return (
      <Status title={t('auth.contextMissing.title')} detail={t('auth.contextMissing.detail')} />
    );
  }
  if (!issuer || !clientId)
    return <Status title={t('auth.idpMissing.title')} detail={t('auth.idpMissing.detail')} />;
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
      <ConsoleSessionBootstrap>
        <ConsoleLocale apiBaseUrl={apiBaseUrl} issuer={issuer}>
          <ConsoleNavigationProvider value={navigate} key={routeRevision}>
            {signedOut ? (
              <SignedOutSurface />
            ) : homeView ? (
              <HomeSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : coreSettingsView ? (
              <CoreSettingsSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : routingView ? (
              <VoiceRoutingSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : peopleView ? (
              <TenantPeopleSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : customersView ? (
              <CustomersSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : customerOverviewView ? (
              <CustomerOverviewSurface
                apiBaseUrl={apiBaseUrl}
                tenantAlias={tenantAlias}
                mode={view === 'customer-rules' ? 'rules' : 'overview'}
              />
            ) : customerActivityView ? (
              <CustomerActivitySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : customerTagsView ? (
              <CustomerTagsSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : customerImportView ? (
              <CustomerImportSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : customerAccessView ? (
              <CustomerAccessSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : historyView ? (
              <HistorySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : casesView ? (
              <CasesSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : recordingsView ? (
              <RecordingsSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : teamHistoryView ? (
              <TeamHistorySurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : qualityApp ? (
              <QualitySurface app={qualityApp} apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
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
            ) : webchatView ? (
              <WebchatSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : lineView ? (
              <LineSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : governanceView ? (
              <GovernanceSurface apiBaseUrl={apiBaseUrl} tenantAlias={tenantAlias} />
            ) : (
              <ConsoleSurface apiBaseUrl={apiBaseUrl} contextId={contextId} contactId={contactId} />
            )}
          </ConsoleNavigationProvider>
        </ConsoleLocale>
      </ConsoleSessionBootstrap>
    </AuthProvider>
  );
}

/**
 * D1.11 (#450): language/timezone in the order user → tenant → browser → th — before login the browser language is used.
 * When the user changes language it is saved to the Keycloak attribute `locale` with the user's own token.
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

/** #588: user menu on the shell top bar — data from the token claims, used for display only */
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

export function CasesSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('cases');
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createCasesApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
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
        {t('noTeam')}
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
      appId="team-cases"
    >
      <CasesPage
        api={api}
        identityKey={identityKey}
        viewerUserId={profile.dc_user_id as string}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}

export const QUALITY_APPS = ['team-evaluations', 'my-quality', 'qm-forms'] as const;
export type QualityApp = (typeof QUALITY_APPS)[number];

/** #971: the three quality evaluation pages share one client and the same identity check; real permission is checked at the API */
export function QualitySurface({
  app,
  apiBaseUrl,
  tenantAlias,
}: {
  app: QualityApp;
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('quality');
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createQualityApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
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
  const onSignIn = () => void signInFromCurrentPage(auth);
  const Page =
    app === 'team-evaluations' ? TeamEvaluations : app === 'my-quality' ? MyQuality : QmForms;
  return (
    <ConsoleShell
      key={identityKey}
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId={app}
    >
      <Page api={api} identityKey={identityKey} onSignIn={onSignIn} />
    </ConsoleShell>
  );
}

export function RecordingsSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('recordings');
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createTeamRecordingsApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
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
      appId="team-recordings"
    >
      <TeamRecordings
        api={api}
        identityKey={identityKey}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}

export function TeamHistorySurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('teamHistory');
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createTeamHistoryApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
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
      appId="team-history"
    >
      <TeamHistory
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
 * CG4.9 (#192): the viewer comes from the role in the token only to hide buttons known to be rejected — real permission is
 * re-authorized at the API on every command, and the evidence visibility level comes from server-side capabilities
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
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="governance" auth={auth} />;
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
 * E1.11 (#485): Integrations › dphone embedding — ADMIN can edit (real permission is decided at the API on every request)
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
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="dphoneEmbedding" auth={auth} />;
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

/** #1044: Web Chat settings — the API says whether this user can edit (`canEdit`) and answers 403 to other roles */
function WebchatSurface({ apiBaseUrl, tenantAlias }: { apiBaseUrl: string; tenantAlias: string }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createWebchatApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
    [apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="webchat" auth={auth} />;
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="webchat-settings"
    >
      <WebchatSettingsPage
        api={api}
        apiBaseUrl={apiBaseUrl}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}

/** #1054: LINE settings — the API says whether this user can edit (`canEdit`) and answers 403 to other roles */
function LineSurface({ apiBaseUrl, tenantAlias }: { apiBaseUrl: string; tenantAlias: string }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const latestToken = useRef(accessToken);
  latestToken.current = auth.isAuthenticated ? accessToken : undefined;
  const api = useMemo(
    () => createLineApi({ baseUrl: apiBaseUrl, accessToken: () => latestToken.current }),
    [apiBaseUrl],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="line" auth={auth} />;
  return (
    <ConsoleShell
      {...shellUserProps(auth, tenantAlias)}
      apiBaseUrl={apiBaseUrl}
      accessToken={() => accessToken}
      tenantAlias={tenantAlias}
      appId="line-settings"
    >
      <LineSettingsPage
        api={api}
        apiBaseUrl={apiBaseUrl}
        onSignIn={() => void signInFromCurrentPage(auth)}
      />
    </ConsoleShell>
  );
}

/** #566: permission (tenant pilot admin role) is decided at `line-webhook` — Console renders by status only */
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
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="lineInbound" auth={auth} />;
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
 * J5.6 (#344): Journey authoring — all permissions are decided at the API by IAM capability, not by reading the role in
 * the token; session recovery is bound to the tenant alias + session and cleared on logout
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
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken) {
    // Signed out or session expired: this tenant's pending edits must not carry over to the next user
    clearRecovery(window.sessionStorage, tenantAlias);
    return <SignInRequired surface="journeys" auth={auth} />;
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
 * AC5 (#598): my account / account policy — the email verification token is moved out of the URL in main.tsx before render
 * (so it does not stick to the login return URL) and the page reads it from sessionStorage once
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
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) return <SigningIn />;
  if (auth.error || !auth.isAuthenticated || !accessToken)
    return <SignInRequired surface="account" auth={auth} />;
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

export function TenantPeopleSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t: translate } = useTranslation('tenantPeople');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createPeopleApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  if (auth.isLoading) return <main aria-busy="true" />;
  if (auth.error || !auth.isAuthenticated || !token)
    return (
      <main>
        <p>{translate('errors.UNAUTHORIZED')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{translate('signIn')}</Button>
      </main>
    );
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile?.iss !== auth.settings.authority ||
    profile?.tenant_slug !== tenantAlias ||
    !identity.every((value) => typeof value === 'string' && value.length > 0)
  )
    return <main role="alert">{translate('errors.FORBIDDEN')}</main>;
  const identityKey = JSON.stringify(identity);
  return (
    <TenantPeoplePage
      key={identityKey}
      api={api}
      identityKey={identityKey}
      onSignIn={() => void signInFromCurrentPage(auth)}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

export function CustomersSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t: translate } = useTranslation('customers');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCustomersApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile?.iss !== auth.settings.authority ||
      profile?.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return (
      <main className="empty" role="alert">
        {translate('errors.forbidden')}
      </main>
    );
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main className="empty" role="alert">
        <p>{translate('errors.unauthorized')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{translate('signIn')}</Button>
      </main>
    );
  return (
    <CustomersPage
      api={api}
      identityKey={retained.current}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

export function CustomerTagsSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('customerTags');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCustomerTagsApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile.iss !== auth.settings.authority ||
      profile.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return <main role="alert">{t('access')}</main>;
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main role="alert">
        <p>{t('session')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  return (
    <CustomerTagsPage
      api={api}
      identityKey={retained.current}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

export function CustomerImportSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('customerImport');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCustomerImportApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile.iss !== auth.settings.authority ||
      profile.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return <main role="alert">{t('access')}</main>;
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main role="alert">
        <p>{t('session')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  return (
    <CustomerImportPage
      api={api}
      identityKey={retained.current}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

/** #915: team permissions on system segments — the team list comes from Core Settings, grants go through IAM team-segment-scopes */
export function CustomerAccessSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('customerAccess');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const scopes = useMemo(
    () => createTeamScopeApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  const teams = useMemo(
    () => createCoreApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }).teams,
    [apiBaseUrl],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile.iss !== auth.settings.authority ||
      profile.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return <main role="alert">{t('errors.access')}</main>;
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main role="alert">
        <p>{t('errors.session')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  const teamsUrl = new URL(window.location.href);
  teamsUrl.search = '';
  teamsUrl.searchParams.set('tenant', tenantAlias);
  teamsUrl.searchParams.set('view', 'core-settings');
  teamsUrl.searchParams.set('page', 'teams');
  return (
    <CustomerAccessPage
      scopes={scopes}
      teams={teams}
      identityKey={retained.current}
      teamsHref={teamsUrl.toString()}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

export function CustomerOverviewSurface({
  apiBaseUrl,
  tenantAlias,
  mode,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
  mode: 'overview' | 'rules';
}) {
  const auth = useAuth();
  const { t } = useTranslation('customerOverview');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCustomerOverviewApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl, token],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile.iss !== auth.settings.authority ||
      profile.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return <main role="alert">{t('access')}</main>;
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main role="alert">
        <p>{t('session')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  return (
    <CustomerOverviewPage
      mode={mode}
      api={api}
      identityKey={retained.current}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
  );
}

export function CustomerActivitySurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('customerActivity');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCustomerActivityApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl, token],
  );
  const retained = useRef('');
  if (auth.isLoading && !retained.current) return <main aria-busy="true" />;
  const profile = auth.user?.profile;
  const identity = [profile?.iss, profile?.tenant_id, profile?.dc_user_id, profile?.sub];
  if (
    profile &&
    (profile.iss !== auth.settings.authority ||
      profile.tenant_slug !== tenantAlias ||
      !identity.every((value) => typeof value === 'string' && value.length > 0))
  )
    return <main role="alert">{t('access')}</main>;
  if (profile) retained.current = JSON.stringify(identity);
  if (!retained.current)
    return (
      <main role="alert">
        <p>{t('session')}</p>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  return (
    <CustomerActivityPage
      api={api}
      identityKey={retained.current}
      signedIn={!!auth.isAuthenticated && !!token && !auth.error && !auth.isLoading}
      onSignIn={() => {
        void auth.signinSilent().catch(() => auth.signinPopup());
      }}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
    />
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
    <VoiceRoutingPage
      key={identityKey}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
      api={api}
      identityKey={identityKey}
      onSignIn={() => void signInFromCurrentPage(auth)}
    />
  );
}

export function CoreSettingsSurface({
  apiBaseUrl,
  tenantAlias,
}: {
  apiBaseUrl: string;
  tenantAlias: string;
}) {
  const auth = useAuth();
  const { t } = useTranslation('coreSettings');
  const token = auth.user?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = auth.isAuthenticated ? token : undefined;
  const api = useMemo(
    () => createCoreApi({ baseUrl: apiBaseUrl, accessToken: () => tokenRef.current }),
    [apiBaseUrl],
  );
  const retained = useRef('');
  const profile = auth.user?.profile;
  const identity = [
    profile?.iss,
    auth.settings.client_id,
    profile?.tenant_id,
    profile?.dc_user_id,
    profile?.sub,
  ];
  const validProfile =
    !!profile &&
    profile.iss === auth.settings.authority &&
    profile.tenant_slug === tenantAlias &&
    identity.every((x) => typeof x === 'string' && x.length > 0);
  useEffect(() => {
    if (profile && !validProfile) clearCoreCommandReferences();
  }, [profile, validProfile]);
  if (profile) {
    if (!validProfile) return <main role="alert">{t('status.FORBIDDEN')}</main>;
    retained.current = JSON.stringify(identity);
  }
  if (!retained.current)
    return (
      <main className="empty">
        <h1>{t('title')}</h1>
        <Button onPress={() => void signInFromCurrentPage(auth)}>{t('signIn')}</Button>
      </main>
    );
  return (
    <CoreSettingsPage
      key={retained.current}
      identityKey={retained.current}
      api={api}
      signedIn={auth.isAuthenticated}
      shell={{
        ...shellUserProps(auth, tenantAlias),
        apiBaseUrl,
        accessToken: () => tokenRef.current,
        tenantAlias,
      }}
      onSignIn={async () => {
        try {
          await auth.signinSilent();
        } catch {
          await auth.signinPopup();
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }}
    />
  );
}
