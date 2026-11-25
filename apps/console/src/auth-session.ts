import { InMemoryWebStorage, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';

const CONSOLE_RETURN_URL_KEY = 'dcontact.console.return-url';
const CONSOLE_SIGNED_OUT_KEY = 'dcontact.console.signed-out';

export interface ConsoleOidcSettingsInput {
  issuer: string;
  clientId: string;
  origin: string;
  tenantAlias: string;
  stateStorage: Storage;
}

export function resolveTenantAlias(location: URL): string {
  const queryAlias = location.searchParams.get('tenant')?.trim();
  if (queryAlias) return queryAlias;
  const [subdomain] = location.hostname.split('.');
  if (subdomain && location.hostname.includes('.') && subdomain !== 'www') return subdomain;
  throw new Error('tenant alias is required');
}

export function resolveConsoleContextId(location: URL): string {
  const contextId = location.searchParams.get('context')?.trim();
  if (
    !contextId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contextId)
  ) {
    throw new Error('opaque Console context is required');
  }
  return contextId;
}

/**
 * #684: with no explicit view or Interaction context → always Home, including old deployments that set
 * VITE_CONSOLE_DEFAULT_VIEW=journeys; the old argument is kept so callers of the callback can keep using it
 */
export function resolveConsoleView(location: URL, _legacyDefaultView?: string): string | null {
  const view = location.searchParams.get('view');
  if (view) return view;
  if (location.searchParams.get('context')?.trim()) return null;
  return 'home';
}

export function accessTokenRealmRoles(accessToken: string | undefined): string[] {
  if (!accessToken) return [];
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return [];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(atob(padded)) as { realm_access?: { roles?: unknown } };
    return Array.isArray(claims.realm_access?.roles) &&
      claims.realm_access.roles.every((role): role is string => typeof role === 'string')
      ? claims.realm_access.roles
      : [];
  } catch {
    return [];
  }
}

/**
 * U1.7 (#435): after Keycloak redirects back, `code`/`state`/`session_state`/`iss` must be removed from the URL
 * (so they do not linger in history/evidence screenshots — #379) while keeping the original `tenant`/`view`/`journey`
 */
export function cleanConsoleCallbackUrl(location: URL): string {
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

export function rememberConsoleReturnUrl(location: URL, storage: Storage): void {
  storage.setItem(CONSOLE_RETURN_URL_KEY, cleanConsoleCallbackUrl(new URL(location.href)));
}

/**
 * The destination URL remembered before sending to login — usable only when it has the same origin as the callback, is an internal path
 * and its `tenant` matches the callback (prevents a value tampered with in storage from leaving the system / crossing tenants)
 */
function savedReturnDestination(callback: URL, storage: Storage): URL | undefined {
  const saved = storage.getItem(CONSOLE_RETURN_URL_KEY);
  if (!saved || !saved.startsWith('/') || saved.startsWith('//')) return undefined;
  try {
    const destination = new URL(saved, callback.origin);
    if (
      destination.origin !== callback.origin ||
      destination.searchParams.get('tenant') !== callback.searchParams.get('tenant')
    ) {
      return undefined;
    }
    return destination;
  } catch {
    return undefined;
  }
}

export function consumeConsoleReturnUrl(callback: URL, storage: Storage): string {
  const destination = savedReturnDestination(callback, storage);
  storage.removeItem(CONSOLE_RETURN_URL_KEY);
  return cleanConsoleCallbackUrl(destination ?? callback);
}

/** URL Keycloak redirects back to: has `state` and `code` (success) or `error` (rejected) */
export function isOidcCallback(location: URL): boolean {
  return (
    location.searchParams.has('state') &&
    (location.searchParams.has('code') || location.searchParams.has('error'))
  );
}

/**
 * #676: `redirect_uri` is `/?tenant=<alias>`, so it does not say which page to open — on the first render at the callback
 * the view/context must be chosen from the remembered destination URL (read without deleting; `onSigninCallback` uses/deletes it).
 * Otherwise no page can be chosen → `AuthProvider` is not mounted → nobody exchanges the `code` for a token.
 * A URL that is not a callback is not hijacked by a value left in storage
 */
export function resolveConsoleLocation(location: URL, storage: Storage): URL {
  if (!isOidcCallback(location)) return location;
  return savedReturnDestination(location, storage) ?? location;
}

export function consumeConsoleReturnLocation(
  callback: URL,
  storage: Storage,
  defaultView?: string,
): { url: string; view: string | null } {
  const url = consumeConsoleReturnUrl(callback, storage);
  return { url, view: resolveConsoleView(new URL(url, callback.origin), defaultView) };
}

/**
 * #677: before sign-out, remember the current page and mark that the user signed out themselves — `post_logout_redirect_uri`
 * is `/?tenant=<alias>` (no view/context), so this mark is how we know to show the "signed out" page
 * instead of the error page, and when the user signs in again the callback returns to the original page using the remembered URL (#676)
 */
export function rememberConsoleSignOut(location: URL, storage: Storage): void {
  rememberConsoleReturnUrl(location, storage);
  storage.setItem(CONSOLE_SIGNED_OUT_KEY, '1');
}

export function clearConsoleSignOut(storage: Storage): void {
  storage.removeItem(CONSOLE_SIGNED_OUT_KEY);
}

/** page Keycloak returns to after sign-out: has the mark, is not a callback and names no page (view/context) */
export function isConsoleSignedOutLanding(location: URL, storage: Storage): boolean {
  return (
    storage.getItem(CONSOLE_SIGNED_OUT_KEY) === '1' &&
    !isOidcCallback(location) &&
    !location.searchParams.get('view') &&
    !location.searchParams.get('context')?.trim()
  );
}

/** restore SSO only on a normal boot; a callback and a self-initiated sign-out must finish by their own flow */
export function shouldRestoreConsoleSession(location: URL, storage: Storage): boolean {
  return !isOidcCallback(location) && storage.getItem(CONSOLE_SIGNED_OUT_KEY) !== '1';
}

export function createConsoleOidcSettings(input: ConsoleOidcSettingsInput): UserManagerSettings {
  const redirectUrl = new URL('/', input.origin);
  redirectUrl.searchParams.set('tenant', input.tenantAlias);
  const redirectUri = redirectUrl.toString();
  return {
    authority: input.issuer,
    client_id: input.clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: redirectUri,
    response_type: 'code',
    scope: `openid profile email roles organization:${input.tenantAlias}`,
    disablePKCE: false,
    automaticSilentRenew: true,
    silentRequestTimeoutInSeconds: 10,
    requestTimeoutInSeconds: 5,
    monitorSession: true,
    // R1 (#593): the realm cookie was renamed to DC_* — the session management iframe must be the one that reads the new name
    // (the IdP's old iframe reads the old name hard-coded and cannot be overridden by a theme)
    metadataSeed: {
      check_session_iframe: `${input.issuer.replace(/\/+$/, '')}/dc-account/login-status-iframe.html`,
    },
    stateStore: new WebStorageStateStore({
      store: input.stateStorage,
      prefix: 'dcontact.console.oidc.state.',
    }),
    userStore: new WebStorageStateStore({
      store: new InMemoryWebStorage(),
      prefix: 'dcontact.console.oidc.user.',
    }),
  };
}
