import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
/** B ใช้ Org context และ tenant human caller; legacy API ไม่เปลี่ยน claim policy */
export function voiceCatalogCallerAllowed(req: AuthenticatedGatewayRequest): boolean {
  const identity = req.gatewayIdentity,
    claims = req.gatewayVerifiedClaims;
  if (!identity || !claims) return false;
  const organization = claims.organization;
  const org =
    organization && typeof organization === 'object' && typeof claims.tenant_slug === 'string'
      ? (organization as Record<string, { tenant_id?: unknown }>)[claims.tenant_slug]
      : undefined;
  const resourceAccess = (claims as { resource_access?: Record<string, unknown> }).resource_access;
  return (
    Array.isArray(org?.tenant_id) &&
    org.tenant_id.length === 1 &&
    org.tenant_id[0] === identity.tenantId &&
    claims.azp !== 'platform-console' &&
    !Object.hasOwn(resourceAccess ?? {}, 'dcontact-platform-api') &&
    !identity.roles.some((role) => role.startsWith('platform_')) &&
    !(
      typeof claims.preferred_username === 'string' &&
      claims.preferred_username.startsWith('service-account-')
    )
  );
}
