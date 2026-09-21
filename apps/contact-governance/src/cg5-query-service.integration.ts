import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { CG5_EMPTY_DIMENSIONS, cg5DimensionKey } from '@d-contact/cxa-contracts';
import { Cg5ProjectionNotReadyError, Cg5QueryService } from './cg5-query-service.js';

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
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `CG5 query ${id}`, slug: id, sipDomain: `${id}.test` },
    });
  }
  t.after(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await owner.cg5MetricBucket.deleteMany({ where });
    await owner.cg5PolicyImpactBucket.deleteMany({ where });
    await owner.cg5AlertTransition.deleteMany({ where });
    await owner.cg5AlertState.deleteMany({ where });
    await owner.cg5ProjectionCursor.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, tenantId, otherTenantId, service: new Cg5QueryService(application) };
}

async function markReady(owner: PrismaClient, tenantId: string) {
  await owner.cg5ProjectionCursor.create({
    data: {
      tenantId,
      sourceKey: 'cg5.projection.readiness',
      state: 'READY',
      lastRunAt: new Date('2026-09-20T00:00:00.000Z'),
    },
  });
}

test('CG5.7 ปฏิเสธ projection ที่ยังไม่พร้อม', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.metrics(f.tenantId, { kind: 'TENANT' }, { granularity: 'FIVE_MIN', limit: 20 }),
    (error: unknown) =>
      error instanceof Cg5ProjectionNotReadyError && error.code === 'CG5_PROJECTION_NOT_READY',
  );
});

test('CG5.7 metrics กรอง tenant และ team scope ก่อน cursor paging', async (t) => {
  const f = await fixture(t);
  await markReady(f.owner, f.tenantId);
  await markReady(f.owner, f.otherTenantId);
  const teamA = randomUUID();
  const teamB = randomUUID();
  const at = new Date('2026-09-20T00:00:00.000Z');
  const insert = (tenantId: string, teamId: string, minute: number) =>
    f.owner.cg5MetricBucket.create({
      data: {
        tenantId,
        metricKey: 'cg.decision',
        granularity: 'FIVE_MIN',
        bucketStart: new Date(at.valueOf() + minute * 60_000),
        ...CG5_EMPTY_DIMENSIONS,
        teamId,
        dimensionKey: cg5DimensionKey({ ...CG5_EMPTY_DIMENSIONS, teamId }),
        value: 1,
        sampleCount: 1n,
        updatedAt: at,
      },
    });
  await Promise.all([
    insert(f.tenantId, teamA, 0),
    insert(f.tenantId, teamA, 5),
    insert(f.tenantId, teamB, 10),
    insert(f.otherTenantId, teamA, 15),
  ]);
  const page = await f.service.metrics(
    f.tenantId,
    { kind: 'TEAM', teamId: teamA },
    { granularity: 'FIVE_MIN', limit: 1 },
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.teamId, teamA);
  assert.ok(page.nextCursor);
  const next = await f.service.metrics(
    f.tenantId,
    { kind: 'TEAM', teamId: teamA },
    { granularity: 'FIVE_MIN', limit: 20, cursor: page.nextCursor! },
  );
  assert.deepEqual(
    next.items.map((item) => item.teamId),
    [teamA],
  );
  await assert.rejects(
    f.service.metrics(
      f.tenantId,
      { kind: 'TEAM', teamId: teamA },
      { granularity: 'FIVE_MIN', teamId: teamB, limit: 20 },
    ),
  );
});

test('CG5-AU01 SUPERVISOR เห็นเฉพาะทีมตัวเองและไม่เห็นยอดรวมของ tenant', async (t) => {
  const f = await fixture(t);
  await markReady(f.owner, f.tenantId);
  const teamA = randomUUID();
  const teamB = randomUUID();
  const at = new Date('2026-09-20T00:00:00.000Z');
  const bucket = (teamId: string | null, value: number) =>
    f.owner.cg5MetricBucket.create({
      data: {
        tenantId: f.tenantId,
        metricKey: 'cg.decision',
        granularity: 'HOUR',
        bucketStart: at,
        ...CG5_EMPTY_DIMENSIONS,
        teamId,
        dimensionKey: cg5DimensionKey({ ...CG5_EMPTY_DIMENSIONS, teamId }),
        value,
        sampleCount: BigInt(value),
        updatedAt: at,
      },
    });
  // แถว teamId=null คือยอดรวมทั้ง tenant ที่ Supervisor ต้องไม่เห็น
  await Promise.all([bucket(null, 30), bucket(teamA, 10), bucket(teamB, 20)]);
  await f.owner.cg5PolicyImpactBucket.create({
    data: {
      tenantId: f.tenantId,
      granularity: 'HOUR',
      bucketStart: at,
      policyVersion: 1,
      decision: 'BLOCK',
      value: 30n,
    },
  });
  await f.owner.cg5AlertState.createMany({
    data: [teamA, teamB, null].map((teamId, index) => ({
      tenantId: f.tenantId,
      ruleCode: 'CG5_BLOCK_RATE_SHIFT',
      scopeKey: cg5DimensionKey({ ...CG5_EMPTY_DIMENSIONS, teamId, reasonCode: String(index) }),
      state: 'OPEN' as const,
      severity: 'WARNING',
      teamId,
      value: 5,
      threshold: 3,
      consecutiveHits: 2,
      version: 1,
      updatedAt: at,
    })),
  });

  const supervisor = { kind: 'TEAM' as const, teamId: teamA };
  const metrics = await f.service.metrics(f.tenantId, supervisor, {
    granularity: 'HOUR',
    limit: 20,
  });
  assert.deepEqual(
    metrics.items.map((item) => [item.teamId, item.value]),
    [[teamA, '10']],
  );
  const alerts = await f.service.alerts(f.tenantId, supervisor, { limit: 20 });
  assert.deepEqual(
    alerts.items.map((item) => item.teamId),
    [teamA],
  );
  // ตารางผลกระทบไม่มีมิติทีม: คืนให้ Supervisor เท่ากับเผยยอดรวม tenant จึงต้องปฏิเสธ
  await assert.rejects(
    f.service.policyImpact(f.tenantId, supervisor, { granularity: 'HOUR', limit: 20 }),
  );

  const compliance = await f.service.metrics(
    f.tenantId,
    { kind: 'TENANT' },
    { granularity: 'HOUR', limit: 20 },
  );
  assert.equal(compliance.items.length, 3);
});
