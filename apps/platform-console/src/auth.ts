/**
 * OIDC ของ Platform Console (A1.7 #412) — client `platform-console` แยกจาก tenant console (#387)
 *
 * - authorization code + PKCE; Keycloak บังคับ password + OTP ผ่าน flow `platform-browser` (A1.2)
 * - access token อยู่ใน memory เท่านั้น (InMemoryWebStorage) — ไม่ลง localStorage/sessionStorage
 * - OIDC state (ใช้ระหว่าง redirect) อยู่ใน sessionStorage ของแท็บ แล้วลบ code/state ออกจาก URL
 */
import { InMemoryWebStorage, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';

export function createPlatformOidcSettings(input: {
  issuer: string;
  clientId: string;
  origin: string;
  stateStorage: Storage;
}): UserManagerSettings {
  const redirectUri = new URL('/', input.origin).toString();
  return {
    authority: input.issuer,
    client_id: input.clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: redirectUri,
    response_type: 'code',
    // ไม่ขอ profile/email/organization — token มีแค่ identity + platform roles
    scope: 'openid',
    disablePKCE: false,
    automaticSilentRenew: false,
    monitorSession: false,
    stateStore: new WebStorageStateStore({
      store: input.stateStorage,
      prefix: 'dcontact.platform.oidc.state.',
    }),
    userStore: new WebStorageStateStore({
      store: new InMemoryWebStorage(),
      prefix: 'dcontact.platform.oidc.user.',
    }),
  };
}

/** ลบ `code`/`state`/`session_state` หลัง callback — URL ต้องไม่มีสิ่งที่ใช้แลก token ได้ */
export function cleanCallbackUrl(location: URL): string {
  const next = new URL(location.href);
  for (const key of ['code', 'state', 'session_state', 'iss']) next.searchParams.delete(key);
  return `${next.pathname}${next.search}${next.hash}`;
}
