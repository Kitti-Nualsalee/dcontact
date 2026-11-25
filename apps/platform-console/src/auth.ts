/**
 * OIDC of the Platform Console (A1.7 #412) — the `platform-console` client, separate from the tenant console (#387)
 *
 * - authorization code + PKCE; Keycloak enforces password + OTP through the `platform-browser` flow (A1.2)
 * - the access token lives in memory only (InMemoryWebStorage) — never in localStorage/sessionStorage
 * - the OIDC state (used during the redirect) lives in the tab's sessionStorage, then code/state are removed from the URL
 * - after a refresh, a marker without a token is used to ask Keycloak for a new session with prompt=none exactly once
 */
import { InMemoryWebStorage, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';

const restoreAttemptKey = 'dcontact.platform.oidc.restore-attempted';

export function hasAttemptedPlatformSessionRestore(storage: Storage): boolean {
  return storage.getItem(restoreAttemptKey) === '1';
}

export function beginPlatformSessionRestore(storage: Storage): boolean {
  if (hasAttemptedPlatformSessionRestore(storage)) return false;
  storage.setItem(restoreAttemptKey, '1');
  return true;
}

export function allowPlatformSessionRestore(storage: Storage): void {
  storage.removeItem(restoreAttemptKey);
}

export function pausePlatformSessionRestore(storage: Storage): void {
  storage.setItem(restoreAttemptKey, '1');
}

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
    // does not request profile/email/organization — the token has only the identity + platform roles
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

/** removes the OIDC parameters after the callback — the URL must not keep anything usable to exchange a token or a leftover error */
export function cleanCallbackUrl(location: URL): string {
  const next = new URL(location.href);
  for (const key of [
    'code',
    'state',
    'session_state',
    'iss',
    'error',
    'error_description',
    'error_uri',
  ])
    next.searchParams.delete(key);
  return `${next.pathname}${next.search}${next.hash}`;
}
