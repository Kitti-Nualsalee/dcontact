import type { Prisma } from '@d-contact/db';
import { C360WorkError, type C360VerifiedActor } from '@d-contact/customer-360';
import type { C360RequestIdentity } from './customer-360-api.js';

/** Agent work boundary แยกจาก tenant configuration (ซึ่งรับเฉพาะ Admin/Supervisor) */
export async function currentC360WorkActor(
  tx: Prisma.TransactionClient,
  identity: C360RequestIdentity,
): Promise<C360VerifiedActor> {
  const reject = () => {
    throw new C360WorkError(403, 'CUSTOMER_ACCESS_DENIED');
  };
  if (!identity.roles.includes('agent')) return reject();
  const user = await tx.user.findFirst({
    where: {
      tenantId: identity.tenantId,
      id: identity.userId,
      isActive: true,
      role: 'AGENT',
      keycloakId: identity.caller.subject,
    },
    select: { id: true, teamId: true },
  });
  if (
    !user?.teamId ||
    !(await tx.tenant.findFirst({
      where: { id: identity.tenantId, lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    }))
  )
    return reject();
  const caller = identity.caller;
  const bindings = await tx.$queryRaw<
    { revision: number }[]
  >`SELECT revision FROM tenant_voice_identity_bindings WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${user.id}::uuid AND subject_id=${caller.subject} AND issuer=${caller.issuer} AND client_id=${caller.clientId} AND tenant_slug=${caller.tenantSlug} AND identity_class='TENANT_USER' AND is_active`;
  if (!bindings.length) {
    const provisioned = await tx.$queryRaw<
      { revision: number }[]
    >`SELECT status_revision AS revision FROM dc_people_configuration_authority(${identity.tenantId}::uuid,${user.id}::uuid,${caller.issuer},${caller.clientId},${caller.tenantSlug})`;
    if (!provisioned.length) return reject();
  }
  return { tenantId: identity.tenantId, userId: user.id, role: 'AGENT', teamId: user.teamId };
}
