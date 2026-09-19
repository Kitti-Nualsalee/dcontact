import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5IncrementalProjectionReader } from './cg5-incremental-projection-reader.js';
import { Cg5ProjectionMaintenance } from './cg5-projection-maintenance.js';

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
