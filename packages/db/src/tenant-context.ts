import { AsyncLocalStorage } from 'node:async_hooks';

const tenantContext = new AsyncLocalStorage<string>();

export async function withTenantContext<T>(tenantId: string, work: () => Promise<T> | T): Promise<T> {
  if (!tenantId) throw new Error('tenant context requires a tenant id');
  return tenantContext.run(tenantId, work);
}

export function currentTenantId(): string {
  const tenantId = tenantContext.getStore();
  if (!tenantId) throw new Error('tenant context is not available');
  return tenantId;
}
