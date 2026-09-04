import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

/**
 * Tenant-scoped read model for the API boundary. The explicit where clause is
 * the service-level guard; the transaction helper also installs SET LOCAL
 * app.tenant_id so PostgreSQL RLS remains the final defense-in-depth boundary.
 */
export function listTenantQueues(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.queue.findMany({
      where: { tenantId },
      select: { id: true, name: true, channels: true },
      orderBy: { name: 'asc' },
    }),
  );
}
