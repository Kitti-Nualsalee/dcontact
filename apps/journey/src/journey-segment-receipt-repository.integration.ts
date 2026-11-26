import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneySegmentReceiptRepository,
  SegmentEntryTerminalError,
  SegmentReceiptHashConflictError,
  type IngestSegmentReceiptInput,
} from './journey-segment-receipt-repository.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

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
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.6 segment ${suffix}`,
      slug: `j3-6-segment-${suffix}`,
      sipDomain: `${suffix}.j3-6.test`,
    },
  });
  await owner.contact.createMany({
    data: [contactId, survivorId].map((id) => ({ id, tenantId })),
  });

  return {
    owner,
    application,
    tenantId,
    contactId,
    survivorId,
    segmentId,
    suffix,
    repository: new JourneySegmentReceiptRepository(application),
  };
}

function ingestInput(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<IngestSegmentReceiptInput> = {},
): IngestSegmentReceiptInput {
  return {
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    changeKind: 'ENTERED',
    entryId: `entry-${f.suffix}`,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
    ...overrides,
  };
}

function event(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    eventType: 'journey.segment_entry.intent_recorded',
    orderingKey: `${f.contactId}:${f.segmentId}`,
    payload: { contractVersion: 1, segmentId: f.segmentId },
    payloadHash: HASH,
  };
}

test('the first revision of a stream is ready to apply immediately while the same event sent again is DUPLICATE', async (t) => {
  const f = await fixture(t);
  const input = ingestInput(f);

  const first = await f.repository.ingest(input);
  assert.equal(first.outcome, 'READY');

  // sent again in full from the broker — a second receipt must not be created
  const replay = await f.repository.ingest(input);
  assert.equal(replay.outcome, 'DUPLICATE');
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 1);
});

test('the same revision arriving with a different eventId collides on logical identity, not transport', async (t) => {
  const f = await fixture(t);
  await f.repository.ingest(ingestInput(f));

  // the same hash = the same content arriving by two routes, counted as a duplicate, not a conflict
  const sameContent = await f.repository.ingest(
    ingestInput(f, { eventId: `event-other-${randomUUID()}` }),
  );
  assert.equal(sameContent.outcome, 'DUPLICATE');

  // a different hash = the same revision with mismatched content, must quarantine, not pick one of them
  const conflicting = await f.repository.ingest(
    ingestInput(f, { eventId: `event-conflict-${randomUUID()}`, payloadHash: OTHER_HASH }),
  );
  assert.equal(conflicting.outcome, 'QUARANTINED');
  assert.equal(conflicting.receipt.reviewReasonCode, 'EVENT_HASH_CONFLICT');
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 1);
});

test('the same eventId with changed content is rejected as IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const input = ingestInput(f);
  await f.repository.ingest(input);

  await assert.rejects(
    () => f.repository.ingest({ ...input, payloadHash: OTHER_HASH }),
    (error: unknown) => {
      assert.ok(error instanceof SegmentReceiptHashConflictError);
      assert.equal(error.kind, 'TRANSPORT');
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
});

test('gap 1/3/2: revision 3 waits until 2 arrives, then becomes ready in order', async (t) => {
  const f = await fixture(t);
  const one = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  assert.equal(one.outcome, 'READY');

  const three = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 3, changeKind: 'CORRECTED' }),
  );
  assert.equal(
    three.outcome,
    'WAITING_FOR_GAP',
    '3 arriving before 2 must wait, not be applied past it',
  );

  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: one.receipt.id,
      entryId: `entry-${f.suffix}`,
      canonicalContactId: f.contactId,
      intents: [],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  // the head is at 1 already, but 3 still cannot be skipped to because 2 is still missing
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: three.receipt.id } })).state,
    'WAITING_FOR_GAP',
  );

  const two = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 2, changeKind: 'CORRECTED' }),
  );
  assert.equal(two.outcome, 'READY');
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: two.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  // 2 is applied and the gap is filled, so 3 must be released to READY on its own without waiting for a new event
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: three.receipt.id } })).state,
    'READY',
  );
});

test('a revision lost along the way is IGNORED_SUPERSEDED and the head does not move backwards', async (t) => {
  const f = await fixture(t);
  const one = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  const three = await f.repository.ingest(ingestInput(f, { membershipRevision: 3 }));
  assert.equal(three.outcome, 'WAITING_FOR_GAP');

  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: one.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  /**
   * an operator ordered revision 3 applied although 2 never arrived (recovery/replay), so the head jumped
   * past 2 — when 2 follows later it is something already swallowed, so it must be IGNORED_SUPERSEDED, not
   * walk the head back to 2, which would make 3 be applied again
   */
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: three.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .lastAppliedRevision,
    3,
  );

  const late = await f.repository.ingest(ingestInput(f, { membershipRevision: 2 }));
  assert.equal(late.outcome, 'IGNORED_SUPERSEDED');
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .lastAppliedRevision,
    3,
    'the head must not move backwards',
  );

  // a revision seen before collides on logical identity before it gets as far as comparing with the head
  const seen = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 1, eventId: `event-late-${randomUUID()}` }),
  );
  assert.equal(seen.outcome, 'DUPLICATE');
});

test('one entry creates at most one enrollment per journey version even when applied again', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const entryId = `entry-${f.suffix}`;
  const intents = [
    {
      journeyId,
      journeyVersion: 1,
      entryStepId: 'send',
      reasonMembershipRevision: 1,
      reasonDefinitionVersion: 1,
      reasonDigest: HASH,
    },
  ];

  const first = await f.repository.ingest(ingestInput(f));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: first.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  // applying again (a worker restart after commit but before ack) must be idempotent, not throw an error
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: first.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId, journeyId } }),
    1,
  );
  // the reason can hold only a ref/version/digest — no attribute values or raw identity
  const intent = await f.owner.jrSegmentEnrollmentIntent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(intent.reasonMembershipRevision, 1);
  assert.equal(intent.reasonDigest, HASH);
  assert.equal(intent.contactId, f.contactId);
});

test('merge: the enrollment is bound to the survivor but the receipt still keeps the original contact', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const received = await f.repository.ingest(ingestInput(f));

  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId,
      canonicalContactId: f.survivorId,
      intents: [
        {
          journeyId: randomUUID(),
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const intent = await f.owner.jrSegmentEnrollmentIntent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(intent.contactId, f.survivorId, 'the enrollment must go to the survivor');
  const receipt = await f.owner.jrSegmentReceipt.findUniqueOrThrow({
    where: { id: received.receipt.id },
  });
  assert.equal(
    receipt.contactId,
    f.contactId,
    'the receipt must still point to the original contact for lineage',
  );
});

test('an entry that has been closed cannot create a new enrollment and terminal can be written only once', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const entered = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: entered.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents: [],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const left = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 2, changeKind: 'LEFT' }),
  );
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: left.receipt.id,
      reasonCode: 'LEFT',
      terminalEntryId: entryId,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.terminalEntryId, entryId);
  assert.equal(head.terminalRevision, 2);
  assert.equal(head.terminalReasonCode, 'LEFT');

  // a replay of history must not revive the existing entry
  const replayed = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 3, changeKind: 'ENTERED' }),
  );
  await assert.rejects(
    () =>
      f.repository.applyEnrollment(
        {
          tenantId: f.tenantId,
          receiptId: replayed.receipt.id,
          entryId,
          canonicalContactId: f.contactId,
          intents: [
            {
              journeyId: randomUUID(),
              journeyVersion: 1,
              entryStepId: 'send',
              reasonMembershipRevision: 3,
              reasonDefinitionVersion: 1,
              reasonDigest: HASH,
            },
          ],
          correlationId: `corr-${f.suffix}`,
        },
        event(f),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SegmentEntryTerminalError);
      assert.equal(error.code, 'INVALID_MEMBERSHIP_TRANSITION');
      return true;
    },
  );

  // a failed transaction must leave nothing behind — no intent, no outbox, the receipt is not APPLIED
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: replayed.receipt.id } }))
      .state,
    'READY',
  );

  // the first terminal must not be overwritten by an event that arrives later
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: replayed.receipt.id,
      reasonCode: 'INVALIDATED',
      terminalEntryId: `entry-other-${f.suffix}`,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  const after = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(after.terminalEntryId, entryId);
  assert.equal(after.terminalReasonCode, 'LEFT');
});

test('lease: a second worker does not get the same receipt until the lease expires', async (t) => {
  const f = await fixture(t);
  await f.repository.ingest(ingestInput(f));

  const claimed = await f.repository.claimNextReady(f.tenantId, 'worker-1', 60);
  assert.ok(claimed);
  assert.equal(claimed.state, 'PROCESSING');
  assert.equal(claimed.leaseOwner, 'worker-1');

  assert.equal(
    await f.repository.claimNextReady(f.tenantId, 'worker-2', 60),
    undefined,
    'the lease has not expired so another worker must not get it',
  );

  // lease expired = the first worker died midway, the work must return to the queue and not be stuck forever
  const expired = new JourneySegmentReceiptRepository(f.application, {
    now: () => new Date(Date.now() + 120_000),
  });
  const retaken = await expired.claimNextReady(f.tenantId, 'worker-2', 60);
  assert.equal(retaken?.id, claimed.id);
  assert.equal(retaken?.leaseOwner, 'worker-2');
});

test('markRetryableFailure releases the lease and delays the time while quarantine is a final state', async (t) => {
  const f = await fixture(t);
  const received = await f.repository.ingest(ingestInput(f));
  await f.repository.claimNextReady(f.tenantId, 'worker-1', 60);

  const retried = await f.repository.markRetryableFailure(
    f.tenantId,
    received.receipt.id,
    60_000,
    'MEMBERSHIP_CONTEXT_STALE',
  );
  assert.equal(retried.state, 'READY');
  assert.equal(retried.leaseOwner, null);
  assert.equal(retried.attempts, 1);
  assert.ok(retried.availableAt.getTime() > Date.now());
  // the time has not come, so it cannot be claimed
  assert.equal(await f.repository.claimNextReady(f.tenantId, 'worker-2', 60), undefined);

  const quarantined = await f.repository.markQuarantined(
    f.tenantId,
    received.receipt.id,
    'PAYLOAD_VALIDATION_FAILED',
  );
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.leaseOwner, null);
});

test('the outbox is written in the same transaction as the receipt/head/intent', async (t) => {
  const f = await fixture(t);
  const received = await f.repository.ingest(ingestInput(f));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId: `entry-${f.suffix}`,
      canonicalContactId: f.contactId,
      intents: [
        {
          journeyId: randomUUID(),
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const outbox = await f.owner.jrSegmentOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(outbox.state, 'PENDING', 'the relay must happen after commit, not during');
  assert.equal(outbox.receiptId, received.receipt.id);
  assert.equal(outbox.orderingKey, `${f.contactId}:${f.segmentId}`);
  assert.equal(outbox.publishedAt, null);

  // everything must be present in a single round
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: received.receipt.id } }))
      .state,
    'APPLIED',
  );

  const wire = JSON.stringify(outbox);
  for (const forbidden of ['attributes', 'tier', 'phone', 'email']) {
    assert.doesNotMatch(wire, new RegExp(forbidden, 'i'), `${forbidden} must not be in the outbox`);
  }
});

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual segment intent/enrollment ${order}`, async (t) => {
    const f = await fixture(t);
    const teamId = randomUUID();
    await f.owner.team.create({
      data: { id: teamId, tenantId: f.tenantId, name: 'Segment writer' },
    });
    const receipt = await f.repository.ingest(ingestInput(f));
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.tenantId,
      teamId,
      table: 'jr_segment_enrollment_intents',
      order,
      write: () =>
        f.repository.applyEnrollment(
          {
            tenantId: f.tenantId,
            receiptId: receipt.receipt.id,
            entryId: `entry-${f.suffix}`,
            canonicalContactId: f.contactId,
            intents: [
              {
                journeyId: randomUUID(),
                journeyVersion: 1,
                entryStepId: 'send',
                reasonMembershipRevision: 1,
                reasonDefinitionVersion: 1,
                reasonDigest: HASH,
              },
            ],
            correlationId: randomUUID(),
          },
          event(f),
        ),
    });
  });
