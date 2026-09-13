import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  contactId as contractContactId,
  membershipRevision,
  segmentEntryId,
  segmentId as contractSegmentId,
  tenantId as contractTenantId,
} from '@d-contact/cxa-contracts';
import { withTenantDatabaseTransaction, PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type DcProducer,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { C360SegmentDefinitionContentV1 } from './segment-definition.js';
import { C360SegmentEvaluator } from './segment-evaluator.js';
import { C360SegmentMembershipRelay } from './segment-membership-relay.js';
import {
  C360MembershipRepositoryError,
  C360SegmentMembershipRepository,
} from './segment-membership-repository.js';
import { C360SegmentRepository } from './segment-repository.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

function segmentDefinition(name = 'ลูกค้า Gold'): C360SegmentDefinitionContentV1 {
  return {
    contractVersion: 1,
    name,
    expression: {
      language: 'DC_EXPR',
      version: 1,
      expression: {
        type: 'comparison',
        operator: 'eq',
        left: { type: 'ref', path: ['contact', 'tier'] },
        right: { type: 'literal', value: 'GOLD' },
      },
    },
  };
}

async function cleanup(owner: PrismaClient, tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  await owner.c360EvidenceAccessAudit.deleteMany({ where });
  await owner.c360SegmentMembershipOutbox.deleteMany({ where });
  await owner.c360MembershipCommandReceipt.deleteMany({ where });
  await owner.c360MembershipQuarantine.deleteMany({ where });
  await owner.c360IdentityLineage.deleteMany({ where });
  await owner.c360SegmentMembershipHead.deleteMany({ where });
  await owner.c360SegmentMembershipChange.deleteMany({ where });
  await owner.c360SegmentEvidence.deleteMany({ where });
  await owner.c360IdentityHead.deleteMany({ where });
  await owner.c360SegmentEvaluation.deleteMany({ where });
  await owner.c360FactSnapshot.deleteMany({ where });
  await owner.c360SegmentDefinitionHead.deleteMany({ where });
  await owner.c360SegmentDefinition.deleteMany({ where });
  await owner.contact.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({
    datasources: { db: { url: APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const contactId = randomUUID();
  const targetContactId = randomUUID();
  const thirdContactId = randomUUID();
  const segmentId = `segment:gold-${tenantId.slice(0, 8)}`;
  const suffix = tenantId.slice(0, 8);

  t.after(async () => {
    await cleanup(owner, [tenantId, otherTenantId]);
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `J3 membership ${suffix}`,
        slug: `j3-membership-${suffix}`,
        sipDomain: `${suffix}.j3-membership.test`,
      },
      {
        id: otherTenantId,
        name: `J3 membership other ${suffix}`,
        slug: `j3-membership-other-${suffix}`,
        sipDomain: `${suffix}.other.j3-membership.test`,
      },
    ],
  });
  await owner.contact.createMany({
    data: [contactId, targetContactId, thirdContactId].map((id) => ({ id, tenantId })),
  });

  const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
  const segments = new C360SegmentRepository(application, evaluator);
  const draft = await segments.createVersion({
    tenantId,
    segmentId,
    version: 1,
    definition: segmentDefinition(),
    correlationId: 'correlation:j3:definition',
  });
  await segments.publishVersion({
    tenantId,
    segmentId,
    version: 1,
    expectedContentDigest: draft.contentDigest,
    expectedHeadVersion: 0,
  });

  return {
    owner,
    application,
    segments,
    memberships: new C360SegmentMembershipRepository(application, evaluator),
    evaluator,
    tenantId,
    otherTenantId,
    contactId,
    targetContactId,
    thirdContactId,
    segmentId,
  };
}

async function snapshot(
  f: Awaited<ReturnType<typeof fixture>>,
  contactId: string,
  snapshotVersion: number,
  tier: 'GOLD' | 'SILVER',
) {
  return f.segments.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId,
    snapshotVersion,
    attributes: {
      tier: { type: 'STRING', value: tier },
      ownerOnlyMarker: { type: 'STRING', value: `raw-owner-only-${snapshotVersion}` },
    },
    computed: {},
    sourceCutoffAt: `2026-09-13T0${snapshotVersion}:00:00.000Z`,
    correlationId: `correlation:j3:snapshot:${contactId}:${snapshotVersion}`,
  });
}

function commitInput(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<C360SegmentMembershipRepository['commitEvaluation']>[0]> = {},
) {
  return {
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
    expectedMembershipRevision: 0,
    commandId: `command:${randomUUID()}`,
    correlationId: `correlation:${randomUUID()}`,
    ...overrides,
  };
}

test('membership lifecycle คง entry เดิมระหว่าง correction และสร้าง entry ใหม่เมื่อ re-entry', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  const enteredInput = commitInput(f);
  const entered = await f.memberships.commitEvaluation(enteredInput);
  assert.equal(entered.status, 'TRANSITIONED');
  assert.equal(entered.change?.changeKind, 'ENTERED');
  assert.equal(entered.membershipRevision, 1);
  assert.ok(entered.entryId);

  const retry = await f.memberships.commitEvaluation(enteredInput);
  assert.deepEqual(retry, entered);
  const duplicate = await f.memberships.commitEvaluation(
    commitInput(f, { commandId: 'command:duplicate-same-evaluation' }),
  );
  assert.equal(duplicate.status, 'DUPLICATE_NO_OP');
  assert.equal(duplicate.entryId, entered.entryId);
  assert.equal(duplicate.membershipRevision, 1);

  await snapshot(f, f.contactId, 2, 'GOLD');
  const corrected = await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 2, expectedMembershipRevision: 1 }),
  );
  assert.equal(corrected.change?.changeKind, 'CORRECTED');
  assert.equal(corrected.entryId, entered.entryId);

  await snapshot(f, f.contactId, 3, 'SILVER');
  const left = await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 3, expectedMembershipRevision: 2 }),
  );
  assert.equal(left.change?.changeKind, 'LEFT');
  assert.equal(left.entryId, entered.entryId);
  const outHead = await f.owner.c360SegmentMembershipHead.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.contactId, segmentId: f.segmentId },
  });
  assert.equal(outHead.state, 'OUT');
  assert.equal(outHead.entryId, null);

  await snapshot(f, f.contactId, 4, 'GOLD');
  const reentered = await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 4, expectedMembershipRevision: 3 }),
  );
  assert.equal(reentered.change?.changeKind, 'ENTERED');
  assert.notEqual(reentered.entryId, entered.entryId);
  assert.equal(reentered.membershipRevision, 4);

  const changes = await f.memberships.readChanges({
    tenantId: contractTenantId(f.tenantId),
    contactId: contractContactId(f.contactId),
    segmentId: contractSegmentId(f.segmentId),
    afterRevision: 0,
    throughRevision: membershipRevision(4),
  });
  assert.equal(changes.status, 'CHANGES');
  if (changes.status === 'CHANGES') {
    assert.deepEqual(
      changes.changes.map((change) => change.changeKind),
      ['ENTERED', 'CORRECTED', 'LEFT', 'ENTERED'],
    );
  }
  const eligible = await f.memberships.resolveEntry({
    tenantId: contractTenantId(f.tenantId),
    contactId: contractContactId(f.contactId),
    segmentId: contractSegmentId(f.segmentId),
    entryId: segmentEntryId(reentered.entryId!),
    membershipRevision: membershipRevision(4),
    at: '2026-09-14T00:00:00.000Z',
  });
  assert.equal(eligible.status, 'ELIGIBLE');
  const oldEntry = await f.memberships.resolveEntry({
    tenantId: contractTenantId(f.tenantId),
    contactId: contractContactId(f.contactId),
    segmentId: contractSegmentId(f.segmentId),
    entryId: segmentEntryId(entered.entryId!),
    membershipRevision: membershipRevision(1),
    at: '2026-09-14T00:00:00.000Z',
  });
  assert.equal(oldEntry.status, 'STALE');

  assert.equal(
    await f.owner.c360SegmentMembershipChange.count({ where: { tenantId: f.tenantId } }),
    4,
  );
  assert.equal(
    await f.owner.c360SegmentMembershipOutbox.count({ where: { tenantId: f.tenantId } }),
    4,
  );
  const wire = JSON.stringify(
    await f.owner.c360SegmentMembershipOutbox.findMany({ where: { tenantId: f.tenantId } }),
  );
  assert.doesNotMatch(wire, /raw-owner-only|ownerOnlyMarker|GOLD|SILVER/);
});

test('concurrent evaluator ยอมรับ canonical revision เดียวและ quarantine ผู้แพ้', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await snapshot(f, f.contactId, 2, 'GOLD');
  const results = await Promise.all([
    f.memberships.commitEvaluation(commitInput(f, { snapshotVersion: 1 })),
    f.memberships.commitEvaluation(commitInput(f, { snapshotVersion: 2 })),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['QUARANTINED', 'TRANSITIONED']);
  assert.equal(
    await f.owner.c360SegmentMembershipChange.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  assert.equal(
    await f.owner.c360SegmentMembershipOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  const quarantine = await f.owner.c360MembershipQuarantine.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(quarantine.errorCode, 'MEMBERSHIP_REVISION_CONFLICT');
});

test('command hash conflict ถูก quarantine แบบ idempotent และ tenant RLS ไม่รั่ว', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await snapshot(f, f.contactId, 2, 'SILVER');
  const commandId = 'command:stable-id';
  await f.memberships.commitEvaluation(commitInput(f, { commandId }));
  const conflicting = commitInput(f, {
    commandId,
    snapshotVersion: 2,
    expectedMembershipRevision: 1,
  });
  assert.equal((await f.memberships.commitEvaluation(conflicting)).status, 'QUARANTINED');
  assert.equal((await f.memberships.commitEvaluation(conflicting)).status, 'QUARANTINED');
  assert.equal(
    await f.owner.c360MembershipQuarantine.count({ where: { tenantId: f.tenantId } }),
    1,
  );

  const rowsVisibleFromOtherTenant = await withTenantDatabaseTransaction(
    f.application,
    f.otherTenantId,
    (transaction) =>
      transaction.c360SegmentMembershipHead.count({ where: { tenantId: f.tenantId } }),
  );
  assert.equal(rowsVisibleFromOtherTenant, 0);
  await assert.rejects(
    f.memberships.commitEvaluation(
      commitInput(f, { tenantId: f.otherTenantId, commandId: 'command:cross-tenant' }),
    ),
    (error: unknown) =>
      error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_NOT_FOUND',
  );
});

test('merge/split/unmerge เก็บ lineage และไม่ย้าย predecessor entry ไป survivor', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await snapshot(f, f.targetContactId, 1, 'GOLD');
  const sourceEntry = await f.memberships.commitEvaluation(commitInput(f));
  await f.memberships.commitEvaluation(
    commitInput(f, { contactId: f.targetContactId, commandId: 'command:target-enter' }),
  );

  const merged = await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: 'identity:merge-1',
    operation: 'MERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 0,
    correlationId: 'correlation:merge-1',
  });
  assert.equal(merged.invalidatedChanges.length, 2);
  assert.deepEqual(
    await f.memberships.recordIdentityTransition({
      tenantId: f.tenantId,
      commandId: 'identity:merge-1',
      operation: 'MERGE',
      sourceContactId: f.contactId,
      targetContactId: f.targetContactId,
      expectedSourceLineageRevision: 0,
      correlationId: 'correlation:merge-1',
    }),
    merged,
  );
  assert.equal(
    (
      await f.memberships.resolveEntry({
        tenantId: contractTenantId(f.tenantId),
        contactId: contractContactId(f.contactId),
        segmentId: contractSegmentId(f.segmentId),
        entryId: segmentEntryId(sourceEntry.entryId!),
        membershipRevision: membershipRevision(1),
        at: '2026-09-14T00:00:00.000Z',
      })
    ).status,
    'NOT_ELIGIBLE',
  );
  const survivorHead = await f.owner.c360SegmentMembershipHead.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.targetContactId, segmentId: f.segmentId },
  });
  assert.notEqual(survivorHead.entryId, sourceEntry.entryId);

  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: 'identity:split-1',
    operation: 'SPLIT',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 1,
    correlationId: 'correlation:split-1',
  });
  const reentered = await f.memberships.commitEvaluation(
    commitInput(f, {
      expectedMembershipRevision: 3,
      commandId: 'command:source-reenter-after-split',
    }),
  );
  assert.equal(reentered.change?.changeKind, 'ENTERED');
  assert.notEqual(reentered.entryId, sourceEntry.entryId);

  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: 'identity:merge-2',
    operation: 'MERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 2,
    correlationId: 'correlation:merge-2',
  });
  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: 'identity:unmerge-1',
    operation: 'UNMERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 3,
    correlationId: 'correlation:unmerge-1',
  });
  assert.deepEqual(
    (
      await f.owner.c360IdentityLineage.findMany({
        where: { tenantId: f.tenantId },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((row) => row.operation),
    ['MERGE', 'SPLIT', 'MERGE', 'UNMERGE'],
  );
});

test('evidence เปิดเฉพาะ metadata พร้อม audit และ outbox retry ใช้ eventId เดิม', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  const entered = await f.memberships.commitEvaluation(commitInput(f));
  const evidence = await f.memberships.resolveEvidence({
    tenantId: f.tenantId,
    evidenceRef: entered.change!.evidenceRef!,
    actorClass: 'RECONCILIATION_JOB',
    actorRef: 'job:j3-audit',
    reasonCode: 'VERIFY_CANONICAL_MEMBERSHIP',
    correlationId: 'correlation:evidence',
  });
  assert.equal(evidence.outcome, 'MATCH');
  assert.doesNotMatch(JSON.stringify(evidence), /raw-owner-only|ownerOnlyMarker|GOLD/);
  assert.equal(await f.owner.c360EvidenceAccessAudit.count({ where: { tenantId: f.tenantId } }), 1);

  const sent: Array<Record<string, unknown>> = [];
  let fail = true;
  const producer: DcProducer = {
    async send(_topic, event) {
      sent.push(event as unknown as Record<string, unknown>);
      if (fail) {
        fail = false;
        throw new Error('broker unavailable');
      }
    },
    async disconnect() {},
  };
  let now = new Date('2099-09-13T12:00:00.000Z');
  const relay = new C360SegmentMembershipRelay(f.application, producer, {
    now: () => now,
    backoffMs: () => 1_000,
  });
  const failed = await relay.publishNext(f.tenantId);
  assert.equal(failed?.state, 'FAILED');
  now = new Date('2099-09-13T12:00:01.001Z');
  const published = await relay.publishNext(f.tenantId);
  assert.equal(published?.state, 'PUBLISHED');
  assert.equal(published?.eventId, failed?.eventId);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.eventId, sent[1]?.eventId);
  assert.equal(sent[0]?.occurredAt, sent[1]?.occurredAt);
  assert.equal(sent[0]?.type, 'customer.segment.changed');
  assert.equal(sent[0]?.aggregateVersion, 1);
  assert.equal(await relay.publishNext(f.tenantId), undefined);
});

test(
  'canonical membership commit ก่อน relay ส่ง customer.segment.changed ผ่าน Redpanda',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await snapshot(f, f.contactId, 1, 'GOLD');
    const entered = await f.memberships.commitEvaluation(commitInput(f));
    const suffix = randomUUID();
    const received: Array<Record<string, unknown>> = [];
    let resolveReceived!: () => void;
    const observed = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const consumer = await createConsumer({
      clientId: `j3-membership-${suffix}-consumer`,
      groupId: `j3-membership-${suffix}`,
      topics: [KAFKA_TOPICS.CUSTOMER_EVENTS],
      brokers: ['localhost:9092'],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        if (message.event.tenantId !== f.tenantId) return;
        received.push(message.event as unknown as Record<string, unknown>);
        resolveReceived();
      },
    });
    const producer = await createProducer(`j3-membership-${suffix}-producer`, {
      brokers: ['localhost:9092'],
    });
    try {
      await consumer.ready();
      const relay = new C360SegmentMembershipRelay(f.application, producer, {
        now: () => new Date('2099-09-13T12:00:00.000Z'),
      });
      const attempt = await relay.publishNext(f.tenantId);
      assert.equal(attempt?.state, 'PUBLISHED');
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        observed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('ไม่พบ customer.segment.changed จาก Redpanda ภายในเวลา')),
            10_000,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      assert.equal(received.length, 1);
      const event = received[0]!;
      assert.equal(event.eventId, attempt?.eventId);
      assert.equal(event.type, 'customer.segment.changed');
      assert.equal(event.eventKind, 'CANONICAL');
      assert.equal(event.aggregateVersion, entered.membershipRevision);
      assert.equal(event.orderingKey, `${f.contactId}:${f.segmentId}`);
      assert.deepEqual(event.payload, entered.change);
    } finally {
      await producer.disconnect();
      await consumer.disconnect();
    }
  },
);

test('outbox insert ล้มเหลวทำให้ evaluation/change/head rollback ทั้ง transaction', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await snapshot(f, f.thirdContactId, 1, 'GOLD');
  await f.memberships.commitEvaluation(commitInput(f));
  const existing = await f.owner.c360SegmentMembershipOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  const collisionId = existing.eventId.replace(/^event:/, '');
  const ids = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    collisionId,
    randomUUID(),
    randomUUID(),
  ];
  const colliding = new C360SegmentMembershipRepository(f.application, f.evaluator, {
    id: () => ids.shift() ?? randomUUID(),
  });
  await assert.rejects(
    colliding.commitEvaluation(
      commitInput(f, {
        contactId: f.thirdContactId,
        commandId: 'command:forced-outbox-collision',
      }),
    ),
  );
  assert.equal(
    await f.owner.c360SegmentMembershipHead.count({
      where: { tenantId: f.tenantId, contactId: f.thirdContactId },
    }),
    0,
  );
  assert.equal(
    await f.owner.c360SegmentMembershipChange.count({
      where: { tenantId: f.tenantId, contactId: f.thirdContactId },
    }),
    0,
  );
  assert.equal(
    await f.owner.c360SegmentEvaluation.count({
      where: { tenantId: f.tenantId, contactId: f.thirdContactId },
    }),
    0,
  );
});
