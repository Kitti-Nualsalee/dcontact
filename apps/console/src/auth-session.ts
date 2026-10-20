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
 * #684: ไม่มี explicit view หรือ Interaction context → Home เสมอ รวม deployment เก่าที่ตั้ง
 * VITE_CONSOLE_DEFAULT_VIEW=journeys; เก็บ argument เดิมเพื่อให้ callers ของ callback ใช้ต่อได้
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
 * U1.7 (#435): หลัง Keycloak redirect กลับ ต้องลบ `code`/`state`/`session_state`/`iss` ออกจาก URL
 * (ไม่ให้ค้างใน history/screenshot หลักฐาน — #379) โดยคง `tenant`/`view`/`journey` เดิมไว้
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
 * URL ปลายทางที่จำไว้ก่อนส่งไป login — ใช้ได้เฉพาะเมื่อ origin เดียวกับ callback, เป็น path ภายใน
 * และ `tenant` ตรงกับ callback (กันค่าที่ถูกแก้ใน storage พาออกนอกระบบ/ข้าม tenant)
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

/** URL ที่ Keycloak redirect กลับมา: มี `state` และ `code` (สำเร็จ) หรือ `error` (ถูกปฏิเสธ) */
export function isOidcCallback(location: URL): boolean {
  return (
    location.searchParams.has('state') &&
    (location.searchParams.has('code') || location.searchParams.has('error'))
  );
}

/**
 * #676: `redirect_uri` คือ `/?tenant=<alias>` จึงไม่บอกว่าจะเปิดหน้าไหน — ตอน render แรกบน callback
 * ต้องเลือก view/context จาก URL ปลายทางที่จำไว้ (อ่านโดยไม่ลบ ให้ `onSigninCallback` เป็นผู้ใช้/ลบ)
 * ไม่งั้นหน้าถูกเลือกไม่ได้ → ไม่ mount `AuthProvider` → ไม่มีใครแลก `code` เป็น token
 * URL ที่ไม่ใช่ callback ไม่ถูกแย่งด้วยค่าที่ค้างใน storage
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
 * #677: ก่อน sign-out จำหน้าปัจจุบันและทำเครื่องหมายว่าออกจากระบบเอง — `post_logout_redirect_uri`
 * คือ `/?tenant=<alias>` (ไม่มี view/context) จึงต้องรู้จากเครื่องหมายนี้ว่าควรแสดงหน้า "ออกจากระบบแล้ว"
 * แทนหน้า error และเมื่อเข้าสู่ระบบอีกครั้ง callback จะพากลับหน้าเดิมด้วย URL ที่จำไว้ (#676)
 */
export function rememberConsoleSignOut(location: URL, storage: Storage): void {
  rememberConsoleReturnUrl(location, storage);
  storage.setItem(CONSOLE_SIGNED_OUT_KEY, '1');
}

export function clearConsoleSignOut(storage: Storage): void {
  storage.removeItem(CONSOLE_SIGNED_OUT_KEY);
}

/** หน้าที่ Keycloak พากลับมาหลัง sign-out: มีเครื่องหมาย, ไม่ใช่ callback และไม่ได้ระบุหน้า (view/context) */
export function isConsoleSignedOutLanding(location: URL, storage: Storage): boolean {
  return (
    storage.getItem(CONSOLE_SIGNED_OUT_KEY) === '1' &&
    !isOidcCallback(location) &&
    !location.searchParams.get('view') &&
    !location.searchParams.get('context')?.trim()
  );
}

/** กู้ SSO เฉพาะ boot ปกติ; callback และการออกจากระบบเองต้องจบตาม flow ของตน */
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
    // R1 (#593): cookie ของ realm เปลี่ยนชื่อเป็น DC_* — iframe ของ session management ต้องเป็นตัวที่อ่านชื่อใหม่
    // (iframe เดิมของ IdP อ่านชื่อเดิมตายตัวและ override ด้วย theme ไม่ได้)
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
