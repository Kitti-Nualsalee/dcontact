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
): AuthorizedWorkspaceView {
  if (location.searchParams.get('view') !== 'supervisor') return 'agent';

  const roles = readRealmRoles(profile);
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
