import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5ExportJobRepository } from './cg5-export-job-repository.js';
import { Cg5ExportLifecycleService } from './cg5-export-lifecycle.js';
import type { Cg5ExportObjectStorage } from './cg5-export-worker.js';

class Storage implements Cg5ExportObjectStorage {
  readonly deleted: string[] = [];
  async put(): Promise<void> {}
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

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
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cg5ExportJob.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const now = () => new Date('2026-09-20T00:00:00.000Z');
  const jobs = new Cg5ExportJobRepository(application, now);
  async function ready(expiresAt: Date) {
    const job = await jobs.request({
      tenantId,
      datasets: ['AUDIT_LOG'],
      rangeFrom: new Date('2026-09-01Z'),
      rangeTo: new Date('2026-09-02Z'),
      filters: {},
      evidenceLevel: 'SUMMARY',
      reason: 'retention',
      requestedByRef: 'user-1',
      idempotencyKey: randomUUID(),
    });
    await jobs.transition({
      tenantId,
      exportId: job.exportId,
      target: 'RUNNING',
      actorRef: 'worker',
    });
    return jobs.transition({
      tenantId,
      exportId: job.exportId,
      target: 'READY',
      actorRef: 'worker',
      storagePrefix: `governance-exports/${tenantId}/${job.exportId}`,
      manifestDigest: 'a'.repeat(64),
      rowCounts: { AUDIT_LOG: 1 },
      expiresAt,
    });
  }
  return { owner, application, tenantId, now, ready };
}

test('CG5.8 expiry และ data-erasure revoke ปิด job ก่อนลบ object', async (t) => {
  const f = await fixture(t);
  const expired = await f.ready(new Date('2026-09-19T00:00:00.000Z'));
  const active = await f.ready(new Date('2026-09-21T00:00:00.000Z'));
  const storage = new Storage();
  const lifecycle = new Cg5ExportLifecycleService(f.application, storage, f.now);
  assert.equal(await lifecycle.expireDue(f.tenantId), 1);
  assert.equal(
    (await f.owner.cg5ExportJob.findUniqueOrThrow({ where: { exportId: expired.exportId } })).state,
    'EXPIRED',
  );
  assert.equal(await lifecycle.revoke(f.tenantId, active.exportId), true);
  assert.equal(
    (await f.owner.cg5ExportJob.findUniqueOrThrow({ where: { exportId: active.exportId } })).state,
    'REVOKED',
  );
  assert.ok(storage.deleted.includes(`${active.storagePrefix}/manifest.json`));
  assert.equal(
    await f.owner.cgAuditLog.count({
      where: { tenantId: f.tenantId, action: { in: ['CG5_EXPORT_EXPIRED', 'CG5_EXPORT_REVOKED'] } },
    }),
    2,
  );
});
