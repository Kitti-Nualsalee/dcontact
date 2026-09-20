import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  Cg5ExportIdempotencyConflictError,
  Cg5ExportJobRepository,
} from './cg5-export-job-repository.js';

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
    data: {
      id: tenantId,
      name: `CG5 export ${tenantId}`,
      slug: tenantId,
      sipDomain: `${tenantId}.test`,
    },
  });
  t.after(async () => {
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cg5ExportJob.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return {
    owner,
    tenantId,
    repository: new Cg5ExportJobRepository(application, () => new Date('2026-09-20T00:00:00.000Z')),
  };
}

test('CG5.8 export request idempotent และ transition เขียน audit/outbox', async (t) => {
  const f = await fixture(t);
  const input = {
    tenantId: f.tenantId,
    datasets: ['AUDIT_LOG'] as const,
    rangeFrom: new Date('2026-09-01T00:00:00Z'),
    rangeTo: new Date('2026-09-02T00:00:00Z'),
    filters: {},
    evidenceLevel: 'SUMMARY' as const,
    reason: 'audit review',
    requestedByRef: 'user-1',
    idempotencyKey: 'export-1',
  };
  const job = await f.repository.request(input);
  assert.equal((await f.repository.request(input)).exportId, job.exportId);
  await assert.rejects(
    f.repository.request({ ...input, reason: 'different' }),
    Cg5ExportIdempotencyConflictError,
  );
  await f.repository.transition({
    tenantId: f.tenantId,
    exportId: job.exportId,
    target: 'RUNNING',
    actorRef: 'worker',
  });
  await f.repository.transition({
    tenantId: f.tenantId,
    exportId: job.exportId,
    target: 'FAILED',
    actorRef: 'worker',
  });
  assert.equal(
    (await f.owner.cg5ExportJob.findUniqueOrThrow({ where: { exportId: job.exportId } })).state,
    'FAILED',
  );
  assert.equal(
    await f.owner.cgAuditLog.count({ where: { tenantId: f.tenantId, aggregateType: 'EXPORT' } }),
    3,
  );
  assert.equal(
    await f.owner.cgEventOutbox.count({ where: { tenantId: f.tenantId, aggregateType: 'EXPORT' } }),
    3,
  );
});
