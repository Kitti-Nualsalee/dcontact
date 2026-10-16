import { InMemoryWebStorage, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';

export interface OidcSettingsInput {
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

export type AuthorizedWorkspaceView = 'agent' | 'supervisor' | 'forbidden';

export function resolveAuthorizedWorkspaceView(
  location: URL,
  profile: unknown,
  accessToken?: string,
): AuthorizedWorkspaceView {
  if (location.searchParams.get('view') !== 'supervisor') return 'agent';

  const roles =
    accessToken === undefined ? readRealmRoles(profile) : accessTokenRealmRoles(accessToken);
  return roles.includes('supervisor') || roles.includes('admin') ? 'supervisor' : 'forbidden';
}

function readRealmRoles(profile: unknown): string[] {
  if (!profile || typeof profile !== 'object') return [];
  const realmAccess = (profile as { realm_access?: unknown }).realm_access;
  if (!realmAccess || typeof realmAccess !== 'object') return [];
  const roles = (realmAccess as { roles?: unknown }).roles;
  return Array.isArray(roles) && roles.every((role) => typeof role === 'string') ? roles : [];
}

export function createOidcSettings(input: OidcSettingsInput): UserManagerSettings {
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
    // R1 (#593): cookie ของ realm เปลี่ยนชื่อเป็น DC_* — iframe ของ session management ต้องเป็นตัวที่อ่านชื่อใหม่
    // (iframe เดิมของ IdP อ่านชื่อเดิมตายตัวและ override ด้วย theme ไม่ได้)
    metadataSeed: {
      check_session_iframe: `${input.issuer.replace(/\/+$/, '')}/dc-account/login-status-iframe.html`,
    },
    stateStore: new WebStorageStateStore({
      store: input.stateStorage,
      prefix: 'dcontact.oidc.state.',
    }),
    userStore: new WebStorageStateStore({
      store: new InMemoryWebStorage(),
      prefix: 'dcontact.oidc.user.',
    }),
  };
}

/** #684: OIDC state คืนปลายทางเฉพาะ origin/tenant เดิม; ไม่รับ OAuth parameters กลับเข้าประวัติ */
export function workspaceReturnUrl(location: URL): string {
  const clean = new URL(location.href);
  for (const key of ['code', 'state', 'session_state', 'iss', 'error', 'error_description']) {
    clean.searchParams.delete(key);
  }
  return `${clean.pathname}${clean.search}${clean.hash}`;
}

export function workspaceCallbackUrl(callback: URL, state: unknown): string {
  if (typeof state === 'string' && state.startsWith('/') && !state.startsWith('//')) {
    try {
      const destination = new URL(state, callback.origin);
      if (
        destination.origin === callback.origin &&
        destination.searchParams.get('tenant') === callback.searchParams.get('tenant')
      ) {
        return workspaceReturnUrl(destination);
      }
    } catch {
      /* ใช้ callback ที่ตรวจแล้วด้านล่าง */
    }
  }
  return workspaceReturnUrl(callback);
}

/** role สำหรับแสดง UI มาจาก access token เช่นเดียวกับ Gateway; API ตรวจลายเซ็น/สิทธิ์เองเสมอ */
export function accessTokenRealmRoles(accessToken: string): string[] {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return [];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return readRealmRoles(claims);
  } catch {
    return [];
  }
}
