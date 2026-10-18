import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
export interface VoiceCaller {
  issuer: string;
  subject: string;
  clientId: string;
  tenantSlug: string;
}
/** Claims ที่ verify แล้วเป็นเพียง context; positive authority อยู่ที่ operator binding ใน DB */
export function voiceCatalogCaller(req: AuthenticatedGatewayRequest): VoiceCaller | undefined {
  const identity = req.gatewayIdentity;
  const claims = req.gatewayVerifiedClaims as
    | (Record<string, unknown> & {
        resource_access?: Record<string, unknown>;
      })
    | undefined;
  if (!identity || !claims) return undefined;
  const { iss, sub, azp, tenant_slug: tenantSlug, organization } = claims;
  if (![iss, sub, azp, tenantSlug].every((v) => typeof v === 'string' && v.length > 0))
    return undefined;
  const orgs =
    organization && typeof organization === 'object' && !Array.isArray(organization)
      ? (organization as Record<string, { tenant_id?: unknown }>)
      : undefined;
  const org = orgs?.[tenantSlug as string];
  const protectedClient = Object.keys(claims.resource_access ?? {}).some((client) =>
    ['dcontact-platform-api', 'realm-management', 'master-realm', 'admin-cli'].includes(client),
  );
  if (
    !orgs ||
    Object.keys(orgs).length !== 1 ||
    !Array.isArray(org?.tenant_id) ||
    org.tenant_id.length !== 1 ||
    org.tenant_id[0] !== identity.tenantId ||
    (claims.dc_identity_class !== undefined && claims.dc_identity_class !== 'TENANT_USER') ||
    claims.serviceAccountClientId !== undefined ||
    azp === 'platform-console' ||
    protectedClient ||
    identity.roles.some(
      (role) =>
        role.startsWith('platform_') || role.startsWith('realm-') || role === 'create-realm',
    ) ||
    (typeof claims.preferred_username === 'string' &&
      claims.preferred_username.startsWith('service-account-'))
  )
    return undefined;
  return {
    issuer: iss as string,
    subject: sub as string,
    clientId: azp as string,
    tenantSlug: tenantSlug as string,
  };
}
