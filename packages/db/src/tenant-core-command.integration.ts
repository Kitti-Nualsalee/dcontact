import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from './index.js';

const owner = new PrismaClient();
const app = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
});
test.after(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});
async function ledgerFixture() {
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Core ledger fixture',
      slug: `core-ledger-${tenantId}`,
      sipDomain: `${tenantId}.core.test`,
    },
  });
  await owner.user.create({
    data: {
      id: actorUserId,
      tenantId,
      role: 'ADMIN',
      email: `${actorUserId}@core.test`,
      displayName: 'Core Admin',
      passwordHash: '!test-only',
    },
  });
  return {
    tenantId,
    actorUserId,
    actorIdentityKey: 'a'.repeat(64),
    commandId: randomUUID(),
    action: 'ORGANIZATION_UPDATE',
    resourceType: 'ORGANIZATION',
    resourceId: tenantId,
    payloadDigest: 'b'.repeat(64),
    expectedRevision: 0n,
  };
}

test('Core DB: admission ที่ต้อง CAS ห้าม expectedRevision=null และ NO_OP ห้าม revision=null', async () => {
  const command = await ledgerFixture();
  await assert.rejects(
    withTenantDatabaseTransaction(app, command.tenantId, (tx) =>
      tx.tenantCoreCommand.create({ data: { ...command, expectedRevision: null } }),
    ),
  );
  await withTenantDatabaseTransaction(app, command.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: command }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, command.tenantId, (tx) =>
      tx.tenantCoreCommandReceipt.create({
        data: {
          tenantId: command.tenantId,
          actorIdentityKey: command.actorIdentityKey,
          commandId: command.commandId,
          outcome: 'NO_OP',
          httpStatus: 200,
          resourceSnapshot: { id: command.resourceId, revision: '0' },
          committedRevision: null,
        },
      }),
    ),
  );
});

const keyOf = (c: Awaited<ReturnType<typeof ledgerFixture>>) => ({
  tenantId: c.tenantId,
  actorIdentityKey: c.actorIdentityKey,
  commandId: c.commandId,
});

test('Core DB: APPLIED ที่ขาด audit rollback resource/revision/receipt พร้อมกัน แต่ admission ยังอยู่', async () => {
  const c = await ledgerFixture();
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: c }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: c.tenantId }, data: { name: 'must rollback' } });
      await tx.tenantCoreProfileRevision.create({ data: { tenantId: c.tenantId, revision: 1n } });
      await tx.tenantCoreCommandReceipt.create({
        data: {
          ...keyOf(c),
          outcome: 'APPLIED',
          committedRevision: 1n,
          resourceSnapshot: { id: c.tenantId, revision: '1' },
          httpStatus: 200,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  await withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
    assert.equal(
      (await tx.tenant.findUniqueOrThrow({ where: { id: c.tenantId } })).name,
      'Core ledger fixture',
    );
    assert.equal(
      await tx.tenantCoreProfileRevision.findUnique({ where: { tenantId: c.tenantId } }),
      null,
    );
    const row = await tx.tenantCoreCommand.findUniqueOrThrow({
      where: { tenantId_actorIdentityKey_commandId: keyOf(c) },
      include: { receipt: true },
    });
    assert.equal(row.receipt, null);
  });
});

test('Core DB: audit ต้องตรง command/resource/revision/snapshot และมี APPLIED receipt', async () => {
  const c = await ledgerFixture();
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: c }),
  );
  const audit = {
    ...keyOf(c),
    actorUserId: c.actorUserId,
    action: c.action,
    resourceType: c.resourceType,
    resourceId: c.resourceId,
    beforeRevision: 0n,
    afterRevision: 1n,
    beforeValues: { id: c.resourceId, revision: '0' },
    afterValues: { id: c.resourceId, revision: '1' },
  };
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenantCoreConfigAudit.create({ data: audit });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenantCoreConfigAudit.create({ data: { ...audit, resourceId: randomUUID() } });
      await tx.tenantCoreCommandReceipt.create({
        data: {
          ...keyOf(c),
          outcome: 'APPLIED',
          committedRevision: 1n,
          resourceSnapshot: audit.afterValues,
          httpStatus: 200,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  await withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
    await tx.tenantCoreConfigAudit.create({ data: audit });
    await tx.tenantCoreCommandReceipt.create({
      data: {
        ...keyOf(c),
        outcome: 'APPLIED',
        committedRevision: 1n,
        resourceSnapshot: audit.afterValues,
        httpStatus: 200,
      },
    });
  });
  assert.equal(
    (
      await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
        tx.tenantCoreCommand.findUniqueOrThrow({
          where: { tenantId_actorIdentityKey_commandId: keyOf(c) },
          include: { receipt: true },
        }),
      )
    ).receipt?.outcome,
    'APPLIED',
  );
});

test('Core DB: NO_OP ต้องคง expected revision และ tombstone ต้องมี NOT_APPLIED proof', async () => {
  const c = await ledgerFixture();
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: c }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenantCoreCommandReceipt.create({
        data: {
          ...keyOf(c),
          outcome: 'NO_OP',
          committedRevision: 1n,
          resourceSnapshot: { id: c.resourceId, revision: '1' },
          httpStatus: 200,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenantCoreCommand.create({
        data: {
          ...keyOf(c),
          commandId: randomUUID(),
          actorUserId: c.actorUserId,
          isTombstone: true,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommandReceipt.create({
      data: {
        ...keyOf(c),
        outcome: 'NO_OP',
        committedRevision: 0n,
        resourceSnapshot: { id: c.resourceId, revision: '0' },
        httpStatus: 200,
      },
    }),
  );
});

test('Core DB/RLS: foreign tenant/actor และไม่มี tenant context มองไม่เห็น command', async () => {
  const a = await ledgerFixture();
  const b = await ledgerFixture();
  await withTenantDatabaseTransaction(app, a.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: a }),
  );
  assert.equal(
    await withTenantDatabaseTransaction(app, b.tenantId, (tx) =>
      tx.tenantCoreCommand.count({ where: keyOf(a) }),
    ),
    0,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, b.tenantId, (tx) =>
      tx.tenantCoreCommand.create({ data: { ...a, commandId: randomUUID() } }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, a.tenantId, (tx) =>
      tx.tenantCoreCommand.create({
        data: { ...a, commandId: randomUUID(), actorUserId: b.actorUserId },
      }),
    ),
  );
  assert.deepEqual(await app.tenantCoreCommand.findMany(), []);
});

test('Core DB grants: command/receipt/audit append-only และ proof ยัง SELECT-only หลัง apply-rls', async () => {
  const c = await ledgerFixture();
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: c }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(
      app,
      c.tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_core_commands SET payload_digest=${'c'.repeat(64)} WHERE tenant_id=${c.tenantId}::uuid`,
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(
      app,
      c.tenantId,
      (tx) => tx.$executeRaw`DELETE FROM tenant_core_commands WHERE tenant_id=${c.tenantId}::uuid`,
    ),
  );
  await assert.rejects(app.$executeRawUnsafe('TRUNCATE tenant_core_command_receipts'));
  await assert.rejects(
    withTenantDatabaseTransaction(
      app,
      c.tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false WHERE tenant_id=${c.tenantId}::uuid`,
    ),
  );
  const grants = await owner.$queryRaw<
    { table_name: string; privilege_type: string }[]
  >`SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='dcontact_app' AND table_name IN ('tenant_core_commands','tenant_core_command_receipts','tenant_core_config_audits','tenant_voice_identity_bindings')`;
  assert.ok(
    grants
      .filter((g) => g.table_name === 'tenant_voice_identity_bindings')
      .every((g) => g.privilege_type === 'SELECT'),
  );
  assert.ok(grants.every((g) => !['UPDATE', 'DELETE', 'TRUNCATE'].includes(g.privilege_type)));
});

test('Core DB: receipt ห้ามอ้าง snapshot ของ resource อื่น', async () => {
  const c = await ledgerFixture();
  await withTenantDatabaseTransaction(app, c.tenantId, (tx) =>
    tx.tenantCoreCommand.create({ data: c }),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(app, c.tenantId, async (tx) => {
      await tx.tenantCoreCommandReceipt.create({
        data: {
          ...keyOf(c),
          outcome: 'NO_OP',
          committedRevision: 0n,
          resourceSnapshot: { id: randomUUID(), revision: '0' },
          httpStatus: 200,
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }),
  );
});
