import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTenantId, withTenantContext } from './tenant-context';

test('tenant context is available only within the tenant-scoped request', async () => {
  const tenantId = await withTenantContext('tenant-a', async () => currentTenantId());

  assert.equal(tenantId, 'tenant-a');
  assert.throws(() => currentTenantId(), /not available/);
});
