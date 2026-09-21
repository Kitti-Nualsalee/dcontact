import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5IncrementalProjectionReader } from './cg5-incremental-projection-reader.js';
import { Cg5ProjectionMaintenance } from './cg5-projection-maintenance.js';
import { Cg5ProjectionNotReadyError, Cg5QueryService } from './cg5-query-service.js';

const START = new Date('2026-01-10T10:00:00.000Z');
const NOW = new Date('2026-05-01T00:00:00.000Z');

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
  t.after(async () => {
    await owner.cg5MetricBucket.deleteMany({ where: { tenantId } });
    await owner.cg5PolicyImpactBucket.deleteMany({ where: { tenantId } });
    await owner.cg5ProjectionCursor.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG5.5 ${tenantId}`,
      slug: `cg55-${tenantId}`,
      sipDomain: `${tenantId}.cg55.test`,
    },
  });
  for (const [offset, decision] of ['ALLOW', 'ALLOW', 'ALLOW'].entries()) {
    await owner.cgDecisionLog.create({
      data: {
        tenantId,
        channel: 'VOICE',
        purpose: 'SUPPORT',
        source: 'TEST',
        sourceId: `source-${offset}`,
        actionKey: `action-${offset}`,
        decision: decision as 'ALLOW',
        reasonCode: 'POLICY_ALLOW',
        policyVersion: 7,
        gate: 'POLICY',
        trace: {},
        decidedAt: new Date(START.valueOf() + [0, 5, 60][offset]! * 60_000),
      },
    });
  }
  return { owner, application, tenantId };
}

async function snapshot(owner: PrismaClient, tenantId: string) {
  const [metrics, impacts] = await Promise.all([
    owner.cg5MetricBucket.findMany({
      where: { tenantId, metricKey: 'cg.decision' },
      orderBy: [{ granularity: 'asc' }, { bucketStart: 'asc' }],
    }),
    owner.cg5PolicyImpactBucket.findMany({
      where: { tenantId },
      orderBy: [{ granularity: 'asc' }, { bucketStart: 'asc' }],
    }),
  ]);
  return {
    metrics: metrics.map((row) => [
      row.granularity,
      row.bucketStart.toISOString(),
      row.value.toString(),
      row.sampleCount,
    ]),
    impacts: impacts.map((row) => [row.granularity, row.bucketStart.toISOString(), row.value]),
  };
}

test('CG5.5 rebuild ซ้ำได้, readiness ชัดเจน และ retention ไม่แตะ canonical', async (t) => {
  const f = await fixture(t);
  const maintenance = new Cg5ProjectionMaintenance(f.application, () => NOW);
  assert.equal((await maintenance.readiness(f.tenantId)).state, 'NOT_READY');

  await maintenance.rebuild(f.tenantId, {
    from: new Date('2026-01-10T00:00:00.000Z'),
    to: new Date('2026-01-11T00:00:00.000Z'),
  });
  assert.equal((await maintenance.readiness(f.tenantId)).state, 'READY');
  const first = await snapshot(f.owner, f.tenantId);
  assert.deepEqual(first.metrics, [
    ['FIVE_MIN', '2026-01-10T10:00:00.000Z', '1', 1n],
    ['FIVE_MIN', '2026-01-10T10:05:00.000Z', '1', 1n],
    ['FIVE_MIN', '2026-01-10T11:00:00.000Z', '1', 1n],
    ['HOUR', '2026-01-10T10:00:00.000Z', '2', 2n],
    ['HOUR', '2026-01-10T11:00:00.000Z', '1', 1n],
    ['DAY', '2026-01-10T00:00:00.000Z', '3', 3n],
  ]);

  await maintenance.rebuild(f.tenantId, {
    from: new Date('2026-01-10T00:00:00.000Z'),
    to: new Date('2026-01-11T00:00:00.000Z'),
  });
  assert.deepEqual(await snapshot(f.owner, f.tenantId), first);
  const incremental = await new Cg5IncrementalProjectionReader(f.application).run(f.tenantId);
  assert.deepEqual(incremental.processed, { DECISION: 0, ATTEMPT: 0, TOUCH: 0, RESERVATION: 0 });
  assert.deepEqual(await snapshot(f.owner, f.tenantId), first);

  await maintenance.applyRetention(f.tenantId);
  const afterRetention = await snapshot(f.owner, f.tenantId);
  assert.deepEqual(afterRetention.metrics, [['DAY', '2026-01-10T00:00:00.000Z', '3', 3n]]);
  assert.equal(await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }), 3);
});

/**
 * CG5-MG02 (#273 §4): fixture ข้ามเดือนแบบย่อขนาด — ปริมาณน้อยแต่คร่อมรอยต่อ ก.พ./มี.ค./เม.ย./พ.ค./มิ.ย.
 * เพื่อพิสูจน์ rollup ข้ามชั้นและ retention ของสามชั้น (default 14 วัน/90 วัน/13 เดือน) บนข้อมูลจริง
 */
const DRILL_NOW = new Date('2026-06-10T00:00:00.000Z');
const DRILL_DECISIONS = [
  '2026-02-28T23:58:00.000Z',
  '2026-03-01T00:02:00.000Z',
  '2026-03-31T23:59:00.000Z',
  '2026-04-01T00:01:00.000Z',
  '2026-05-31T23:57:00.000Z',
  '2026-06-01T00:03:00.000Z',
  '2026-06-01T00:04:00.000Z',
];

async function drillTenant(t: TestContext, owner: PrismaClient, label: string) {
  const tenantId = randomUUID();
  t.after(async () => {
    await owner.cg5MetricBucket.deleteMany({ where: { tenantId } });
    await owner.cg5PolicyImpactBucket.deleteMany({ where: { tenantId } });
    await owner.cg5ProjectionCursor.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG5 MG02 ${label} ${tenantId}`,
      slug: `cg5-mg02-${tenantId}`,
      sipDomain: `${tenantId}.cg5-mg02.test`,
    },
  });
  for (const [index, decidedAt] of DRILL_DECISIONS.entries()) {
    await owner.cgDecisionLog.create({
      data: {
        tenantId,
        channel: 'VOICE',
        purpose: 'SUPPORT',
        source: 'TEST',
        sourceId: `drill-${index}`,
        actionKey: `drill-action-${index}`,
        decision: 'ALLOW',
        reasonCode: 'POLICY_ALLOW',
        policyVersion: 3,
        gate: 'POLICY',
        trace: {},
        decidedAt: new Date(decidedAt),
      },
    });
  }
  return tenantId;
}

test('CG5-MG02 backfill/rebuild drill ข้ามเดือน: เต็มตาม retention, ซ้ำได้, รันต่อหลังล่มได้ผลเท่ารันรวดเดียว', async (t) => {
  const f = await fixture(t);
  const maintenance = new Cg5ProjectionMaintenance(f.application, () => DRILL_NOW);
  const queries = new Cg5QueryService(f.application);
  const single = await drillTenant(t, f.owner, 'single');
  const resumed = await drillTenant(t, f.owner, 'resumed');

  // รันรวดเดียว
  await maintenance.backfill(single);
  const expected = await snapshot(f.owner, single);
  assert.deepEqual(expected.metrics, [
    // 5 นาทีเก็บเฉพาะ 14 วันล่าสุด
    ['FIVE_MIN', '2026-05-31T23:55:00.000Z', '1', 1n],
    ['FIVE_MIN', '2026-06-01T00:00:00.000Z', '2', 2n],
    // รายชั่วโมงเก็บ 90 วัน: ตัดที่ 2026-03-12 จึงเหลือตั้งแต่รอยต่อ มี.ค./เม.ย.
    ['HOUR', '2026-03-31T23:00:00.000Z', '1', 1n],
    ['HOUR', '2026-04-01T00:00:00.000Z', '1', 1n],
    ['HOUR', '2026-05-31T23:00:00.000Z', '1', 1n],
    ['HOUR', '2026-06-01T00:00:00.000Z', '2', 2n],
    // รายวันเก็บ 13 เดือน: ครบทุกวันและไม่ไหลข้ามรอยต่อเดือน
    ['DAY', '2026-02-28T00:00:00.000Z', '1', 1n],
    ['DAY', '2026-03-01T00:00:00.000Z', '1', 1n],
    ['DAY', '2026-03-31T00:00:00.000Z', '1', 1n],
    ['DAY', '2026-04-01T00:00:00.000Z', '1', 1n],
    ['DAY', '2026-05-31T00:00:00.000Z', '1', 1n],
    ['DAY', '2026-06-01T00:00:00.000Z', '2', 2n],
  ]);
  assert.equal(
    expected.impacts
      .filter(([granularity]) => granularity === 'DAY')
      .reduce((sum, [, , value]) => sum + (value as bigint), 0n),
    BigInt(DRILL_DECISIONS.length),
  );

  // rebuild ช่วงเดิมซ้ำต้องได้ตัวเลขเท่าเดิมทุกแถว
  await maintenance.backfill(single);
  assert.deepEqual(await snapshot(f.owner, single), expected);

  // ทำไปครึ่งทางแล้ว process ล่ม: readiness ค้างที่ BACKFILL_RUNNING และหน้าจอต้องได้ "ไม่พร้อม"
  await maintenance.rebuild(resumed, {
    from: new Date('2026-02-01T00:00:00.000Z'),
    to: new Date('2026-04-01T00:00:00.000Z'),
  });
  await f.owner.cg5ProjectionCursor.update({
    where: {
      tenantId_sourceKey: { tenantId: resumed, sourceKey: 'cg5.projection.readiness' },
    },
    data: { state: 'BACKFILL_RUNNING' },
  });
  await assert.rejects(
    queries.metrics(resumed, { kind: 'TENANT' }, { granularity: 'DAY', limit: 20 }),
    (error: unknown) =>
      error instanceof Cg5ProjectionNotReadyError && error.state === 'BACKFILL_RUNNING',
  );

  // รันต่อจนจบต้องได้ผลเท่ากับรันรวดเดียวทุกแถว
  await maintenance.backfill(resumed);
  assert.equal((await maintenance.readiness(resumed)).state, 'READY');
  assert.deepEqual(await snapshot(f.owner, resumed), expected);
  const page = await queries.metrics(
    resumed,
    { kind: 'TENANT' },
    { granularity: 'DAY', metricKey: 'cg.decision', limit: 20 },
  );
  assert.equal(page.items.length, 6);
  assert.equal(
    await f.owner.cgDecisionLog.count({ where: { tenantId: { in: [single, resumed] } } }),
    DRILL_DECISIONS.length * 2,
  );
});
