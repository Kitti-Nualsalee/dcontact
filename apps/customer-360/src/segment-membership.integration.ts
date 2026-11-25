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

/**
 * The time the caller uses to ask resolveEntry must always be "after" the change's evaluatedAt
 *
 * evaluatedAt comes from Postgres transaction_timestamp(), i.e. the real time the test runs, so hardcoding
 * a nearby date is a time bomb: once that day passes, at is earlier than evaluatedAt and resolveEntry
 * returns STALE every time regardless of what the test means to check (actually hit when the date rolled over to 15 Sep)
 */
const AFTER_EVALUATION = '2099-01-01T00:00:00.000Z';

function segmentDefinition(name = 'Gold customers'): C360SegmentDefinitionContentV1 {
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

test('membership lifecycle keeps the original entry during a correction and creates a new entry on re-entry', async (t) => {
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
    at: AFTER_EVALUATION,
  });
  assert.equal(eligible.status, 'ELIGIBLE');
  const oldEntry = await f.memberships.resolveEntry({
    tenantId: contractTenantId(f.tenantId),
    contactId: contractContactId(f.contactId),
    segmentId: contractSegmentId(f.segmentId),
    entryId: segmentEntryId(entered.entryId!),
    membershipRevision: membershipRevision(1),
    at: AFTER_EVALUATION,
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

test('concurrent evaluators accept a single canonical revision and quarantine the loser', async (t) => {
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

test('a command hash conflict is quarantined idempotently and tenant RLS does not leak', async (t) => {
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

test('merge/split/unmerge keep the lineage and do not move the predecessor entry to the survivor', async (t) => {
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
        at: AFTER_EVALUATION,
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

test('evidence exposes only metadata with an audit, and an outbox retry reuses the same eventId', async (t) => {
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
  'canonical membership commits before the relay sends customer.segment.changed through Redpanda',
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
            () => reject(new Error('customer.segment.changed from Redpanda not found in time')),
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

test(
  'readChanges separates a gap that supersession can explain from a gap that it cannot',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await snapshot(f, f.contactId, 1, 'GOLD');
    const first = await f.memberships.commitEvaluation(commitInput(f));
    await snapshot(f, f.contactId, 2, 'SILVER');
    const second = await f.memberships.commitEvaluation(
      commitInput(f, { snapshotVersion: 2, expectedMembershipRevision: first.membershipRevision }),
    );
    await snapshot(f, f.contactId, 3, 'GOLD');
    const third = await f.memberships.commitEvaluation(
      commitInput(f, { snapshotVersion: 3, expectedMembershipRevision: second.membershipRevision }),
    );

    // fully contiguous -> CHANGES as usual
    const contiguous = await f.memberships.readChanges({
      tenantId: contractTenantId(f.tenantId),
      contactId: contractContactId(f.contactId),
      segmentId: contractSegmentId(f.segmentId),
      afterRevision: 0,
      throughRevision: membershipRevision(third.membershipRevision),
    });
    assert.equal(contiguous.status, 'CHANGES');

    // punch a hole in the middle with nobody declaring it was swallowed -> must refuse to answer SUPERSEDED
    //
    // must use the owner client because rls.sql REVOKEs UPDATE/DELETE on the change ledger
    // (the ledger is immutable by design), so simulating data loss has to bypass that layer
    // the ledger is truly immutable through both REVOKE and a trigger — the trigger must be disabled temporarily to
    // simulate data loss the system is not meant to produce (which is exactly the point of this test)
    //
    // always register the re-enable before disabling: if any assert fails midway the trigger must not stay
    // disabled, left behind on a DB that other tests share
    const guards: Array<[string, string]> = [
      ['c360_segment_membership_changes', 'c360_membership_change_immutable'],
      ['c360_membership_command_receipts', 'c360_membership_receipt_immutable'],
    ];
    t.after(async () => {
      for (const [table, trigger] of guards) {
        await f.owner.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    });
    for (const [table, trigger] of guards) {
      await f.owner.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    // the outbox and command receipt have FKs pointing at the change row, so they must be cleaned up first
    await f.owner.c360MembershipCommandReceipt.deleteMany({
      where: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
        membershipRevision: second.membershipRevision,
      },
    });
    await f.owner.c360SegmentMembershipOutbox.deleteMany({
      where: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
        membershipRevision: second.membershipRevision,
      },
    });
    await f.owner.c360SegmentMembershipChange.deleteMany({
      where: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
        membershipRevision: second.membershipRevision,
      },
    });

    await assert.rejects(
      () =>
        f.memberships.readChanges({
          tenantId: contractTenantId(f.tenantId),
          contactId: contractContactId(f.contactId),
          segmentId: contractSegmentId(f.segmentId),
          afterRevision: 0,
          throughRevision: membershipRevision(third.membershipRevision),
        }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'MEMBERSHIP_CHANGE_GAP',
      'a gap with no supersession to explain it must not be disguised as SUPERSEDED',
    );

    // once a later change declares it swallowed the missing revision -> SUPERSEDED is justified by evidence
    await f.owner.c360SegmentMembershipChange.updateMany({
      where: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
        membershipRevision: third.membershipRevision,
      },
      data: { supersedesRevision: second.membershipRevision },
    });

    const superseded = await f.memberships.readChanges({
      tenantId: contractTenantId(f.tenantId),
      contactId: contractContactId(f.contactId),
      segmentId: contractSegmentId(f.segmentId),
      afterRevision: 0,
      throughRevision: membershipRevision(third.membershipRevision),
    });
    assert.equal(superseded.status, 'SUPERSEDED');
  },
);

test('SPLIT/UNMERGE rejects a pair of contacts that were never merged', async (t) => {
  const f = await fixture(t);

  // these two were never merged into each other — nothing can be reversed because there is nothing to reverse
  for (const operation of ['UNMERGE', 'SPLIT'] as const) {
    await assert.rejects(
      () =>
        f.memberships.recordIdentityTransition({
          tenantId: f.tenantId,
          commandId: `command:${operation}:${randomUUID()}`,
          operation,
          sourceContactId: f.contactId,
          targetContactId: f.thirdContactId,
          expectedSourceLineageRevision: 0,
          correlationId: `correlation:${randomUUID()}`,
        }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'IDENTITY_LINEAGE_CONFLICT',
      `${operation} must not create a lineage from contacts that were never merged`,
    );
  }

  // the ledger must be clean, with no history that never actually happened recorded
  assert.equal(await f.owner.c360IdentityLineage.count({ where: { tenantId: f.tenantId } }), 0);
});

test('UNMERGE that reverses a real merge still works as usual', async (t) => {
  const f = await fixture(t);
  const merge = await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `command:merge:${randomUUID()}`,
    operation: 'MERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 0,
    correlationId: `correlation:${randomUUID()}`,
  });
  assert.equal(merge.operation, 'MERGE');

  const unmerge = await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `command:unmerge:${randomUUID()}`,
    operation: 'UNMERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: merge.lineageRevision,
    correlationId: `correlation:${randomUUID()}`,
  });
  assert.equal(unmerge.operation, 'UNMERGE');

  const head = await f.owner.c360IdentityHead.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.contactId },
  });
  assert.equal(head.state, 'ACTIVE');
});

test('a permanently broken payload is quarantined instead of being retried forever', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await f.memberships.commitEvaluation(commitInput(f));

  // make the payload differ from the committed payload_hash = corruption that retrying never fixes
  await f.owner.$executeRawUnsafe(
    'ALTER TABLE c360_segment_membership_outbox DISABLE TRIGGER c360_membership_outbox_guard',
  );
  t.after(async () => {
    await f.owner.$executeRawUnsafe(
      'ALTER TABLE c360_segment_membership_outbox ENABLE TRIGGER c360_membership_outbox_guard',
    );
  });
  const row = await f.owner.c360SegmentMembershipOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  await f.owner.c360SegmentMembershipOutbox.update({
    where: { id: row.id },
    data: { payloadHash: 'a'.repeat(64) },
  });
  await f.owner.$executeRawUnsafe(
    'ALTER TABLE c360_segment_membership_outbox ENABLE TRIGGER c360_membership_outbox_guard',
  );

  const neverCalled = {
    async send() {
      throw new Error('must not publish a payload whose hash does not match');
    },
    async disconnect() {},
  };
  const relay = new C360SegmentMembershipRelay(f.application, neverCalled as never);

  const attempt = await relay.publishNext(f.tenantId);
  assert.equal(attempt?.state, 'QUARANTINED');

  const quarantined = await f.owner.c360SegmentMembershipOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, id: row.id },
  });
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.notEqual(quarantined.quarantinedAt, null);
  assert.match(quarantined.lastError ?? '', /hash/);

  // truly terminal — the next round must not pick it up for retry again
  assert.equal(await relay.publishNext(f.tenantId), undefined);
});

test('relay does not send the next revision before the previous revision of the same stream', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  const first = await f.memberships.commitEvaluation(commitInput(f));
  await snapshot(f, f.contactId, 2, 'SILVER');
  const second = await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 2, expectedMembershipRevision: first.membershipRevision }),
  );

  // push the first revision to not-ready-to-send (simulating a stuck worker or one in backoff)
  await f.owner.c360SegmentMembershipOutbox.updateMany({
    where: { tenantId: f.tenantId, membershipRevision: first.membershipRevision },
    data: { state: 'FAILED', availableAt: new Date(Date.now() + 60_000) },
  });

  const sent: number[] = [];
  const recorder = {
    async send(_topic: unknown, event: { aggregateVersion: number }) {
      sent.push(event.aggregateVersion);
    },
    async disconnect() {},
  };
  const relay = new C360SegmentMembershipRelay(f.application, recorder as never);

  // revision 2 is ready to send but must not be picked because revision 1 is still pending
  assert.equal(await relay.publishNext(f.tenantId), undefined);
  assert.deepEqual(
    sent,
    [],
    `must not send revision ${second.membershipRevision} before revision ${first.membershipRevision}`,
  );

  // once revision 1 is ready, the order proceeds as usual
  await f.owner.c360SegmentMembershipOutbox.updateMany({
    where: { tenantId: f.tenantId, membershipRevision: first.membershipRevision },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
  await relay.publishNext(f.tenantId);
  await relay.publishNext(f.tenantId);
  assert.deepEqual(sent, [first.membershipRevision, second.membershipRevision]);
});

test('an outbox insert failure rolls back the whole evaluation/change/head transaction', async (t) => {
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

test('a merge chain moves the canonical of previously merged contacts and re-evaluates them all', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await f.memberships.commitEvaluation(commitInput(f));

  // A -> B
  const first = await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `command:merge:${randomUUID()}`,
    operation: 'MERGE',
    sourceContactId: f.contactId,
    targetContactId: f.targetContactId,
    expectedSourceLineageRevision: 0,
    correlationId: `correlation:${randomUUID()}`,
  });

  // B -> C : A is already merged under B, so A's canonical must follow to C as well
  const second = await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `command:merge:${randomUUID()}`,
    operation: 'MERGE',
    sourceContactId: f.targetContactId,
    targetContactId: f.thirdContactId,
    expectedSourceLineageRevision: 0,
    correlationId: `correlation:${randomUUID()}`,
  });

  const heads = new Map(
    (await f.owner.c360IdentityHead.findMany({ where: { tenantId: f.tenantId } })).map((head) => [
      head.contactId,
      head,
    ]),
  );
  assert.equal(
    heads.get(f.contactId)?.canonicalContactId,
    f.thirdContactId,
    'canonical of A must point to C, not to B, which is no longer canonical',
  );
  assert.equal(heads.get(f.contactId)?.state, 'MERGED');
  assert.ok(
    (heads.get(f.contactId)?.lineageRevision ?? 0) > first.lineageRevision,
    'A must get a new lineage revision when its canonical changes',
  );

  // owner re-evaluation: A's membership must be notified, not left silently with the old owner
  assert.ok(
    second.invalidatedChanges.some((change) => change.contactId === f.contactId),
    'the second merge must re-evaluate the membership of A, whose canonical moved along',
  );

  // reverse B out of C : A was merged into B, so it must return under B as before
  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `command:unmerge:${randomUUID()}`,
    operation: 'UNMERGE',
    sourceContactId: f.targetContactId,
    targetContactId: f.thirdContactId,
    expectedSourceLineageRevision: second.lineageRevision,
    correlationId: `correlation:${randomUUID()}`,
  });
  const afterUnmerge = await f.owner.c360IdentityHead.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.contactId },
  });
  assert.equal(
    afterUnmerge.canonicalContactId,
    f.targetContactId,
    'A must go back under B, which merged it before, and not stay at C',
  );
});

test(
  'crash after the broker accepts an event but before marking PUBLISHED: restart resends the same envelope and the consumer does not process it twice',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await snapshot(f, f.contactId, 1, 'GOLD');
    const entered = await f.memberships.commitEvaluation(commitInput(f));

    const suffix = randomUUID();
    const handled: Array<Record<string, unknown>> = [];
    let resolveSecond!: () => void;
    const secondObserved = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let physicalDeliveries = 0;
    const consumer = await createConsumer({
      clientId: `j3-crash-${suffix}-consumer`,
      groupId: `j3-crash-${suffix}`,
      topics: [KAFKA_TOPICS.CUSTOMER_EVENTS],
      brokers: ['localhost:9092'],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        if (message.event.tenantId !== f.tenantId) return;
        handled.push(message.event as unknown as Record<string, unknown>);
      },
    });
    const producer = await createProducer(`j3-crash-${suffix}-producer`, {
      brokers: ['localhost:9092'],
    });
    const counting: DcProducer = {
      async send(topic, event) {
        await producer.send(topic, event);
        physicalDeliveries += 1;
        if (physicalDeliveries === 2) resolveSecond();
      },
      async disconnect() {},
    };

    try {
      await consumer.ready();
      const relay = new C360SegmentMembershipRelay(f.application, counting, {
        now: () => new Date('2099-09-13T12:00:00.000Z'),
      });
      const first = await relay.publishNext(f.tenantId);
      assert.equal(first?.state, 'PUBLISHED');

      /**
       * the crash window lies between a producer.send() that the broker acked and updating the state to
       * PUBLISHED in the same transaction. If the process dies there, the whole transaction rolls back and
       * the broker already holds the event while the outbox is still PENDING with the original attempts
       *
       * the relay catches errors itself and marks FAILED, so it cannot be simulated with a producer that throws (that is
       * a graceful failure, not a crash); instead set the state a crash leaves behind directly and then run a restart.
       *
       * c360_membership_outbox_guard forbids every update on an already PUBLISHED row and forbids attempts
       * going backwards, which is right for a real transition, but a rollback does not go through the guard — it reverts
       * the row as if never written, so disable the guard only for this simulating statement (register the re-enable before disabling)
       */
      t.after(async () => {
        await f.owner.$executeRawUnsafe(
          'ALTER TABLE c360_segment_membership_outbox ENABLE TRIGGER c360_membership_outbox_guard',
        );
      });
      await f.owner.$executeRawUnsafe(
        'ALTER TABLE c360_segment_membership_outbox DISABLE TRIGGER c360_membership_outbox_guard',
      );
      await f.owner.c360SegmentMembershipOutbox.update({
        where: { id: first!.outboxId },
        data: { state: 'PENDING', attempts: 0, publishedAt: null },
      });
      await f.owner.$executeRawUnsafe(
        'ALTER TABLE c360_segment_membership_outbox ENABLE TRIGGER c360_membership_outbox_guard',
      );

      const replayed = await relay.publishNext(f.tenantId);
      assert.equal(replayed?.state, 'PUBLISHED');
      assert.equal(
        replayed?.eventId,
        first?.eventId,
        'restart must use the committed eventId, not issue a new one',
      );
      assert.equal(
        physicalDeliveries,
        2,
        'the broker must really receive the event twice, as the crash left it',
      );

      // wait for the second delivery to reach the broker, then give the consumer time to decide to dedupe
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        secondObserved,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('the second delivery did not reach the broker')),
            10_000,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      assert.equal(
        handled.length,
        1,
        'the consumer must dedupe by the original eventId and not process the event again after restart',
      );

      // durable owner: a resend must not touch the ledger at all
      assert.equal(
        await f.owner.c360SegmentMembershipChange.count({ where: { tenantId: f.tenantId } }),
        1,
        'restart must not create a new membership revision',
      );
      assert.equal(
        await f.owner.c360SegmentMembershipOutbox.count({ where: { tenantId: f.tenantId } }),
        1,
        'restart must not create a new outbox row',
      );
      const head = await f.owner.c360SegmentMembershipHead.findFirstOrThrow({
        where: { tenantId: f.tenantId, contactId: f.contactId, segmentId: f.segmentId },
      });
      assert.equal(head.membershipRevision, entered.membershipRevision);
      assert.equal(await relay.publishNext(f.tenantId), undefined);
    } finally {
      await producer.disconnect();
      await consumer.disconnect();
    }
  },
);

test('a projection rebuild from the change ledger gives the original state and creates no new revision/event', async (t) => {
  const f = await fixture(t);
  await snapshot(f, f.contactId, 1, 'GOLD');
  await f.memberships.commitEvaluation(commitInput(f));
  await snapshot(f, f.contactId, 2, 'GOLD');
  await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 2, expectedMembershipRevision: 1 }),
  );
  await snapshot(f, f.contactId, 3, 'SILVER');
  await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 3, expectedMembershipRevision: 2 }),
  );
  await snapshot(f, f.contactId, 4, 'GOLD');
  const last = await f.memberships.commitEvaluation(
    commitInput(f, { snapshotVersion: 4, expectedMembershipRevision: 3 }),
  );

  const head = await f.owner.c360SegmentMembershipHead.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.contactId, segmentId: f.segmentId },
  });
  const changesBefore = await f.owner.c360SegmentMembershipChange.count({
    where: { tenantId: f.tenantId },
  });
  const outboxBefore = await f.owner.c360SegmentMembershipOutbox.count({
    where: { tenantId: f.tenantId },
  });

  // rebuild the way a consumer does after wiping its projection and replaying the ledger from revision 0
  const read = await f.memberships.readChanges({
    tenantId: contractTenantId(f.tenantId),
    contactId: contractContactId(f.contactId),
    segmentId: contractSegmentId(f.segmentId),
    afterRevision: 0,
    throughRevision: membershipRevision(head.membershipRevision),
  });
  assert.equal(read.status, 'CHANGES');
  if (read.status !== 'CHANGES') return;

  let state: 'IN' | 'OUT' | 'INVALIDATED' | undefined;
  let entryId: string | null = null;
  let revision = 0;
  for (const change of read.changes) {
    assert.equal(
      change.membershipRevision,
      revision + 1,
      'the ledger must be contiguous with no gaps',
    );
    revision = change.membershipRevision;
    switch (change.changeKind) {
      case 'ENTERED':
      case 'CORRECTED':
        state = 'IN';
        entryId = change.entryId ?? null;
        break;
      case 'LEFT':
        state = 'OUT';
        entryId = null;
        break;
      case 'IDENTITY_INVALIDATED':
        state = 'INVALIDATED';
        break;
      case 'REFILTER_REQUIRED':
        break;
    }
  }

  assert.equal(
    revision,
    head.membershipRevision,
    'the rebuild must replay exactly up to the current revision',
  );
  assert.equal(state, head.state, 'the state folded from the ledger must match the head');
  assert.equal(entryId, head.entryId, 'the entryId folded from the ledger must match the head');
  assert.equal(entryId, last.entryId);

  // rebuild is a pure read path; it must not write anything back into the ledger or outbox
  assert.equal(
    await f.owner.c360SegmentMembershipChange.count({ where: { tenantId: f.tenantId } }),
    changesBefore,
  );
  assert.equal(
    await f.owner.c360SegmentMembershipOutbox.count({ where: { tenantId: f.tenantId } }),
    outboxBefore,
  );
});
