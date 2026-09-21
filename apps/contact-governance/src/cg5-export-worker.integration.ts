import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5ExportJobRepository } from './cg5-export-job-repository.js';
import { PrismaCg5CanonicalExportReader } from './cg5-prisma-export-reader.js';
import {
  Cg5ExportWorker,
  type Cg5CanonicalExportReader,
  type Cg5ExportObjectStorage,
} from './cg5-export-worker.js';

class MemoryStorage implements Cg5ExportObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  failAfter = Number.POSITIVE_INFINITY;
  async put(key: string, body: Uint8Array) {
    if (this.objects.size >= this.failAfter) throw new Error('storage write failed');
    this.objects.set(key, body);
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}
const reader: Cg5CanonicalExportReader = {
  read: async () => [
    { dataset: 'AUDIT_LOG', body: new TextEncoder().encode('{"rows":1}'), rowCount: 1 },
  ],
};

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
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgRestriction.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const now = () => new Date('2026-09-20T00:00:00Z');
  const jobs = new Cg5ExportJobRepository(application, now);
  const job = await jobs.request({
    tenantId,
    datasets: ['AUDIT_LOG'],
    rangeFrom: new Date('2026-09-01Z'),
    rangeTo: new Date('2026-09-02Z'),
    filters: {},
    evidenceLevel: 'SUMMARY',
    reason: 'review',
    requestedByRef: 'user-1',
    idempotencyKey: randomUUID(),
  });
  return { owner, application, tenantId, job, now };
}

test('CG5.8 worker เขียน manifest ที่ hash ตรงกับไฟล์ canonical', async (t) => {
  const f = await fixture(t);
  const storage = new MemoryStorage();
  await new Cg5ExportWorker(f.application, storage, reader, f.now).run(f.tenantId, f.job.exportId);
  const manifestBody = storage.objects.get(
    `governance-exports/${f.tenantId}/${f.job.exportId}/manifest.json`,
  )!;
  const manifest = JSON.parse(new TextDecoder().decode(manifestBody)) as {
    fileDigests: Record<string, string>;
    requestedByRef: string;
  };
  assert.equal(manifest.requestedByRef, 'redacted:c6c289e49e9c05b2');
  const body = storage.objects.get(
    `governance-exports/${f.tenantId}/${f.job.exportId}/AUDIT_LOG.json`,
  )!;
  assert.equal(manifest.fileDigests.AUDIT_LOG, createHash('sha256').update(body).digest('hex'));
  assert.equal(
    (await f.owner.cg5ExportJob.findUniqueOrThrow({ where: { exportId: f.job.exportId } })).state,
    'READY',
  );
});
test('CG5-F06 export ครบ 4 ชุดจาก canonical พร้อม manifest ที่ hash และ rowCount ตรวจได้', async (t) => {
  const f = await fixture(t);
  const at = new Date('2026-09-01T06:00:00.000Z');
  await f.owner.cgDecisionLog.create({
    data: {
      tenantId: f.tenantId,
      channel: 'VOICE',
      purpose: 'SUPPORT',
      source: 'TEST',
      sourceId: 'source-f06',
      actionKey: 'action-f06',
      decision: 'BLOCK',
      reasonCode: 'CG5_F06',
      policyVersion: 1,
      gate: 'POLICY',
      trace: {},
      decidedAt: at,
    },
  });
  await f.owner.cgAuditLog.create({
    data: {
      tenantId: f.tenantId,
      mutationId: randomUUID(),
      aggregateType: 'CONTACT',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      action: 'TEST_AUDIT',
      actorClass: 'COMPLIANCE',
      actorRef: 'person:f06',
      sourceKind: 'COMPLIANCE',
      evidenceRef: 'case:f06',
      afterDigest: 'a'.repeat(64),
      occurredAt: at,
    },
  });
  await f.owner.cgRestriction.create({
    data: {
      tenantId: f.tenantId,
      type: 'DNC',
      channel: 'VOICE',
      purpose: 'SUPPORT',
      scope: 'CHANNEL',
      reasonCode: 'CG5_F06',
      source: 'TEST',
      createdBy: 'person:f06',
      createdAt: at,
    },
  });
  const datasets = ['DECISION_TRACE', 'AUDIT_LOG', 'RESTRICTION_CONSENT', 'EXCEPTION_APPROVAL'];
  const job = await new Cg5ExportJobRepository(f.application, f.now).request({
    tenantId: f.tenantId,
    datasets: datasets as never,
    rangeFrom: new Date('2026-09-01Z'),
    rangeTo: new Date('2026-09-02Z'),
    filters: {},
    evidenceLevel: 'SUMMARY',
    reason: 'quarterly review',
    requestedByRef: 'user-1',
    idempotencyKey: randomUUID(),
  });
  const storage = new MemoryStorage();
  await new Cg5ExportWorker(
    f.application,
    storage,
    new PrismaCg5CanonicalExportReader(f.application),
    f.now,
  ).run(f.tenantId, job.exportId);

  const prefix = `governance-exports/${f.tenantId}/${job.exportId}`;
  assert.deepEqual(
    [...storage.objects.keys()].sort(),
    [...datasets.map((dataset) => `${prefix}/${dataset}.json`), `${prefix}/manifest.json`].sort(),
  );
  const manifest = JSON.parse(
    new TextDecoder().decode(storage.objects.get(`${prefix}/manifest.json`)!),
  ) as {
    datasets: string[];
    fileDigests: Record<string, string>;
    rowCounts: Record<string, number>;
    tenantWatermark: string;
  };
  assert.deepEqual(manifest.datasets, datasets);
  assert.deepEqual(manifest.rowCounts, {
    DECISION_TRACE: 1,
    AUDIT_LOG: 1,
    RESTRICTION_CONSENT: 1,
    EXCEPTION_APPROVAL: 0,
  });
  for (const dataset of datasets) {
    const body = storage.objects.get(`${prefix}/${dataset}.json`)!;
    assert.equal(
      manifest.fileDigests[dataset],
      createHash('sha256').update(body).digest('hex'),
      dataset,
    );
    assert.doesNotMatch(new TextDecoder().decode(body), /person:f06|source-f06/, dataset);
  }
  assert.match(manifest.tenantWatermark, /^[a-f0-9]{64}$/);
  const stored = await f.owner.cg5ExportJob.findUniqueOrThrow({
    where: { exportId: job.exportId },
  });
  assert.equal(stored.state, 'READY');
  assert.equal(
    stored.manifestDigest,
    createHash('sha256')
      .update(storage.objects.get(`${prefix}/manifest.json`)!)
      .digest('hex'),
  );
});

test('CG5.8 worker ล้าง object ที่เขียนก่อน failure แล้ว mark FAILED', async (t) => {
  const f = await fixture(t);
  const storage = new MemoryStorage();
  storage.failAfter = 1;
  await assert.rejects(
    new Cg5ExportWorker(f.application, storage, reader, f.now).run(f.tenantId, f.job.exportId),
  );
  assert.equal(storage.objects.size, 0);
  assert.ok(storage.deleted.length > 0);
  assert.equal(
    (await f.owner.cg5ExportJob.findUniqueOrThrow({ where: { exportId: f.job.exportId } })).state,
    'FAILED',
  );
});
