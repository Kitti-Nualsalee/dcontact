import { createHash } from 'node:crypto';
import { Prisma } from '@d-contact/db';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
export interface TenantConfigurationCaller {
  issuer: string;
  subject: string;
  clientId: string;
  tenantSlug: string;
}
export function tenantConfigurationCaller(
  req: AuthenticatedGatewayRequest,
): TenantConfigurationCaller | undefined {
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

export interface TenantConfigurationIdentity {
  tenantId: string;
  userId: string;
  roles: readonly string[];
  correlationId?: string;
  caller?: TenantConfigurationCaller;
}
export interface TenantConfigurationActor {
  id: string;
  role: 'ADMIN' | 'SUPERVISOR';
  teamId: string | null;
  scopeStamp: string;
}

export async function findTenantConfigurationActor(
  tx: Prisma.TransactionClient,
  identity: TenantConfigurationIdentity,
  lock = false,
): Promise<TenantConfigurationActor | undefined> {
  if (!identity.caller) return undefined;
  if (lock) {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id=${identity.tenantId}::uuid FOR SHARE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${identity.userId}::uuid FOR SHARE NOWAIT`;
  }
  if (
    !(await tx.tenant.findFirst({
      where: { id: identity.tenantId, lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    }))
  )
    return undefined;
  const user = await tx.user.findFirst({
    where: { id: identity.userId, tenantId: identity.tenantId, isActive: true },
    select: { id: true, role: true, teamId: true, keycloakId: true },
  });
  if (
    !user ||
    !identity.roles.includes(user.role.toLowerCase()) ||
    (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') ||
    user.keycloakId !== identity.caller.subject
  )
    return undefined;
  const caller = identity.caller;
  const binding = await tx.$queryRaw<{ revision: number }[]>(Prisma.sql`
    SELECT revision FROM tenant_voice_identity_bindings
    WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${user.id}::uuid
      AND subject_id=${caller.subject} AND issuer=${caller.issuer}
      AND client_id=${caller.clientId} AND tenant_slug=${caller.tenantSlug}
      AND identity_class='TENANT_USER' AND is_active`);
  // B1 trigger บังคับ proof writer ให้ถือ User FOR UPDATE NOWAIT อยู่แล้ว
  // ถือ User FOR SHARE จึงกันการเปลี่ยน proof โดยไม่เพิ่ม UPDATE grant ให้ตาราง proof
  const provisioned = !binding[0]
    ? await tx.$queryRaw<
        { statusRevision: number; operationId: string; activationProbeRef: string }[]
      >(Prisma.sql`
          SELECT status_revision AS "statusRevision",operation_id::text AS "operationId",
            activation_probe_ref::text AS "activationProbeRef"
          FROM dc_people_configuration_authority(${identity.tenantId}::uuid,${user.id}::uuid,${caller.issuer},${caller.clientId},${caller.tenantSlug})`)
    : [];
  const authority = binding[0]
    ? binding[0].revision
    : provisioned[0]
      ? [
          'B2_VERIFIED_RECEIPTS',
          provisioned[0].statusRevision,
          provisioned[0].operationId,
          provisioned[0].activationProbeRef,
        ]
      : undefined;
  if (authority === undefined) return undefined;
  if (user.role === 'SUPERVISOR') {
    if (!user.teamId) return undefined;
    if (lock)
      await tx.$queryRaw`SELECT id FROM teams WHERE tenant_id=${identity.tenantId}::uuid AND id=${user.teamId}::uuid FOR SHARE NOWAIT`;
    if (
      !(await tx.team.findFirst({
        where: { tenantId: identity.tenantId, id: user.teamId, isActive: true },
        select: { id: true },
      }))
    )
      return undefined;
  }
  return {
    id: user.id,
    role: user.role,
    teamId: user.teamId,
    scopeStamp: createHash('sha256')
      .update(JSON.stringify([identity.tenantId, user.id, user.role, true, user.teamId, authority]))
      .digest('hex'),
  };
}
