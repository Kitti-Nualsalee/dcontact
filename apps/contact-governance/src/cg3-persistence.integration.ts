import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  Cg3IdempotencyConflictError,
  Cg3PreferenceRepository,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  type AppendPreferenceInput,
} from './cg3-persistence.js';

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
  const contactId = randomUUID();
  const identityId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  t.after(async () => {
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgConsumerAcknowledgement.deleteMany({ where: { tenantId } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cgPreference.deleteMany({ where: { tenantId } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG3 ${suffix}`,
      slug: `cg3-${suffix}`,
      sipDomain: `${suffix}.cg3.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  await owner.contactIdentity.create({
    data: { id: identityId, tenantId, contactId, type: 'LINE', value: `line-${suffix}` },
  });
  return { owner, application, tenantId, contactId, identityId };
}

function command(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<AppendPreferenceInput> = {},
): AppendPreferenceInput {
  return {
    tenantId: f.tenantId,
    contactId: f.contactId,
    identityId: f.identityId,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: 'SERVICE',
    decision: 'BLOCK',
    timezone: 'Asia/Bangkok',
    preferredWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '17:00' }],
    sourceKind: 'CUSTOMER',
    sourceVersion: 'customer-v1',
    occurredAt: '2026-09-11T02:00:00.000Z',
    effectiveFrom: '2026-09-11T02:00:00.000Z',
    evidenceRef: 'evidence:preference:1',
    actorClass: 'CUSTOMER',
    actorRef: 'actor:customer:opaque',
    idempotencyKey: 'preference-command-1',
    expectedVersion: 0,
    correlationId: 'correlation-1',
    ...overrides,
  };
}

test('append preference สร้าง version/head/evidence แบบ atomic และ canonical retry คืนผลเดิม', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  const created = await repository.append(command(f));
  const retried = await repository.append(command(f, { correlationId: 'retry-correlation' }));
  const history = await repository.history({ tenantId: f.tenantId, contactId: f.contactId });
  const evidence = await repository.mutationEvidence({
    tenantId: f.tenantId,
    mutationId: created.mutationId,
  });

  assert.deepEqual(retried, created);
  assert.equal(created.aggregateVersion, 1);
  assert.equal(created.preference.version, 1);
  assert.deepEqual(history, [created.preference]);
  assert.deepEqual(evidence, {
    aggregateVersion: 1,
    auditCount: 1,
    outboxCount: 1,
    receiptCount: 1,
  });
});

test('lazy head เริ่มที่ version 0 โดยไม่สร้าง fake preference, audit หรือ outbox', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  const first = await repository.ensureHead({ tenantId: f.tenantId, contactId: f.contactId });
  const retried = await repository.ensureHead({ tenantId: f.tenantId, contactId: f.contactId });

  assert.deepEqual(retried, first);
  assert.equal(first.aggregateVersion, 0);
  assert.equal(first.latestMutationId, undefined);
  assert.deepEqual(await repository.history({ tenantId: f.tenantId, contactId: f.contactId }), []);
  assert.equal(
    await repository.mutationEvidence({ tenantId: f.tenantId, mutationId: randomUUID() }),
    undefined,
  );
});

test('idempotency key เดิมปฏิเสธ canonical request ที่เปลี่ยน และไม่เพิ่ม mutation', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  const created = await repository.append(command(f));
  await assert.rejects(
    repository.append(command(f, { decision: 'ALLOW' })),
    Cg3IdempotencyConflictError,
  );

  assert.equal(
    (await repository.history({ tenantId: f.tenantId, contactId: f.contactId })).length,
    1,
  );
  assert.deepEqual(
    await repository.mutationEvidence({ tenantId: f.tenantId, mutationId: created.mutationId }),
    { aggregateVersion: 1, auditCount: 1, outboxCount: 1, receiptCount: 1 },
  );
});

test('optimistic concurrency ยอมรับผู้ชนะเพียงหนึ่งคำสั่งต่อ expectedVersion', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  const outcomes = await Promise.allSettled([
    repository.append(command(f, { idempotencyKey: 'concurrent-a', sourceVersion: 'source-a' })),
    repository.append(command(f, { idempotencyKey: 'concurrent-b', sourceVersion: 'source-b' })),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof Cg3VersionConflictError);
  assert.equal(
    (await repository.history({ tenantId: f.tenantId, contactId: f.contactId })).length,
    1,
  );
});

test('series ใหม่ใน scope เดิมเดิน scope version ต่อโดยไม่สร้าง version ซ้ำ', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  const first = await repository.append(command(f));
  const second = await repository.append(
    command(f, {
      seriesId: randomUUID(),
      expectedVersion: 1,
      idempotencyKey: 'new-series',
      sourceVersion: 'customer-v2',
      decision: 'ALLOW',
    }),
  );

  assert.equal(first.preference.version, 1);
  assert.equal(second.preference.version, 2);
  assert.notEqual(second.preference.seriesId, first.preference.seriesId);
});

test('active tenant มองไม่เห็น contact และ identity ของ tenant อื่น', async (t) => {
  const active = await fixture(t);
  const foreign = await fixture(t);
  const repository = new Cg3PreferenceRepository(active.application);

  await assert.rejects(
    repository.append(
      command(active, {
        contactId: foreign.contactId,
        identityId: foreign.identityId,
      }),
    ),
    Cg3ResourceNotFoundError,
  );

  assert.deepEqual(
    await repository.history({ tenantId: active.tenantId, contactId: foreign.contactId }),
    [],
  );
});

test('constraint failure กลาง transaction rollback preference, head, audit, outbox และ receipt พร้อมกัน', async (t) => {
  const f = await fixture(t);
  const repository = new Cg3PreferenceRepository(f.application);

  await repository.append(command(f));
  await assert.rejects(
    repository.append(
      command(f, {
        expectedVersion: 1,
        idempotencyKey: 'duplicate-source-version',
        decision: 'ALLOW',
      }),
    ),
  );
  assert.equal(
    (await repository.history({ tenantId: f.tenantId, contactId: f.contactId })).length,
    1,
  );

  const recovered = await repository.append(
    command(f, {
      expectedVersion: 1,
      idempotencyKey: 'after-rollback',
      sourceVersion: 'customer-v2',
      decision: 'ALLOW',
    }),
  );
  assert.equal(recovered.aggregateVersion, 2);
  assert.equal(
    (await repository.history({ tenantId: f.tenantId, contactId: f.contactId })).length,
    2,
  );
  assert.deepEqual(
    await repository.mutationEvidence({ tenantId: f.tenantId, mutationId: recovered.mutationId }),
    { aggregateVersion: 2, auditCount: 1, outboxCount: 1, receiptCount: 1 },
  );
});
