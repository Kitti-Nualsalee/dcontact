import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { listTenantQueues } from './tenant-queue.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

test('API query uses service scoping and transaction-local RLS for dcontact_app', async (t) => {
  t.after(async () => Promise.all([owner.$disconnect(), application.$disconnect()]));
  const demo = await owner.tenant.findUniqueOrThrow({ where: { slug: 'demo' } });

  const visible = await listTenantQueues(application, demo.id);
  const hidden = await listTenantQueues(application, '00000000-0000-0000-0000-000000000000');

  assert.ok(visible.length > 0);
  assert.deepEqual(hidden, []);
  assert.ok(visible.every((queue) => !('tenantId' in queue)));
});
