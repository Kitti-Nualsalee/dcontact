import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type {
  CustomerSegmentMembershipReader,
  SegmentEntryResolution,
  TeamContactScopeAuthorization,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';
import { JourneySegmentTriggerProcessor } from './journey-segment-trigger-processor.js';

const evaluator = new DcExprEvaluator();
const HASH = 'a'.repeat(64);

/** a double that answers per a script — the real Customer 360 is tested separately in apps/customer-360 */
function reader(resolution: SegmentEntryResolution): CustomerSegmentMembershipReader<never> {
  return {
    async resolveEntry() {
      return resolution;
    },
    async readChanges() {
      return { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' } as const;
    },
  } as unknown as CustomerSegmentMembershipReader<never>;
}

function authorizer(decision: TeamContactScopeAuthorization): TeamContactScopeAuthorizer<never> {
  return {
    async authorize() {
      return decision;
    },
  } as unknown as TeamContactScopeAuthorizer<never>;
}

const ALLOW: TeamContactScopeAuthorization = {
  decision: 'ALLOW',
  scopeVersion: 1,
  evaluatedAt: '2026-09-15T00:00:00.000Z',
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
  const contactId = randomUUID();
  const survivorId = randomUUID();
  const teamId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    // an enrollment references an intent by FK so it must be deleted first
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.6 processor ${suffix}`,
      slug: `j3-6-proc-${suffix}`,
      sipDomain: `${suffix}.j3-6-proc.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Lifecycle' } });
  await owner.contact.createMany({
    data: [contactId, survivorId].map((id) => ({ id, tenantId })),
  });
  await owner.c360SegmentDefinition.create({
    data: {
      tenantId,
      segmentId,
      version: 1,
      status: 'PUBLISHED',
      definition: { contractVersion: 1, name: segmentId },
      contentDigest: HASH,
      evaluatorVersion: 'DC_EXPR:1',
      correlationId: 'corr',
      effectiveFrom: new Date(),
      publishedAt: new Date(),
    },
  });
  await owner.c360SegmentDefinitionHead.create({
    data: { tenantId, segmentId, headVersion: 1, currentVersion: 1, currentDigest: HASH },
  });

  const definitions = new JourneyDefinitionRepository(application, evaluator);
  const receipts = new JourneySegmentReceiptRepository(application);

  return {
    owner,
    application,
    tenantId,
    contactId,
    survivorId,
    teamId,
    segmentId,
    suffix,
    definitions,
    receipts,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** publishes a journey triggered by SEGMENT_ENTRY of this segment */
async function publishJourney(f: Fixture, journeyId: string) {
  const draft = await f.definitions.createVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    name: `Segment entry ${journeyId.slice(0, 8)}`,
    ownerTeamId: f.teamId,
    purpose: 'MARKETING',
    senderIdentityId: 'sender-1',
    trigger: {
      kind: 'SEGMENT_ENTRY',
      segmentId: f.segmentId,
      coalescingPolicy: 'PER_SEGMENT_ENTRY',
    },
    graph: {
      entryStepId: 'send',
      steps: [
        { id: 'send', type: 'SEND', channel: 'LINE', contentRef: 'tmpl-1', next: 'exit' },
        { id: 'exit', type: 'EXIT', reason: 'GOAL_REACHED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'done' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    correlationId: 'corr',
  });
  await f.definitions.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'corr',
  });
}

async function ingest(
  f: Fixture,
  revision: number,
  changeKind = 'ENTERED',
  entryId?: string,
  segmentIdValue?: string,
) {
  return f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: segmentIdValue ?? f.segmentId,
    membershipRevision: revision,
    changeKind,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
    ...(entryId ? { entryId } : {}),
  });
}

function eligible(f: Fixture, contactIdValue: string, entryId: string): SegmentEntryResolution {
  return {
    status: 'ELIGIBLE',
    contactId: contactIdValue,
    segmentId: f.segmentId,
    entryId,
    segmentDefinitionVersion: 1,
    membershipRevision: 1,
    snapshotVersion: 1,
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    stateDigest: HASH,
  } as unknown as SegmentEntryResolution;
}

function processor(
  f: Fixture,
  resolution: SegmentEntryResolution,
  scope: TeamContactScopeAuthorization = ALLOW,
) {
  return new JourneySegmentTriggerProcessor(f.application, f.definitions, {
    membershipReader: reader(resolution) as never,
    teamContactScopeAuthorizer: authorizer(scope) as never,
  });
}

test('an ENTERED that is ELIGIBLE with waiting journeys creates every enrollment intent', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  await publishJourney(f, randomUUID());
  await ingest(f, 1, 'ENTERED', entryId);

  const outcome = await processor(f, eligible(f, f.contactId, entryId)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'ENROLLED');

  // one segment can have several journeys — must not silently leave only one
  const intents = await f.owner.jrSegmentEnrollmentIntent.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { journeyId: 'asc' },
  });
  assert.equal(intents.length, 2);
  assert.equal(intents[0]?.reasonDigest, HASH);
  assert.equal(intents[0]?.reasonMembershipRevision, 1);

  const receipt = await f.owner.jrSegmentReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'APPLIED');
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 1);
});

test('the survivor from resolveEntry decides, not the contactId that came with the event', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  await ingest(f, 1, 'ENTERED', entryId);

  await processor(f, eligible(f, f.survivorId, entryId)).executeNext(f.tenantId, 'worker-1');

  const intent = await f.owner.jrSegmentEnrollmentIntent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(intent.contactId, f.survivorId);
});

test('STALE is deferred to retry, not decided with old data', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  const received = await ingest(f, 1, 'ENTERED', entryId);

  const outcome = await processor(f, {
    status: 'STALE',
    reasonCode: 'MEMBERSHIP_CONTEXT_STALE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'DEFERRED');

  const receipt = await f.owner.jrSegmentReceipt.findUniqueOrThrow({
    where: { id: received.receipt.id },
  });
  assert.equal(receipt.state, 'READY');
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.leaseOwner, null);
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('AMBIGUOUS and NOT_FOUND go to review with the reason from Customer 360 itself', async (t) => {
  const f = await fixture(t);
  await publishJourney(f, randomUUID());

  // each case must be in a different stream, otherwise the first one stuck in REVIEW would block the next
  for (const resolution of [
    { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' } as const,
    { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' } as const,
  ]) {
    const segmentIdValue = `segment-${resolution.status.toLowerCase()}-${f.suffix}`;
    const received = await ingest(f, 1, 'ENTERED', `entry-${f.suffix}`, segmentIdValue);
    assert.equal(received.outcome, 'READY');

    const outcome = await processor(f, resolution).executeNext(f.tenantId, 'worker-1');
    assert.equal(outcome, 'REVIEW');
    const receipt = await f.owner.jrSegmentReceipt.findUniqueOrThrow({
      where: { id: received.receipt.id },
    });
    assert.equal(receipt.state, 'REVIEW');
    assert.equal(receipt.reviewReasonCode, resolution.reasonCode);
    assert.equal(
      receipt.leaseOwner,
      null,
      'REVIEW must release the lease and not leave it with the worker',
    );
  }

  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('a receipt stuck in REVIEW blocks the next revision of the same stream and does not skip ahead', async (t) => {
  const f = await fixture(t);
  await publishJourney(f, randomUUID());
  await ingest(f, 1, 'ENTERED', `entry-1-${f.suffix}`);

  await processor(f, { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' }).executeNext(
    f.tenantId,
    'worker-1',
  );

  /**
   * the head does not move because revision 1 has not been applied — revision 2 must therefore wait, not skip ahead
   * letting it skip would enroll the contact with an order of events that never really happened
   */
  const second = await ingest(f, 2, 'ENTERED', `entry-2-${f.suffix}`);
  assert.equal(second.outcome, 'WAITING_FOR_GAP');
  assert.equal(
    await processor(f, eligible(f, f.contactId, `entry-2-${f.suffix}`)).executeNext(
      f.tenantId,
      'worker-2',
    ),
    undefined,
    'nothing to claim because the first one is still stuck in review',
  );
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('NOT_ELIGIBLE is let through but the head must advance, otherwise the next revision is stuck forever', async (t) => {
  const f = await fixture(t);
  await publishJourney(f, randomUUID());
  await ingest(f, 1, 'ENTERED', `entry-${f.suffix}`);

  const outcome = await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'NOT_ELIGIBLE');

  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedRevision, 1);
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 0);

  // the next revision must be able to continue and not get stuck in WAITING_FOR_GAP
  const next = await ingest(f, 2, 'ENTERED', `entry-2-${f.suffix}`);
  assert.equal(next.outcome, 'READY');
});

test('even when no journey is triggered by this segment the head must still advance', async (t) => {
  const f = await fixture(t);
  await ingest(f, 1, 'ENTERED', `entry-${f.suffix}`);

  const outcome = await processor(f, eligible(f, f.contactId, `entry-${f.suffix}`)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'NO_MATCH');
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .lastAppliedRevision,
    1,
  );
});

test('a scope DEFER is deferred to retry while DENY creates no enrollment and is not recorded as a Governance BLOCK', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  const received = await ingest(f, 1, 'ENTERED', entryId);

  const deferred = await processor(f, eligible(f, f.contactId, entryId), {
    decision: 'DEFER',
    reasonCode: 'SCOPE_CONTEXT_STALE',
    evaluatedAt: '2026-09-15T00:00:00.000Z',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(deferred, 'DEFERRED');
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: received.receipt.id } }))
      .state,
    'READY',
  );

  const denied = await new JourneySegmentTriggerProcessor(
    f.application,
    f.definitions,
    {
      membershipReader: reader(eligible(f, f.contactId, entryId)) as never,
      teamContactScopeAuthorizer: authorizer({
        decision: 'DENY',
        reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
        evaluatedAt: '2026-09-15T00:00:00.000Z',
      }) as never,
    },
    // availableAt was already pushed back from the previous round, so we must look from the future to claim the same one
    { now: () => new Date(Date.now() + 120_000) },
  ).executeNext(f.tenantId, 'worker-2');
  assert.equal(denied, 'DENIED');

  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 0);
  // nothing may be written as a Governance decision for this contact
  assert.equal(
    await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }).catch(() => 0),
    0,
  );
});

test('a change that is not a new entry becomes a re-filter job and LEFT closes the entry permanently', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  await ingest(f, 1, 'ENTERED', entryId);
  await processor(f, eligible(f, f.contactId, entryId)).executeNext(f.tenantId, 'worker-1');

  await ingest(f, 2, 'LEFT', entryId);
  const outcome = await processor(f, eligible(f, f.contactId, entryId)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'REFILTERED');

  const cursor = await f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(cursor.state, 'PENDING');
  assert.equal(cursor.reasonCode, 'LEFT');
  assert.equal(cursor.membershipRevision, 2);

  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.terminalEntryId, entryId, 'LEFT must close that entry permanently');
  assert.equal(head.terminalRevision, 2);

  // CORRECTED must not close the entry but must still queue a re-filter
  await ingest(f, 3, 'CORRECTED', entryId);
  await processor(f, eligible(f, f.contactId, entryId)).executeNext(f.tenantId, 'worker-1');
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .terminalReasonCode,
    'LEFT',
    'the first terminal must not be overwritten',
  );
  assert.equal(await f.owner.jrSegmentRefilterCursor.count({ where: { tenantId: f.tenantId } }), 2);
});

test('no receipt ready for processing returns undefined without touching anything', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await processor(f, eligible(f, f.contactId, 'entry')).executeNext(f.tenantId, 'worker-1'),
    undefined,
  );
});

test('the real enrollment happens together with the intent in one transaction and they are bound one to one', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyA = randomUUID();
  const journeyB = randomUUID();
  await publishJourney(f, journeyA);
  await publishJourney(f, journeyB);
  await ingest(f, 1, 'ENTERED', entryId);

  await processor(f, eligible(f, f.contactId, entryId)).executeNext(f.tenantId, 'worker-1');

  const intents = await f.owner.jrSegmentEnrollmentIntent.findMany({
    where: { tenantId: f.tenantId },
  });
  const enrollments = await f.owner.jrEnrollment.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(intents.length, 2);
  assert.equal(enrollments.length, 2, 'fan-out must produce an enrollment for every journey');

  // every enrollment must point back to its own intent, not point at random
  for (const enrollment of enrollments) {
    assert.ok(
      intents.some((intent) => intent.id === enrollment.segmentIntentId),
      'the enrollment must be bound to an intent that really exists',
    );
    assert.equal(enrollment.contactId, f.contactId);
    assert.equal(
      enrollment.currentStepId,
      'send',
      'it must start at the entry step of the published graph',
    );
    assert.equal(enrollment.state, 'PENDING');
  }
  assert.deepEqual(enrollments.map((row) => row.journeyId).sort(), [journeyA, journeyB].sort());

  // the trigger source must be of a single kind — no mixing with the original sources of J1/J2
  for (const enrollment of enrollments) {
    assert.equal(enrollment.eventInboxId, null);
    assert.equal(enrollment.occurrenceId, null);
    assert.equal(enrollment.outcomeReceiptId, null);
  }
});

test('applying again does not create a second enrollment', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f, randomUUID());
  const received = await ingest(f, 1, 'ENTERED', entryId);

  for (const worker of ['worker-1', 'worker-2']) {
    await f.receipts.applyEnrollment(
      {
        tenantId: f.tenantId,
        receiptId: received.receipt.id,
        entryId,
        canonicalContactId: f.contactId,
        intents: [
          {
            journeyId: (
              await f.owner.jrJourneyDefinition.findFirstOrThrow({
                where: { tenantId: f.tenantId },
              })
            ).journeyId,
            journeyVersion: 1,
            entryStepId: 'send',
            reasonMembershipRevision: 1,
            reasonDefinitionVersion: 1,
            reasonDigest: HASH,
          },
        ],
        correlationId: `corr-${worker}`,
      },
      {
        eventType: 'journey.segment_entry.recorded',
        orderingKey: `${f.contactId}:${f.segmentId}`,
        payload: { contractVersion: 1 },
        payloadHash: HASH,
      },
    );
  }

  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 1);
});

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual segment trigger intent ${order}`, async (t) => {
    const f = await fixture(t);
    const entryId = `entry-${f.suffix}`;
    await publishJourney(f, randomUUID());
    await ingest(f, 1, 'ENTERED', entryId);
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.tenantId,
      teamId: f.teamId,
      table: 'jr_segment_enrollment_intents',
      order,
      write: () =>
        processor(f, eligible(f, f.contactId, entryId)).executeNext(f.tenantId, 'core-writer'),
    });
  });
