import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { SessionLocaleProvider } from '@d-contact/i18n/react';
import { Button, shellUserFromClaims } from '@d-contact/ui-react';
import { appI18n } from './i18n/index.js';
import { WorkspaceShell } from './shell/workspace-shell.js';
import { createAgentWorkspaceApi } from './agent-api.js';
import {
  createOidcSettings,
  accessTokenRealmRoles,
  resolveAuthorizedWorkspaceView,
  resolveTenantAlias,
  workspaceReturnUrl,
  workspaceCallbackUrl,
  workspaceIdentityKey,
} from './auth-session.js';
import { SipJsBrowserTransport } from './dphone/sip-js-transport.js';
import { BrowserDphone } from './dphone/dphone.js';
import { createSupervisorWorkspaceApi } from './supervisor-api.js';
import { SupervisorWorkspace } from './supervisor-workspace.js';
import { WorkspaceApp, type DphoneFactory } from './workspace-app.js';
import { createWorkSessionApi } from './work-session.js';
import { WrapupRuntime } from './wrapup-runtime.js';
import { UserManager, type UserManagerSettings } from 'oidc-client-ts';

const createProductionDphone: DphoneFactory = (remoteAudio, callbacks) =>
  new BrowserDphone(new SipJsBrowserTransport(remoteAudio, callbacks));

export function AuthenticatedWorkspace({
  apiBaseUrl,
  tenantAlias,
  createDphone = createProductionDphone,
}: AuthenticatedWorkspaceProps) {
  const auth = useAuth();
  const { t } = useTranslation('workspace');
  // #588: เปลี่ยนแล้ว re-render เท่านั้น — WorkspaceShell/WorkspaceApp อยู่ตำแหน่งเดิมจึงไม่ remount (ADR-026)
  const [workInHand, setWorkInHand] = useState(false);
  const [popupPending, setPopupPending] = useState(false);
  const [popupFailed, setPopupFailed] = useState(false);
  const runtime = useMemo(() => new WrapupRuntime(), []);
  useSyncExternalStore(runtime.subscribe, runtime.version);
  const identity = auth.isAuthenticated
    ? workspaceIdentityKey(auth.user?.profile, auth.settings.authority, tenantAlias)
    : undefined;
  const owner = useRef<string | undefined>(undefined);
  const identityBlocked = useRef(false);
  if (!owner.current && identity) {
    owner.current = identity;
    runtime.setOwner(identity);
  }
  if (
    auth.isAuthenticated &&
    auth.user &&
    (!identity || identity !== owner.current) &&
    !identityBlocked.current
  ) {
    identityBlocked.current = true;
    runtime.clear();
  }
  if (identity && identity === owner.current && identityBlocked.current) {
    identityBlocked.current = false;
    runtime.setOwner(identity);
  }
  const accessToken = auth.user?.access_token;
  const authRevision = useRef({ token: accessToken, revision: 0 });
  if (authRevision.current.token !== accessToken) {
    authRevision.current = { token: accessToken, revision: authRevision.current.revision + 1 };
  }
  const latestToken = useRef(accessToken);
  latestToken.current =
    auth.isAuthenticated && !auth.error && !identityBlocked.current && identity
      ? accessToken
      : undefined;
  const readToken = useMemo(() => () => latestToken.current, []);
  const retainedUser = useRef<typeof auth.user>(undefined);
  if (identity && !identityBlocked.current && auth.user) retainedUser.current = auth.user;
  const user = retainedUser.current;
  const phone = useRef<BrowserDphone | undefined>(undefined);
  const createPhone = useMemo<DphoneFactory>(
    () => (audio, callbacks) => {
      const instance = createDphone(audio, callbacks);
      phone.current = instance;
      return instance;
    },
    [createDphone],
  );
  const warning = t('recovery.discard');
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!runtime.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      if (
        !runtime.hasUnsavedWork() ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === '_blank' ||
        anchor.hasAttribute('download')
      )
        return;
      const destination = new URL(anchor.href);
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      )
        return;
      if (!window.confirm(warning)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', navigate, true);
    };
  }, [runtime, warning]);
  const agentApi = useMemo(
    () =>
      createAgentWorkspaceApi({
        baseUrl: apiBaseUrl,
        accessToken: readToken,
      }),
    [readToken, apiBaseUrl],
  );
  // E1.12: work-session lease — #583: บังคับทุก tenant (SIP ต้องมี lease)
  const workSession = useMemo(
    () =>
      createWorkSessionApi({
        baseUrl: apiBaseUrl,
        accessToken: readToken,
      }),
    [readToken, apiBaseUrl],
  );
  const supervisorApi = useMemo(
    () =>
      createSupervisorWorkspaceApi({
        baseUrl: apiBaseUrl,
        accessToken: readToken,
      }),
    [readToken, apiBaseUrl],
  );

  if (!user && (auth.activeNavigator === 'signinRedirect' || auth.isLoading)) {
    return <AuthStatus title="กำลังเข้าสู่ระบบ" detail="กำลังตรวจสอบ organization และ session" />;
  }
  if (auth.activeNavigator === 'signoutRedirect') {
    return <AuthStatus title="กำลังออกจากระบบ" detail="กำลังปิด Workspace session" />;
  }
  if (!user && auth.error) {
    return (
      <AuthStatus
        title="เข้าสู่ระบบไม่สำเร็จ"
        detail="ระบบไม่เปิดรับสายใหม่ โปรดลองเข้าสู่ระบบอีกครั้ง"
        actionLabel="ลองอีกครั้ง"
        onAction={() =>
          void auth.signinRedirect({ state: workspaceReturnUrl(new URL(window.location.href)) })
        }
      />
    );
  }
  if (!user) {
    return (
      <AuthStatus
        title="D-Contact Workspace"
        detail={`เข้าสู่ระบบสำหรับ organization ${tenantAlias}`}
        actionLabel="เข้าสู่ระบบ"
        onAction={() =>
          void auth.signinRedirect({ state: workspaceReturnUrl(new URL(window.location.href)) })
        }
      />
    );
  }

  const view = resolveAuthorizedWorkspaceView(
    new URL(window.location.href),
    user.profile,
    user.access_token,
  );
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
  const signOut = () => {
    if ((runtime.hasUnsavedWork() || workInHand) && !window.confirm(warning)) return;
    void auth.signoutRedirect();
  };
  const signInAgain = async () => {
    setPopupPending(true);
    setPopupFailed(false);
    try {
      const restored = await auth.signinPopup({
        popupAbortOnClose: true,
        nonce: crypto.randomUUID(),
        state: workspaceReturnUrl(new URL(window.location.href)),
      });
      if (!restored) setPopupFailed(true);
    } catch {
      setPopupFailed(true);
    } finally {
      setPopupPending(false);
    }
  };
  const shellProps = {
    apiBaseUrl,
    accessToken: readToken,
    tenantAlias,
    account: {
      user: shellUserFromClaims(
        { ...user.profile, realm_access: { roles: accessTokenRealmRoles(user.access_token) } },
        tenantAlias,
      ),
      onSignOut: () => auth.signoutRedirect(),
    },
  } as const;
  if (view === 'supervisor') {
    return (
      <WorkspaceShell {...shellProps} appId="supervisor-workspace">
        <SupervisorWorkspace api={supervisorApi} tenantLabel={tenantAlias} onSignOut={signOut} />
      </WorkspaceShell>
    );
  }

  return (
    <>
      {!auth.isAuthenticated || auth.error || identityBlocked.current ? (
        <section role="status" className="aw-panel">
          <p>{t(identityBlocked.current ? 'recovery.identityChanged' : 'recovery.authRequired')}</p>
          {popupFailed ? <p role="alert">{t('recovery.popupFailed')}</p> : null}
          <Button isDisabled={popupPending} onPress={() => void signInAgain()}>
            {t('recovery.signIn')}
          </Button>
          {identityBlocked.current ? (
            <Button onPress={() => void phone.current?.hangup()}>{t('recovery.endCall')}</Button>
          ) : null}
        </section>
      ) : null}
      <div hidden={identityBlocked.current}>
        <WorkspaceShell
          {...shellProps}
          appId="agent-workspace"
          workInHand={workInHand || runtime.hasUnsavedWork()}
        >
          <WorkspaceApp
            api={agentApi}
            tenantLabel={tenantAlias}
            onSignOut={signOut}
            createDphone={createPhone}
            workSession={workSession}
            onWorkInHandChange={setWorkInHand}
            sessionReady={
              auth.isAuthenticated &&
              Boolean(identity) &&
              !auth.error &&
              !auth.isLoading &&
              !identityBlocked.current
            }
            wrapupRuntime={runtime}
            identityKey={owner.current}
            recoveryRevision={authRevision.current.revision}
          />
        </WorkspaceShell>
      </div>
    </>
  );
}

interface AuthenticatedWorkspaceProps {
  apiBaseUrl: string;
  tenantAlias: string;
  createDphone?: DphoneFactory;
}

export function WorkspacePopupCallback({ settings }: { settings: UserManagerSettings }) {
  const { t } = useTranslation('workspace');
  const [manager] = useState(() => new UserManager(settings));
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void manager.signinPopupCallback().catch(() => setFailed(true));
  }, [manager]);
  return failed ? (
    <AuthStatus title={t('recovery.callbackFailed')} detail={t('recovery.callbackClose')} />
  ) : null;
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
  if (window.opener && new URL(window.location.href).searchParams.has('state')) {
    return <WorkspacePopupCallback settings={settings} />;
  }
  return (
    <AuthProvider
      {...settings}
      onSigninCallback={(user) => {
        const cleanUrl = workspaceCallbackUrl(new URL(window.location.href), user?.state);
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
