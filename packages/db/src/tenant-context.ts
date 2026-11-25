import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

const tenantContext = new AsyncLocalStorage<string>();

export async function withTenantContext<T>(
  tenantId: string,
  work: () => Promise<T> | T,
): Promise<T> {
  if (!tenantId) throw new Error('tenant context requires a tenant id');
  return tenantContext.run(tenantId, work);
}

export function currentTenantId(): string {
  const tenantId = tenantContext.getStore();
  if (!tenantId) throw new Error('tenant context is not available');
  return tenantId;
}

/**
 * Runs database work with the same tenant context that application code sees.
 * `set_config(..., true)` is transaction-local, so pooled connections cannot
 * leak a tenant context to a subsequent request.
 */
export async function withTenantDatabaseTransaction<T>(
  prisma: PrismaClient,
  tenantId: string,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
  /** AC4 (#597): a transaction that calls an external system before commit needs a timeout longer than the default 5 seconds */
  options?: {
    timeout?: number;
    maxWait?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  if (!tenantId) throw new Error('tenant context requires a tenant id');

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    const result = await withTenantContext(tenantId, () => work(transaction));
    // let the caller see a deferred constraint failure inside the callback too; never return a success result before the final-state checks
    await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return result;
  }, options);
}
