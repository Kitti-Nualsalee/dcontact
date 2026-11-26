/**
 * #901: deployment context of the tenant Console that the first admin's binding is tied to
 *
 * issuer/client are operator config of the worker, not from a request or token, and must match the `iss`/`azp`
 * that the API checks from a real Console session (`tenantConfigurationCaller`)
 */
export interface TenantConsoleContext {
  issuer: string;
  clientId: string;
  /** #907: origin of the tenant Console (`https://host[:port]`) — the per-tenant redirect is `<origin>/?tenant=<slug>` */
  origin: string;
}

/** clients that belong to the platform/Keycloak itself — must not be used as the tenant Console (matches the guard on the API and DB side) */
const PROTECTED_CLIENTS = new Set([
  'platform-console',
  'dcontact-platform-api',
  'realm-management',
  'admin-cli',
]);

const ISSUER = /^https?:\/\/[^\s/]+(\/\S*)?\/realms\/[A-Za-z0-9._-]+$/;
const CLIENT = /^[A-Za-z0-9._-]{1,255}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

export function tenantConsoleContext(
  issuer: string,
  clientId: string,
  origin: string,
): TenantConsoleContext {
  if (!ISSUER.test(issuer)) {
    throw new Error('PLATFORM_TENANT_CONSOLE_ISSUER must be a realm issuer (…/realms/<realm>)');
  }
  if (!CLIENT.test(clientId) || PROTECTED_CLIENTS.has(clientId)) {
    throw new Error('PLATFORM_TENANT_CONSOLE_CLIENT_ID must be a tenant Console client');
  }
  if (!ORIGIN.test(origin)) {
    throw new Error(
      'PLATFORM_TENANT_CONSOLE_ORIGIN must be an origin (scheme://host[:port]) with no path',
    );
  }
  return { issuer, clientId, origin };
}

export function tenantConsoleContextFromEnv(
  env: Record<string, string | undefined>,
): TenantConsoleContext {
  return tenantConsoleContext(
    env.PLATFORM_TENANT_CONSOLE_ISSUER ?? '',
    env.PLATFORM_TENANT_CONSOLE_CLIENT_ID ?? '',
    env.PLATFORM_TENANT_CONSOLE_ORIGIN ?? '',
  );
}
