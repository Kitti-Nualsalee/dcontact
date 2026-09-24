import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { createPlatformApi } from './api.js';
import { PlatformConsoleApp } from './app.js';
import { cleanCallbackUrl, createPlatformOidcSettings } from './auth.js';
import './style.css';

const apiBaseUrl = (import.meta.env.VITE_PLATFORM_API_URL as string | undefined) ?? '';

function AuthenticatedConsole() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const api = useMemo(
    () => createPlatformApi({ baseUrl: apiBaseUrl, accessToken: () => accessToken }),
    [accessToken],
  );
  if (auth.activeNavigator === 'signinRedirect' || auth.isLoading) {
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
        <button className="button primary" onClick={() => void auth.signinRedirect()}>
          เข้าสู่ระบบ
        </button>
      </main>
    );
  }
  return (
    <PlatformConsoleApp
      api={api}
      onSignOut={() => void auth.signoutRedirect()}
      onSessionExpired={() => void auth.signinRedirect()}
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
      onSigninCallback={() => {
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
