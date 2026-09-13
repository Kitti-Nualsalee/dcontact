import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  Cg3IdempotencyConflictError,
  Cg3PreferenceRepository,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';
import {
  Cg4FoundationRepository,
  Cg4PolicyBindingError,
  type RecordCg4ExceptionInput,
} from './cg4-foundation-repository.js';

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
  const policyId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const content = { allowedOperationalRuleCodes: ['MIN_GAP', 'QUIET_HOURS'] };
  const contentDigest = stableDigest(content);

  t.after(async () => {
    await owner.cg4ExceptionApproval.deleteMany({ where: { tenantId } });
    await owner.cg4ExceptionHead.deleteMany({ where: { tenantId } });
    await owner.cg4Exception.deleteMany({ where: { tenantId } });
    await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId } });
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId } });
    await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId } });
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId } });
    await owner.cg4BackfillLedger.deleteMany({ where: { tenantId } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgConsumerAcknowledgement.deleteMany({ where: { tenantId } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
    await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId } });
    await owner.cgPreference.deleteMany({ where: { tenantId } });
    await owner.cg4Policy.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG4 ${suffix}`,
      slug: `cg4-${suffix}`,
      sipDomain: `${suffix}.cg4.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  await owner.contactIdentity.create({
    data: { id: identityId, tenantId, contactId, type: 'LINE', value: `line-${suffix}` },
  });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId,
      policyId,
      version: 1,
      scopeKey: 'channel:LINE|purpose:SERVICE_NOTIFICATION|contactKind:*|sourceType:*',
      content,
      contentDigest,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'PUBLISHED',
      effectiveFrom: new Date('2026-09-13T00:00:00.000Z'),
      makerActorRef: 'actor:maker:opaque',
      publishedAt: new Date('2026-09-13T00:00:00.000Z'),
    },
  });
  return { owner, application, tenantId, contactId, identityId, policyId, contentDigest };
}

function command(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<RecordCg4ExceptionInput> = {},
): RecordCg4ExceptionInput {
  return {
    tenantId: f.tenantId,
    contactId: f.contactId,
    identityId: f.identityId,
    scopeKind: 'IDENTITY',
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    sourceType: 'DIALER',
    sourceId: 'source:opaque:1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.policyId,
    policyVersion: 1,
    policyContentDigest: f.contentDigest,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-13T01:00:00.000Z',
    expiresAt: '2026-09-13T02:00:00.000Z',
    tier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    ticketRef: 'ticket:opaque:1',
    evidenceRef: 'evidence:opaque:1',
    actorRef: 'actor:compliance:opaque',
    occurredAt: '2026-09-13T00:30:00.000Z',
    idempotencyKey: 'cg4-exception-1',
    expectedVersion: 0,
    ...overrides,
  };
}

test('CG4 exception revision/head/contact aggregate/receipt/audit/outbox ถูก commit แบบ atomic และ retry คืนผลเดิม', async (t) => {
  const f = await fixture(t);
  const repository = new Cg4FoundationRepository(f.application);

  const created = await repository.recordException(command(f));
  const retried = await repository.recordException(command(f));
  const history = await repository.history({ tenantId: f.tenantId, contactId: f.contactId });

  assert.deepEqual(retried, created);
  assert.equal(created.aggregateVersion, 1);
  assert.equal(created.exception.revision, 1);
  assert.equal(history.length, 1);
  assert.equal(await f.owner.cg4Exception.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cg4ExceptionHead.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(
    await f.owner.cgEventOutbox.count({
      where: { tenantId: f.tenantId, mutationId: created.mutationId },
    }),
    1,
  );
  assert.equal(
    await f.owner.cgAuditLog.count({
      where: { tenantId: f.tenantId, mutationId: created.mutationId },
    }),
    1,
  );
  assert.equal(
    await f.owner.cgCommandReceipt.count({
      where: { tenantId: f.tenantId, operation: 'CG4_EXCEPTION_RECORD' },
    }),
    1,
  );
});

test('CG4 exception aggregate version/digest ไม่ชนกับ CG3 preference บน contact เดียวกัน', async (t) => {
  const f = await fixture(t);
  const preferences = new Cg3PreferenceRepository(f.application);
  await preferences.append({
    tenantId: f.tenantId,
    contactId: f.contactId,
    identityId: f.identityId,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    decision: 'BLOCK',
    preferredWindows: [],
    sourceKind: 'CUSTOMER',
    occurredAt: '2026-09-13T00:00:00.000Z',
    effectiveFrom: '2026-09-13T00:00:00.000Z',
    evidenceRef: 'evidence:cg3:opaque:1',
    actorClass: 'CUSTOMER',
    actorRef: 'actor:customer:opaque',
    idempotencyKey: 'cg3-preference-1',
    expectedVersion: 0,
    correlationId: 'correlation:cg3:opaque:1',
  });

  const repository = new Cg4FoundationRepository(f.application);
  const created = await repository.recordException(command(f, { expectedVersion: 0 }));
  assert.equal(created.aggregateVersion, 1);

  const cg3Head = await f.owner.cgContactStateHead.findUniqueOrThrow({
    where: { tenantId_contactId: { tenantId: f.tenantId, contactId: f.contactId } },
  });
  assert.equal(cg3Head.aggregateVersion, 1);
  const cg4Head = await f.owner.cg4ContactExceptionHead.findUniqueOrThrow({
    where: { tenantId_contactId: { tenantId: f.tenantId, contactId: f.contactId } },
  });
  assert.equal(cg4Head.aggregateVersion, 1);
  assert.notEqual(cg3Head.currentDigest, cg4Head.currentDigest);
});

test('CG4 exception ใช้ CAS ต่อ contact aggregate และ revision ใหม่ append-only', async (t) => {
  const f = await fixture(t);
  const repository = new Cg4FoundationRepository(f.application);
  const first = await repository.recordException(command(f));
  const second = await repository.recordException(
    command(f, {
      exceptionId: first.exception.exceptionId,
      expectedVersion: 1,
      idempotencyKey: 'cg4-exception-2',
      sourceId: 'source:opaque:2',
      evidenceRef: 'evidence:opaque:2',
    }),
  );
  assert.equal(second.aggregateVersion, 2);
  assert.equal(second.exception.revision, 2);
  assert.equal(
    (
      await repository.history({
        tenantId: f.tenantId,
        contactId: f.contactId,
        exceptionId: first.exception.exceptionId,
      })
    ).length,
    2,
  );

  const competing = await Promise.allSettled([
    repository.recordException(
      command(f, {
        expectedVersion: 2,
        idempotencyKey: 'cg4-race-a',
        sourceId: 'source:race:a',
        evidenceRef: 'evidence:race:a',
      }),
    ),
    repository.recordException(
      command(f, {
        expectedVersion: 2,
        idempotencyKey: 'cg4-race-b',
        sourceId: 'source:race:b',
        evidenceRef: 'evidence:race:b',
      }),
    ),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = competing.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof Cg3VersionConflictError);
});

test('idempotency key ที่ผูก canonical request คนละตัวถูกปฏิเสธก่อนสร้าง revision ใหม่', async (t) => {
  const f = await fixture(t);
  const repository = new Cg4FoundationRepository(f.application);
  await repository.recordException(command(f));
  await assert.rejects(
    repository.recordException(command(f, { reasonCode: 'DIFFERENT_REASON' })),
    Cg3IdempotencyConflictError,
  );
  assert.equal(await f.owner.cg4Exception.count({ where: { tenantId: f.tenantId } }), 1);
});

test('RLS และ tenant-bound identity/policy FK ไม่ให้ request ข้าม tenant เห็นหรือสลับ ID', async (t) => {
  const active = await fixture(t);
  const foreign = await fixture(t);
  const repository = new Cg4FoundationRepository(active.application);

  await assert.rejects(
    repository.recordException(
      command(active, {
        identityId: foreign.identityId,
        sourceId: 'source:foreign-identity',
      }),
    ),
    Cg3ResourceNotFoundError,
  );
  await assert.rejects(
    repository.recordException(
      command(active, {
        policyId: foreign.policyId,
        sourceId: 'source:foreign-policy',
      }),
    ),
    Cg4PolicyBindingError,
  );
  const hidden = await withTenantDatabaseTransaction(
    active.application,
    foreign.tenantId,
    (transaction) =>
      transaction.cg4Policy.findFirst({
        where: { tenantId: active.tenantId, policyId: active.policyId },
      }),
  );
  assert.equal(hidden, null);
});

test('unique scope head, immutable exception/published policy และ kill-switch clear approval ถูกบังคับที่ DB', async (t) => {
  const f = await fixture(t);
  const policy = await f.owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.tenantId, policyId: f.policyId },
  });
  const head = {
    id: randomUUID(),
    tenantId: f.tenantId,
    scopeKey: policy.scopeKey,
    headPolicyId: policy.policyId,
    headPolicyVersion: policy.version,
    headPolicyRevisionId: policy.id,
  };
  await f.owner.cg4PolicyScopeHead.create({ data: head });
  await assert.rejects(f.owner.cg4PolicyScopeHead.create({ data: { ...head, id: randomUUID() } }));

  const repository = new Cg4FoundationRepository(f.application);
  const created = await repository.recordException(command(f));
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.cg4Exception.update({
        where: { id: created.exception.id },
        data: { reasonCode: 'MUTATION_NOT_ALLOWED' },
      }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.cg4Policy.update({
        where: { id: policy.id },
        data: { content: { changed: true } },
      }),
    ),
  );
  // ข้าม SCHEDULED ไป ACTIVE โดยตรงต้องถูกปฏิเสธ
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.cg4Policy.update({
        where: { id: policy.id },
        data: { status: 'ACTIVE' },
      }),
    ),
  );
  const scheduled = await withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
    transaction.cg4Policy.update({
      where: { id: policy.id },
      data: { status: 'SCHEDULED' },
    }),
  );
  assert.equal(scheduled.status, 'SCHEDULED');

  const killSwitch = await f.owner.cg4ScopeKillSwitch.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      scopeKey: policy.scopeKey,
      reasonCode: 'EMERGENCY_STOP',
      evidenceRef: 'evidence:kill:1',
      activatedByRef: 'actor:incident:opaque',
      activatedAt: new Date('2026-09-13T01:00:00.000Z'),
    },
  });
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.cg4ScopeKillSwitch.update({
        where: { id: killSwitch.id },
        data: { state: 'CLEARED', clearedAt: new Date('2026-09-13T01:05:00.000Z') },
      }),
    ),
  );
  const cleared = await withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
    transaction.cg4ScopeKillSwitch.update({
      where: { id: killSwitch.id },
      data: {
        state: 'CLEARED',
        clearApprovalRef: 'approval:kill-clear:opaque',
        clearedAt: new Date('2026-09-13T01:05:00.000Z'),
      },
    }),
  );
  assert.equal(cleared.state, 'CLEARED');
});
