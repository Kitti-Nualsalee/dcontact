import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenantDatabaseTransaction } from './index.js';
const owner = new PrismaClient();
const app = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
});
test.after(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});
test('องค์กร DB: app เขียนชื่อโดยไม่มี revision/audit/receipt ไม่ได้', async () => {
  const id = randomUUID();
  await owner.tenant.create({
    data: { id, name: 'ชื่อเดิม', slug: `core-org-${id}`, sipDomain: `${id}.core.test` },
  });
  await assert.rejects(
    withTenantDatabaseTransaction(app, id, async (tx) => {
      await tx.tenant.update({ where: { id }, data: { name: 'ต้อง rollback' } });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  assert.equal((await owner.tenant.findUniqueOrThrow({ where: { id } })).name, 'ชื่อเดิม');
});
