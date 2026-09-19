import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  CG5_DEFAULT_TENANT_CONFIG,
  CG5_EMPTY_DIMENSIONS,
  cg5DimensionKey,
} from '@d-contact/cxa-contracts';
import { PrismaCg5TenantConfigRepository } from './cg5-tenant-config-repository.js';
import { Cg3VersionConflictError } from './cg3-persistence.js';

async function fixture(t: TestContext) {
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
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const where = { tenantId: { in: [tenantId, otherTenantId] } };
  t.after(async () => {
    try {
      await owner.cg5TenantConfigAudit.deleteMany({ where });
      await owner.cg5TenantConfig.deleteMany({ where });
      await owner.cg5MetricBucket.deleteMany({ where });
      await owner.cg5AlertTransition.deleteMany({ where });
      await owner.cg5AlertState.deleteMany({ where });
      await owner.cg5ExportJob.deleteMany({ where });
      await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    } finally {
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    }
  });
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: 'CG5 fixture', slug: id, sipDomain: `${id}.test` },
    });
  }
  const repository = new PrismaCg5TenantConfigRepository(application);
  const input = {
    tenantId,
    expectedVersion: 0,
    config: CG5_DEFAULT_TENANT_CONFIG,
    actorRef: 'actor:synthetic',
    evidenceRef: 'evidence:cg5-test',
  };
  return { owner, application, repository, tenantId, otherTenantId, input };
}

test('CG5 config ใช้ defaults โดยไม่เขียน และเก็บ audit ของทุกการเปลี่ยน', async (t) => {
  const { owner, repository, input, tenantId } = await fixture(t);
  const initial = await repository.read(tenantId);
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.config, CG5_DEFAULT_TENANT_CONFIG);
  assert.equal(await owner.cg5TenantConfig.count({ where: { tenantId } }), 0);
  assert.equal((await repository.update(input)).version, 1);
  const updated = await repository.update({
    ...input,
    expectedVersion: 1,
    config: { ...input.config, refreshIntervalSeconds: 60 },
  });
  assert.equal(updated.version, 2);
  assert.equal((await repository.read(tenantId)).config.refreshIntervalSeconds, 60);
  const audit = await owner.cg5TenantConfigAudit.findMany({
    where: { tenantId },
    orderBy: { resultingVersion: 'asc' },
  });
  assert.deepEqual(
    audit.map((row) => row.action),
    ['CREATED', 'UPDATED'],
  );
  assert.equal(audit[0]?.afterDigest, audit[1]?.beforeDigest);
});

test('CG5 concurrent create/update มีผู้ชนะหนึ่งคำสั่ง และ conflict audit ไม่ rollback', async (t) => {
  const { owner, repository, input, tenantId } = await fixture(t);
  for (const expectedVersion of [0, 1]) {
    const results = await Promise.allSettled([
      repository.update({ ...input, expectedVersion }),
      repository.update({
        ...input,
        expectedVersion,
        config: { ...input.config, refreshIntervalSeconds: 60 },
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(
      rejected?.status === 'rejected' && rejected.reason instanceof Cg3VersionConflictError,
    );
    assert.equal((await repository.read(tenantId)).version, expectedVersion + 1);
  }
  const conflicts = await owner.cg5TenantConfigAudit.findMany({
    where: { tenantId, action: 'VERSION_CONFLICT' },
  });
  assert.equal(conflicts.length, 2);
  for (const row of conflicts) {
    assert.equal(row.beforeDigest, row.afterDigest);
    assert.equal(row.actualVersion, row.resultingVersion);
  }
});

test('CG5 config ปฏิเสธค่านอกช่วงและ field แปลกโดยไม่เปลี่ยนค่าเดิม', async (t) => {
  const { owner, repository, input, tenantId } = await fixture(t);
  await repository.update(input);
  await assert.rejects(
    repository.update({
      ...input,
      expectedVersion: 1,
      config: { ...input.config, refreshIntervalSeconds: 1 },
    }),
  );
  await assert.rejects(
    repository.update({
      ...input,
      expectedVersion: 1,
      config: Object.assign({}, input.config, { email: 'fixture@example.test' }),
    }),
  );
  assert.equal((await repository.read(tenantId)).version, 1);
  // DB บังคับช่วงค่าแม้ caller ไม่ผ่าน repository
  await assert.rejects(
    owner.cg5TenantConfig.update({
      where: { tenantId },
      data: { config: { ...input.config, exportMaxPerDay: 51 } },
    }),
  );
  await assert.rejects(
    owner.cg5TenantConfig.update({
      where: { tenantId },
      data: { config: { ...input.config, email: 'fixture@example.test' } },
    }),
  );
});

test('CG5 dimensionKey ปิดช่อง duplicate เมื่อมิติเป็น null และแยก team scope', async (t) => {
  const { owner, tenantId } = await fixture(t);
  const data = {
    tenantId,
    metricKey: 'cg.decision',
    granularity: 'FIVE_MIN' as const,
    bucketStart: new Date('2026-09-19T00:00:00Z'),
    dimensionKey: cg5DimensionKey(CG5_EMPTY_DIMENSIONS),
    value: 1,
    sampleCount: 1n,
    updatedAt: new Date(),
  };
  await owner.cg5MetricBucket.create({ data });
  await assert.rejects(
    owner.cg5MetricBucket.create({ data }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'P2002',
  );
  const teamId = randomUUID();
  await owner.cg5MetricBucket.create({
    data: { ...data, teamId, dimensionKey: cg5DimensionKey({ ...CG5_EMPTY_DIMENSIONS, teamId }) },
  });
  assert.equal(await owner.cg5MetricBucket.count({ where: { tenantId } }), 2);
});

test('CG5 RLS กันข้าม tenant และ config audit แก้หรือลบไม่ได้', async (t) => {
  const { owner, application, repository, tenantId, otherTenantId, input } = await fixture(t);
  await repository.update(input);
  await withTenantDatabaseTransaction(application, otherTenantId, async (tx) => {
    assert.equal(await tx.cg5TenantConfig.count({ where: { tenantId } }), 0);
    assert.equal(await tx.cg5TenantConfigAudit.count({ where: { tenantId } }), 0);
  });
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (tx) =>
      tx.cg5TenantConfig.create({
        data: {
          tenantId: otherTenantId,
          config: { ...input.config },
          version: 1,
          updatedByRef: input.actorRef,
          evidenceRef: input.evidenceRef,
          updatedAt: new Date(),
        },
      }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (tx) =>
      tx.cg5TenantConfigAudit.updateMany({ where: { tenantId }, data: { actorRef: 'changed' } }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (tx) =>
      tx.cg5TenantConfigAudit.deleteMany({ where: { tenantId } }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (tx) =>
      tx.cg5TenantConfig.deleteMany({ where: { tenantId } }),
    ),
  );
  assert.equal(await owner.cg5TenantConfigAudit.count({ where: { tenantId } }), 1);
});

test('CG5 ตารางใหม่ทุกตารางเปิด RLS และ bootstrap คงสิทธิ์ audit', async (t) => {
  const { owner } = await fixture(t);
  const rows = await owner.$queryRaw<
    Array<{ relname: string; relrowsecurity: boolean }>
  >`SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'cg5_%' AND relkind = 'r'`;
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.relrowsecurity));
  const rights = await owner.$queryRaw<
    Array<{ update: boolean; delete: boolean }>
  >`SELECT has_table_privilege('dcontact_app', 'cg5_alert_transition', 'UPDATE') AS update, has_table_privilege('dcontact_app', 'cg5_alert_transition', 'DELETE') AS delete`;
  assert.deepEqual(rights, [{ update: false, delete: false }]);
  const columns = await owner.$queryRaw<Array<{ isNullable: string }>>`
    SELECT is_nullable AS "isNullable"
    FROM information_schema.columns
    WHERE table_name = 'cg5_export_job' AND column_name = 'datasets'
  `;
  assert.deepEqual(columns, [{ isNullable: 'NO' }]);
  const policies = await owner.$queryRaw<Array<{ predicate: string }>>`
    SELECT pg_get_expr(polqual, polrelid) AS predicate
    FROM pg_policy
    WHERE polname = 'tenant_isolation' AND polrelid = 'cg5_export_job'::regclass
  `;
  assert.equal(policies.length, 1);
  assert.doesNotMatch(policies[0]!.predicate, /NULLIF/);
});
