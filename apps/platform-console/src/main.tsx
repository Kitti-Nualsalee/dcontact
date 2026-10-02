import { StrictMode, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { createPlatformApi } from './api.js';
import { PlatformConsoleApp } from './app.js';
import {
  allowPlatformSessionRestore,
  beginPlatformSessionRestore,
  cleanCallbackUrl,
  createPlatformOidcSettings,
  hasAttemptedPlatformSessionRestore,
  pausePlatformSessionRestore,
} from './auth.js';
import './style.css';

const apiBaseUrl = (import.meta.env.VITE_PLATFORM_API_URL as string | undefined) ?? '';

function AuthenticatedConsole() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createPlatformApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken],
  );
  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || auth.error || auth.activeNavigator) return;
    if (beginPlatformSessionRestore(window.sessionStorage)) {
      // Full-page OIDC redirect ใช้ Keycloak SSO cookie ได้โดยไม่เก็บ token ใน browser storage
      void auth.signinRedirect({ prompt: 'none', redirectMethod: 'replace' });
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.error, auth.activeNavigator, auth.signinRedirect]);

  useEffect(() => {
    if (auth.error && new URL(window.location.href).searchParams.has('error')) {
      window.history.replaceState(null, '', cleanCallbackUrl(new URL(window.location.href)));
    }
  }, [auth.error]);

  if (
    auth.activeNavigator === 'signinRedirect' ||
    auth.isLoading ||
    (!auth.error &&
      !auth.isAuthenticated &&
      !hasAttemptedPlatformSessionRestore(window.sessionStorage))
  ) {
    return (
      <main className="centered" aria-busy="true">
        <h1>กำลังเข้าสู่ระบบ</h1>
      </main>
    );
  }
  if (auth.error || !auth.isAuthenticated || !accessToken) {
    return (
      <main className="centered">
        <h1>D-Contact Platform Console</h1>
        <p>สำหรับทีม D-Contact ภายในเท่านั้น — เข้าสู่ระบบด้วยบัญชี platform (รหัสผ่าน + OTP)</p>
        <button
          className="button primary"
          onClick={() => void auth.signinRedirect({ prompt: 'login' })}
        >
          เข้าสู่ระบบ
        </button>
      </main>
    );
  }
  return (
    <PlatformConsoleApp
      api={api}
      onSignOut={() => {
        pausePlatformSessionRestore(window.sessionStorage);
        void auth.signoutRedirect();
      }}
      onSessionExpired={() => void auth.signinRedirect({ prompt: 'login' })}
    />
  );
}

function ProductionRoot() {
  const issuer = import.meta.env.VITE_KC_ISSUER as string | undefined;
  const clientId = (import.meta.env.VITE_KC_CLIENT_ID as string | undefined) ?? 'platform-console';
  if (!issuer) {
    return (
      <main className="centered">
        <h1>ยังไม่ได้ตั้งค่า</h1>
        <p>ต้องตั้ง VITE_KC_ISSUER และ VITE_PLATFORM_API_URL</p>
      </main>
    );
  }
  return (
    <AuthProvider
      {...createPlatformOidcSettings({
        issuer,
        clientId,
        origin: window.location.origin,
        stateStorage: window.sessionStorage,
      })}
      onSigninCallback={(user) => {
        if (user?.access_token) allowPlatformSessionRestore(window.sessionStorage);
        window.history.replaceState(null, '', cleanCallbackUrl(new URL(window.location.href)));
      }}
    >
      <AuthenticatedConsole />
    </AuthProvider>
  );
}

/** e2e harness เท่านั้น: API ถูก mock บน origin เดียวกัน ไม่มี OIDC */
function E2eRoot() {
  const api = useMemo(
    () =>
      createPlatformApi({ baseUrl: window.location.origin, accessToken: () => 'e2e-access-token' }),
    [],
  );
  return <PlatformConsoleApp api={api} pollMs={Number(import.meta.env.VITE_POLL_MS ?? 200)} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
createRoot(root).render(
  <StrictMode>{import.meta.env.MODE === 'e2e' ? <E2eRoot /> : <ProductionRoot />}</StrictMode>,
);
