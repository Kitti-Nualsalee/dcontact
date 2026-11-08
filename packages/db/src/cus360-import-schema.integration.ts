import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from './index.js';

/** ใช้ disposable DB เท่านั้น: ทดสอบ no-BYPASSRLS, composite FK และหลักฐาน immutable */
const owner = new PrismaClient();
const app = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
});
test.after(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

test('M2 import schema แยก tenant, ผูก delegation กับเจ้าของ และคง child/terminal identity', async () => {
  assert.ok(process.env.APPLICATION_DATABASE_URL, 'ต้องตั้ง application URL ของฐานแยก');
  const tenants = [randomUUID(), randomUUID()];
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const job = randomUUID(),
    objectId = randomUUID(),
    commandId = randomUUID();
  await owner.tenant.createMany({
    data: tenants.map((id) => ({
      id,
      name: 'M2 fixture',
      slug: `m2-${id}`,
      sipDomain: `${id}.m2.test`,
    })),
  });
  await owner.user.createMany({
    data: users.map((id, n) => ({
      id,
      tenantId: tenants[n === 2 ? 1 : 0]!,
      email: `${id}@m2.test`,
      passwordHash: '!fixture',
      displayName: 'M2 fixture',
      role: 'ADMIN' as const,
    })),
  });
  const [role] = await app.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const scope = <T>(tenant: string, fn: Parameters<typeof withTenantDatabaseTransaction<T>>[2]) =>
    withTenantDatabaseTransaction(app, tenant, fn);
  await scope(
    tenants[0]!,
    (tx) =>
      tx.$executeRaw`INSERT INTO c360_import_jobs(tenant_id,id,owner_user_id,actor_identity_key,state,source_object_id,created_at,source_expires_at) VALUES (${tenants[0]}::uuid,${job}::uuid,${users[0]}::uuid,'verified-actor','UPLOADING',${objectId}::uuid,transaction_timestamp(),transaction_timestamp()+interval '24 hours')`,
  );
  const visible = await scope(
    tenants[0]!,
    (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM c360_import_jobs WHERE id=${job}::uuid`,
  );
  const hidden = await scope(
    tenants[1]!,
    (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM c360_import_jobs WHERE id=${job}::uuid`,
  );
  assert.equal(visible.length, 1);
  assert.equal(hidden.length, 0);
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_jobs SET source_expires_at=source_expires_at+interval '1 second' WHERE id=${job}::uuid`,
    ),
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_jobs SET report_expires_at=clock_timestamp()+interval '7 days' WHERE id=${job}::uuid`,
    ),
  );
  await assert.rejects(
    scope(
      tenants[1]!,
      (tx) =>
        tx.$executeRaw`INSERT INTO c360_import_rows(tenant_id,job_id,row_no,child_command_id,state) VALUES (${tenants[0]}::uuid,${job}::uuid,1,${commandId}::uuid,'READY')`,
    ),
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`INSERT INTO c360_import_delegations(tenant_id,job_id,actor_user_id,confirmed_plan_hash,authorization_epoch,expires_at) VALUES (${tenants[0]}::uuid,${job}::uuid,${users[1]}::uuid,${'a'.repeat(64)},0,clock_timestamp()+interval '1 hour')`,
    ),
  );
  await scope(
    tenants[0]!,
    (tx) =>
      tx.$executeRaw`INSERT INTO c360_import_delegations(tenant_id,job_id,actor_user_id,confirmed_plan_hash,authorization_epoch,expires_at) VALUES (${tenants[0]}::uuid,${job}::uuid,${users[0]}::uuid,${'a'.repeat(64)},0,clock_timestamp()+interval '1 hour')`,
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_delegations SET confirmed_plan_hash=${'b'.repeat(64)} WHERE job_id=${job}::uuid`,
    ),
  );
  await scope(
    tenants[0]!,
    (tx) =>
      tx.$executeRaw`UPDATE c360_import_delegations SET revoked_at=clock_timestamp() WHERE job_id=${job}::uuid`,
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_delegations SET revoked_at=NULL WHERE job_id=${job}::uuid`,
    ),
  );
  await scope(
    tenants[0]!,
    (tx) =>
      tx.$executeRaw`INSERT INTO c360_import_rows(tenant_id,job_id,row_no,child_command_id,state) VALUES (${tenants[0]}::uuid,${job}::uuid,1,${commandId}::uuid,'READY')`,
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_rows SET child_command_id=${randomUUID()}::uuid WHERE job_id=${job}::uuid`,
    ),
  );
  await scope(
    tenants[0]!,
    (tx) => tx.$executeRaw`UPDATE c360_import_rows SET state='APPLIED' WHERE job_id=${job}::uuid`,
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) => tx.$executeRaw`UPDATE c360_import_rows SET state='READY' WHERE job_id=${job}::uuid`,
    ),
  );
  await assert.rejects(
    scope(
      tenants[0]!,
      (tx) =>
        tx.$executeRaw`UPDATE c360_import_jobs SET owner_user_id=${users[1]}::uuid WHERE id=${job}::uuid`,
    ),
  );
});
