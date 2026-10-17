import type { Prisma } from '@d-contact/db';

export function findActiveAgent(
  transaction: Prisma.TransactionClient,
  actor: { tenantId: string; userId: string },
) {
  return transaction.user.findFirst({
    where: { tenantId: actor.tenantId, id: actor.userId, role: 'AGENT', isActive: true },
    select: { id: true },
  });
}
