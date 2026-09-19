import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5IncrementalProjectionReader } from './cg5-incremental-projection-reader.js';

const START = new Date('2026-09-19T10:00:00.000Z');

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
      name: `CG5.4 ${tenantId}`,
      slug: `cg54-${tenantId}`,
      sipDomain: `${tenantId}.cg54.test`,
    },
  });
  for (const [offset, decision] of ['ALLOW', 'BLOCK', 'DEFER'].entries()) {
    await owner.cgDecisionLog.create({
      data: {
        tenantId,
        channel: 'VOICE',
        purpose: 'SUPPORT',
        source: 'TEST',
        sourceId: `source-${offset}`,
        actionKey: `action-${offset}`,
        decision: decision as 'ALLOW' | 'BLOCK' | 'DEFER',
        reasonCode: `REASON_${offset}`,
        policyVersion: 7,
        gate: 'POLICY',
        trace: {},
        decidedAt: new Date(START.valueOf() + offset * 60_000),
      },
    });
  }
  return { owner, tenantId, application };
}

async function summary(owner: PrismaClient, tenantId: string) {
  const [metrics, impacts, cursor] = await Promise.all([
    owner.cg5MetricBucket.findMany({
      where: { tenantId, metricKey: 'cg.decision' },
      orderBy: { decision: 'asc' },
    }),
    owner.cg5PolicyImpactBucket.findMany({ where: { tenantId }, orderBy: { decision: 'asc' } }),
    owner.cg5ProjectionCursor.findMany({ where: { tenantId }, orderBy: { sourceKey: 'asc' } }),
  ]);
  return {
    metrics: metrics.map((row) => [row.decision, row.value.toString(), row.sampleCount]),
    impacts: impacts.map((row) => [row.decision, row.value]),
    cursor: cursor.map((row) => [
      row.sourceKey,
      row.lastProcessedAt?.toISOString(),
      row.lastProcessedId,
    ]),
  };
}

test('CG5.4 rerun และ interrupt/resume ให้ projection เดียวกับรันรวดเดียวโดยไม่แตะ canonical', async (t) => {
  const f = await fixture(t);
  const resumable = new Cg5IncrementalProjectionReader(f.application, 1, 1);
  await resumable.run(f.tenantId);
  const afterFirstBatch = await summary(f.owner, f.tenantId);
  assert.equal(afterFirstBatch.metrics.length, 1);

  await resumable.run(f.tenantId);
  await resumable.run(f.tenantId);
  const completed = await summary(f.owner, f.tenantId);
  assert.deepEqual(completed.metrics, [
    ['ALLOW', '1', 1n],
    ['BLOCK', '1', 1n],
    ['DEFER', '1', 1n],
  ]);
  assert.deepEqual(completed.impacts, [
    ['ALLOW', 1n],
    ['BLOCK', 1n],
    ['DEFER', 1n],
  ]);
  assert.equal(
    completed.cursor.find(([key]) => key === 'cg5.incremental.decision')?.[1],
    '2026-09-19T10:02:00.000Z',
  );

  await resumable.run(f.tenantId);
  assert.deepEqual(await summary(f.owner, f.tenantId), completed);
  assert.equal(await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }), 3);
});
