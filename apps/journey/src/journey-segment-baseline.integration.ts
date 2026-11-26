import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { JourneySegmentBaseline } from './journey-segment-baseline.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';
import { JourneySegmentRollout } from './journey-segment-rollout.js';

const HASH = 'a'.repeat(64);

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
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentShadowMismatch.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRolloutState.deleteMany({ where: { tenantId } });
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.c360SegmentMembershipHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentEvaluation.deleteMany({ where: { tenantId } });
    await owner.c360FactSnapshot.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.10 baseline ${suffix}`,
      slug: `j3-10-baseline-${suffix}`,
      sipDomain: `${suffix}.j3-10.test`,
    },
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

  return {
    owner,
    application,
    tenantId,
    segmentId,
    suffix,
    baseline: new JourneySegmentBaseline(application),
    receipts: new JourneySegmentReceiptRepository(application),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** creates a Customer 360 membership that "existed before" J3 was turned on */
async function existingMembership(f: Fixture, revision: number, state: 'IN' | 'OUT' = 'IN') {
  const contactId = randomUUID();
  await f.owner.contact.create({ data: { id: contactId, tenantId: f.tenantId } });
  await f.owner.c360FactSnapshot.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      snapshotVersion: 1,
      attributes: {},
      computed: {},
      sourceCutoffAt: new Date(),
      contentDigest: HASH,
      correlationId: 'corr',
    },
  });
  const evaluation = await f.owner.c360SegmentEvaluation.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      segmentDefinitionVersion: 1,
      snapshotVersion: 1,
      outcome: 'MATCH',
      matched: true,
      evaluatorVersion: 'DC_EXPR:1',
      inputDigest: HASH,
      evaluationDigest: HASH,
      evaluatedAt: new Date(),
    },
  });
  await f.owner.c360SegmentMembershipHead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      state,
      membershipRevision: revision,
      ...(state === 'IN' ? { entryId: `entry-${contactId.slice(0, 8)}` } : {}),
      segmentDefinitionVersion: 1,
      snapshotVersion: 1,
      evaluationId: evaluation.id,
      evaluatedAt: new Date(),
      evidenceRef: `evidence-${contactId.slice(0, 8)}`,
      stateDigest: HASH,
    },
  });
  return contactId;
}

test('the baseline sets the head for memberships that existed before, without creating a single enrollment', async (t) => {
  const f = await fixture(t);
  const contacts = await Promise.all([
    existingMembership(f, 5),
    existingMembership(f, 3),
    existingMembership(f, 7),
  ]);

  const result = await f.baseline.baselineTenant(f.tenantId);
  assert.equal(result.baselined, 3);
  assert.equal(result.skipped, 0);

  const heads = await f.owner.jrSegmentHead.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(heads.length, 3);
  for (const contactId of contacts) {
    const head = heads.find((row) => row.contactId === contactId);
    assert.ok(head, 'every stream must have a head');
    assert.equal(
      head.terminalEntryId,
      null,
      'the baseline did not see the entry-closing event so it must not write one',
    );
  }

  /**
   * the most important point of the baseline: no enrollment may be created at all
   *
   * these contacts were in the segment before the system was turned on; enrolling everyone at turn-on would fire the campaign at
   * the entire customer base at once with nobody ordering it
   */
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 0);
});

test('running the baseline again gives the same result and creates nothing more', async (t) => {
  const f = await fixture(t);
  await existingMembership(f, 5);
  await existingMembership(f, 2);

  const first = await f.baseline.baselineTenant(f.tenantId);
  const second = await f.baseline.baselineTenant(f.tenantId);

  assert.equal(first.baselined, 2);
  assert.equal(second.baselined, 0, 'the second round must not set the baseline again');
  assert.equal(second.skipped, 2);
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 2);
});

test('the baseline does not pull back a head that has already moved far ahead', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 2);
  // the system had already advanced to revision 9 before anyone ordered the baseline again
  await f.owner.jrSegmentHead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      lastAppliedRevision: 9,
    },
  });

  const result = await f.baseline.baselineTenant(f.tenantId);
  assert.equal(result.baselined, 0);
  assert.equal(result.skipped, 1);
  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedRevision, 9, 'the head must not be pulled backwards');
});

test('the baseline can be split into batches and resumes from the existing cursor without skipping a stream', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index += 1) await existingMembership(f, index + 1);

  // the first round does only two and stops, as if killed midway
  const first = await f.baseline.baselineNext({ tenantId: f.tenantId, batchSize: 2 });
  assert.equal(first.baselined, 2);
  assert.ok(first.nextCursor, 'when not finished there must be a cursor to continue');

  // resume from the existing cursor
  const rest = await f.baseline.baselineTenant(f.tenantId, 2);
  assert.equal(rest.baselined + first.baselined, 5, 'every stream must be done and none skipped');
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 5);
});

test('a membership that is already OUT also gets a baseline but is not marked as ended', async (t) => {
  const f = await fixture(t);
  await existingMembership(f, 4, 'OUT');

  await f.baseline.baselineTenant(f.tenantId);
  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedRevision, 4);
  assert.equal(head.terminalEntryId, null);
  assert.equal(head.terminalReasonCode, null);
});

test('rebuild assembles the head from receipts already applied and running again gives the same result', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 1);
  const entryId = `entry-${f.suffix}`;

  for (const revision of [1, 2]) {
    const received = await f.receipts.ingest({
      tenantId: f.tenantId,
      source: 'CUSTOMER_360',
      eventId: `event-${randomUUID()}`,
      contactId,
      segmentId: f.segmentId,
      membershipRevision: revision,
      changeKind: revision === 1 ? 'ENTERED' : 'CORRECTED',
      entryId,
      segmentDefinitionVersion: 1,
      payloadHash: HASH,
      correlationId: `corr-${f.suffix}`,
    });
    await f.receipts.applyRefilter(
      {
        tenantId: f.tenantId,
        receiptId: received.receipt.id,
        reasonCode: 'CORRECTED',
        correlationId: `corr-${f.suffix}`,
      },
      {
        eventType: 'journey.segment_entry.recorded',
        orderingKey: `${contactId}:${f.segmentId}`,
        payload: { contractVersion: 1 },
        payloadHash: HASH,
      },
    );
  }

  const intentsBefore = await f.owner.jrSegmentEnrollmentIntent.count({
    where: { tenantId: f.tenantId },
  });
  const outboxBefore = await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } });

  // the projection is damaged — delete the head and rebuild it from the ledger
  await f.owner.jrSegmentHead.deleteMany({ where: { tenantId: f.tenantId, contactId } });
  const rebuilt = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(rebuilt.lastAppliedRevision, 2);
  assert.equal(rebuilt.rebuilt, true);

  // running again must give the same result and not count as changing anything
  const again = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(again.lastAppliedRevision, 2);
  assert.equal(again.rebuilt, false, 'a rebuild where nothing changed must not report a write');

  // rebuilding the projection is not a replay of effects
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    intentsBefore,
  );
  assert.equal(
    await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }),
    outboxBefore,
    'rebuild must not create a duplicate outbox',
  );
});

test('rebuild of a stream with no applied receipt does not create a floating head', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 1);
  await f.owner.jrSegmentHead.deleteMany({ where: { tenantId: f.tenantId } });

  const result = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(result.rebuilt, false);
  assert.equal(result.lastAppliedRevision, 0);
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 0);
});

test('a crash/kill drill across every rollout stage can resume without skipping a stream or duplicating effects', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index += 1) await existingMembership(f, index + 1);

  // OWNER_BACKFILL: the first worker commits only the first batch before being killed
  const firstWorker = new JourneySegmentBaseline(f.application);
  const rolloutBeforeKill = new JourneySegmentRollout(f.application);
  let view = await rolloutBeforeKill.read(f.tenantId);
  view = await rolloutBeforeKill.advance({
    tenantId: f.tenantId,
    to: 'OWNER_BACKFILL',
    expectedVersion: view.version,
    updatedByRef: 'drill:first-worker',
  });
  const firstBatch = await firstWorker.baselineNext({ tenantId: f.tenantId, batchSize: 2 });
  assert.equal(firstBatch.baselined, 2);
  assert.ok(
    firstBatch.nextCursor,
    'a killed worker must leave committed facts behind to resume from',
  );

  // a new process has no in-memory cursor: rerunning from the durable heads must skip what was already committed
  const resumedWorker = new JourneySegmentBaseline(f.application);
  const resumed = await resumedWorker.baselineTenant(f.tenantId, 2);
  assert.equal(resumed.baselined, 3);
  assert.equal(resumed.skipped, 2);
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 5);

  // SHADOW_MEMBERSHIP: a crash after appending a mismatch but before the worker got the result back must not append again
  const afterBackfillRestart = new JourneySegmentRollout(f.application);
  view = await afterBackfillRestart.read(f.tenantId);
  view = await afterBackfillRestart.advance({
    tenantId: f.tenantId,
    to: 'SHADOW_MEMBERSHIP',
    expectedVersion: view.version,
    updatedByRef: 'drill:restart-after-backfill',
  });
  const mismatch = await afterBackfillRestart.recordMismatch({
    tenantId: f.tenantId,
    contactId: (await f.owner.c360SegmentMembershipHead.findFirstOrThrow()).contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    expectedDigest: HASH,
    observedDigest: 'b'.repeat(64),
  });
  assert.equal(mismatch, 'RECORDED');
  const afterShadowRestart = new JourneySegmentRollout(f.application);
  assert.equal(
    await afterShadowRestart.recordMismatch({
      tenantId: f.tenantId,
      contactId: (await f.owner.c360SegmentMembershipHead.findFirstOrThrow()).contactId,
      segmentId: f.segmentId,
      membershipRevision: 1,
      expectedDigest: HASH,
      observedDigest: 'b'.repeat(64),
    }),
    'DUPLICATE',
  );
  assert.equal(await f.owner.jrSegmentShadowMismatch.count({ where: { tenantId: f.tenantId } }), 1);

  // SHADOW_RECEIPT_REFILTER and SCOPED_INTERNAL_ENABLED: stage/freeze must survive a new process
  view = await afterShadowRestart.read(f.tenantId);
  view = await afterShadowRestart.advance({
    tenantId: f.tenantId,
    to: 'SHADOW_RECEIPT_REFILTER',
    expectedVersion: view.version,
    updatedByRef: 'drill:restart-after-shadow-membership',
  });
  const afterRefilterRestart = new JourneySegmentRollout(f.application);
  view = await afterRefilterRestart.read(f.tenantId);
  view = await afterRefilterRestart.advance({
    tenantId: f.tenantId,
    to: 'SCOPED_INTERNAL_ENABLED',
    expectedVersion: view.version,
    updatedByRef: 'drill:restart-after-shadow-refilter',
  });
  assert.equal(await new JourneySegmentRollout(f.application).canEmitEffects(f.tenantId), true);

  const frozen = await new JourneySegmentRollout(f.application).setFrozen({
    tenantId: f.tenantId,
    frozen: true,
    expectedVersion: view.version,
    updatedByRef: 'drill:kill-switch',
  });
  assert.equal(frozen.mutationFrozen, true);
  assert.equal(await new JourneySegmentRollout(f.application).canEmitEffects(f.tenantId), false);
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 0);
});
