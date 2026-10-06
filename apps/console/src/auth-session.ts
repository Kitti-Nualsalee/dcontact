import { InMemoryWebStorage, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';

const CONSOLE_RETURN_URL_KEY = 'dcontact.console.return-url';

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
 * U1.4 (#432): หน้าที่จะเปิด — `view` ใน URL มาก่อนเสมอ; ไม่มีทั้ง `view` และ Interaction `context`
 * (เช่นกลับจาก login ที่ redirect_uri เป็น `/?tenant=`) ใช้ `VITE_CONSOLE_DEFAULT_VIEW` ตอน build
 * ตอนนี้รับค่า default เดียวคือ `journeys` (UAT first slice) ค่าอื่นไม่ถูกใช้
 */
export function resolveConsoleView(location: URL, defaultView?: string): string | null {
  const view = location.searchParams.get('view');
  if (view) return view;
  if (location.searchParams.get('context')?.trim()) return null;
  return defaultView === 'journeys' ? 'journeys' : null;
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
 * U1.7 (#435): หลัง Keycloak redirect กลับ ต้องลบ `code`/`state`/`session_state`/`iss` ออกจาก URL
 * (ไม่ให้ค้างใน history/screenshot หลักฐาน — #379) โดยคง `tenant`/`view`/`journey` เดิมไว้
 */
export function cleanConsoleCallbackUrl(location: URL): string {
  const next = new URL(location.href);
  for (const key of ['code', 'state', 'session_state', 'iss']) next.searchParams.delete(key);
  return `${next.pathname}${next.search}${next.hash}`;
}

export function rememberConsoleReturnUrl(location: URL, storage: Storage): void {
  storage.setItem(CONSOLE_RETURN_URL_KEY, cleanConsoleCallbackUrl(new URL(location.href)));
}

export function consumeConsoleReturnUrl(callback: URL, storage: Storage): string {
  const fallback = cleanConsoleCallbackUrl(callback);
  const saved = storage.getItem(CONSOLE_RETURN_URL_KEY);
  storage.removeItem(CONSOLE_RETURN_URL_KEY);
  if (!saved || !saved.startsWith('/') || saved.startsWith('//')) return fallback;
  try {
    const destination = new URL(saved, callback.origin);
    if (
      destination.origin !== callback.origin ||
      destination.searchParams.get('tenant') !== callback.searchParams.get('tenant')
    ) {
      return fallback;
    }
    return cleanConsoleCallbackUrl(destination);
  } catch {
    return fallback;
  }
}

export function consumeConsoleReturnLocation(
  callback: URL,
  storage: Storage,
  defaultView?: string,
): { url: string; view: string | null } {
  const url = consumeConsoleReturnUrl(callback, storage);
  return { url, view: resolveConsoleView(new URL(url, callback.origin), defaultView) };
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
    monitorSession: true,
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
