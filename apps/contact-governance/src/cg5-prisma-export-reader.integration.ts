import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { PrismaCg5CanonicalExportReader } from './cg5-prisma-export-reader.js';

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
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.cgAuditLog.create({
    data: {
      tenantId,
      mutationId: randomUUID(),
      aggregateType: 'CONTACT',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      action: 'TEST_AUDIT',
      actorClass: 'COMPLIANCE',
      actorRef: 'person:alice',
      sourceKind: 'COMPLIANCE',
      evidenceRef: 'case:secret-123',
      afterDigest: 'a'.repeat(64),
      occurredAt: new Date('2026-09-20T00:00:00.000Z'),
    },
  });
  return { tenantId, application };
}

test('CG5.8 canonical reader ดึงจาก audit canonical และ redacts SUMMARY', async (t) => {
  const f = await fixture(t);
  const reader = new PrismaCg5CanonicalExportReader(f.application);
  const input = {
    tenantId: f.tenantId,
    datasets: ['AUDIT_LOG'] as const,
    rangeFrom: new Date('2026-09-19Z'),
    rangeTo: new Date('2026-09-21Z'),
    filters: {},
    evidenceLevel: 'SUMMARY',
  };
  const summary = new TextDecoder().decode((await reader.read(input))[0]!.body);
  assert.doesNotMatch(summary, /person:alice|case:secret-123/);
  assert.match(summary, /redacted/);
  const evidence = new TextDecoder().decode(
    (await reader.read({ ...input, evidenceLevel: 'EVIDENCE' }))[0]!.body,
  );
  assert.match(evidence, /person:alice|case:secret-123/);
});
