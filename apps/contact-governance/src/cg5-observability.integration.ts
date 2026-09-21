import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5ExportJobRepository } from './cg5-export-job-repository.js';
import { Cg5IncrementalProjectionReader } from './cg5-incremental-projection-reader.js';
import {
  cg5MetricSamples,
  cg5ObservabilitySnapshot,
  evaluateCg5OperationalAlerts,
} from './cg5-observability.js';

const NOW = new Date('2026-09-21T01:00:00.000Z');

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
  await owner.tenant.create({
    data: { id: tenantId, name: tenantId, slug: tenantId, sipDomain: `${tenantId}.test` },
  });
  t.after(async () => {
    const where = { tenantId };
    await owner.cgEventOutbox.deleteMany({ where });
    await owner.cgAuditLog.deleteMany({ where });
    await owner.cg5ExportJob.deleteMany({ where });
    await owner.cg5MetricBucket.deleteMany({ where });
    await owner.cg5PolicyImpactBucket.deleteMany({ where });
    await owner.cg5ProjectionCursor.deleteMany({ where });
    await owner.cgDecisionLog.deleteMany({ where });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId };
}

test('CG5-OB01 snapshot อ่าน telemetry ของ projection และ export จากตารางจริงของ tenant', async (t) => {
  const f = await fixture(t);
  await f.owner.cgDecisionLog.create({
    data: {
      tenantId: f.tenantId,
      channel: 'VOICE',
      purpose: 'SUPPORT',
      source: 'TEST',
      sourceId: 'ob01',
      actionKey: 'ob01',
      decision: 'ALLOW',
      reasonCode: 'POLICY_ALLOW',
      policyVersion: 1,
      gate: 'POLICY',
      trace: {},
      decidedAt: new Date('2026-09-21T00:00:00.000Z'),
    },
  });
  await new Cg5IncrementalProjectionReader(f.application).run(f.tenantId);

  const jobs = new Cg5ExportJobRepository(f.application, () => NOW);
  const job = await jobs.request({
    tenantId: f.tenantId,
    datasets: ['AUDIT_LOG'],
    rangeFrom: new Date('2026-09-01Z'),
    rangeTo: new Date('2026-09-02Z'),
    filters: {},
    evidenceLevel: 'SUMMARY',
    reason: 'ob01 telemetry',
    requestedByRef: 'person:ob01',
    idempotencyKey: randomUUID(),
  });
  await jobs.transition({
    tenantId: f.tenantId,
    exportId: job.exportId,
    target: 'RUNNING',
    actorRef: 'cg5-export-worker',
  });
  await jobs.transition({
    tenantId: f.tenantId,
    exportId: job.exportId,
    target: 'FAILED',
    actorRef: 'cg5-export-worker',
  });

  // เวลาที่ใช้ตรวจอยู่หลังรอบ reader จริงหนึ่งวัน เพื่อให้ lag เกิน SLO แน่นอนโดยไม่ขึ้นกับนาฬิกาเครื่อง
  const observedAt = new Date(Date.now() + 86_400_000);
  const snapshot = await cg5ObservabilitySnapshot(f.application, {
    tenantId: f.tenantId,
    now: observedAt,
    windowSeconds: 7 * 86_400,
  });
  assert.equal(snapshot.tenantId, f.tenantId);
  assert.ok(
    snapshot.projection.sources.some(({ source }) => source === 'cg5.incremental.decision'),
  );
  assert.ok(snapshot.projection.sources.every(({ lastRunAgeSeconds }) => lastRunAgeSeconds! > 0));
  assert.equal(snapshot.exports.byState.FAILED, 1);
  assert.ok(snapshot.exports.auditEventsInWindow >= 1);

  const codes = evaluateCg5OperationalAlerts(snapshot).map(({ code }) => code);
  assert.ok(codes.includes('GOVERNANCE_CG5_PROJECTION_LAG'));
  assert.ok(codes.includes('GOVERNANCE_CG5_EXPORT_FAILED'));

  // telemetry ต้องไม่พาข้อมูล requester, reason หรือ export id ออกไป
  const serialized = JSON.stringify({ snapshot, samples: cg5MetricSamples(snapshot) });
  assert.doesNotMatch(serialized, /person:ob01|ob01 telemetry/);
  assert.ok(!serialized.includes(job.exportId));

  // tenant อื่นมองไม่เห็นตัวเลขของ tenant นี้ผ่าน RLS
  const other = await f.owner.tenant.create({
    data: {
      id: randomUUID(),
      name: 'ob01-other',
      slug: `ob01-${randomUUID()}`,
      sipDomain: `${randomUUID()}.test`,
    },
  });
  t.after(() => f.owner.tenant.delete({ where: { id: other.id } }));
  const empty = await cg5ObservabilitySnapshot(f.application, {
    tenantId: other.id,
    now: observedAt,
  });
  assert.equal(empty.exports.byState.FAILED, 0);
  assert.deepEqual(empty.projection.sources, []);
});
