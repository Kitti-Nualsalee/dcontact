import { JourneySegmentTriggerProcessor } from './journey-segment-trigger-processor.js';
import { JourneySegmentRecovery } from './journey-segment-recovery.js';
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
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamContactScopeAuthorizer, IamTeamSegmentScopeRepository } from '@d-contact/iam';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';
import { JourneySegmentRefilterProcessor } from './journey-segment-refilter-processor.js';
import { JourneyIamScopeInvalidationService } from './journey-iam-scope-invalidation.js';

const evaluator = new DcExprEvaluator();
const HASH = 'a'.repeat(64);

const ALLOW: TeamContactScopeAuthorization = {
  decision: 'ALLOW',
  scopeVersion: 1,
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};
const DENY: TeamContactScopeAuthorization = {
  decision: 'DENY',
  reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};
const DEFER: TeamContactScopeAuthorization = {
  decision: 'DEFER',
  reasonCode: 'SCOPE_CONTEXT_STALE',
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};

function reader(resolution: SegmentEntryResolution) {
  return {
    async resolveEntry() {
      return resolution;
    },
    async readChanges() {
      return { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' } as const;
    },
  } as unknown as CustomerSegmentMembershipReader<never>;
}

function authorizer(decision: TeamContactScopeAuthorization) {
  return {
    async authorize() {
      return decision;
    },
  } as unknown as TeamContactScopeAuthorizer<never>;
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
  const contactId = randomUUID();
  const teamId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrRecoveryAudit.deleteMany({ where: { tenantId } });
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrIamScopeInvalidationInbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    // an enrollment references an intent by FK so it must be deleted first
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.iamScopeConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.iamScopeInvalidationOutbox.deleteMany({ where: { tenantId } });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamScopeVersion.deleteMany({ where: { tenantId } });
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
      name: `J3.7 refilter ${suffix}`,
      slug: `j3-7-refilter-${suffix}`,
      sipDomain: `${suffix}.j3-7.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Lifecycle' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
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
    contactId,
    teamId,
    segmentId,
    suffix,
    definitions: new JourneyDefinitionRepository(application, evaluator),
    receipts: new JourneySegmentReceiptRepository(application),
    actions: new JourneyOwnerActionRepository(application),
    iam: new IamTeamSegmentScopeRepository(application),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function publishJourney(f: Fixture, ownerTeamId = f.teamId) {
  const journeyId = randomUUID();
  const draft = await f.definitions.createVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    name: 'Segment entry',
    ownerTeamId,
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
  return journeyId;
}

/** creates one re-filter job through the real path: ingest then applyRefilter */
async function queueRefilter(f: Fixture, revision: number, changeKind: string, entryId?: string) {
  const received = await f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: revision,
    changeKind,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
    ...(entryId ? { entryId } : {}),
  });
  await f.receipts.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      reasonCode: changeKind,
      correlationId: `corr-${f.suffix}`,
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${f.contactId}:${f.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  return received.receipt.id;
}

function eligible(f: Fixture, entryId: string, revision = 1): SegmentEntryResolution {
  return {
    status: 'ELIGIBLE',
    contactId: f.contactId,
    segmentId: f.segmentId,
    entryId,
    segmentDefinitionVersion: 1,
    membershipRevision: revision,
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
  return new JourneySegmentRefilterProcessor(f.application, f.definitions, {
    membershipReader: reader(resolution) as never,
    teamContactScopeAuthorizer: authorizer(scope) as never,
  });
}

async function cursor(f: Fixture) {
  return f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: f.tenantId },
    orderBy: { membershipRevision: 'desc' },
  });
}

test('a correction still in the segment with the same entry ends as NO_OP and creates nothing new', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const outcome = await processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'NO_OP');

  const settled = await cursor(f);
  assert.equal(settled.state, 'NO_OP');
  assert.equal(settled.reasonCode, 'MEMBERSHIP_UNCHANGED');
  assert.ok(settled.settledAt, 'a final state must have settledAt per the CHECK of #216');
  assert.equal(settled.leaseOwner, null);
  // a correction must not produce a new enrollment
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('no longer eligible ends as CANCELLED', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'LEFT', entryId);

  const outcome = await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'CANCELLED');

  const settled = await cursor(f);
  assert.equal(settled.state, 'CANCELLED');
  assert.equal(settled.reasonCode, 'SEGMENT_ENTRY_NOT_ELIGIBLE');
  assert.ok(settled.settledAt);
});

test('merge/split waits for a new canonical fact and does not move the predecessor enrollment', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'IDENTITY_INVALIDATED', `entry-${f.suffix}`);

  const outcome = await processor(f, eligible(f, `entry-${f.suffix}`)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'RECONCILING');

  const held = await cursor(f);
  assert.equal(held.state, 'RECONCILING');
  assert.equal(held.reasonCode, 'IDENTITY_LINEAGE_CONFLICT');
  assert.equal(held.settledAt, null, 'not finished yet so settledAt must not exist');
  assert.equal(held.leaseOwner, null, 'the lease must be released and not left with the worker');
  assert.ok(held.availableAt.getTime() > Date.now(), 'it must have a day to come back on its own');
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('a REFILTER_REQUIRED with no entryId waits for a fact that points to the entry clearly', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'REFILTER_REQUIRED');

  const outcome = await processor(f, eligible(f, 'entry-x')).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'RECONCILING');
  assert.equal((await cursor(f)).reasonCode, 'RECONCILIATION_REQUIRED');
});

test('STALE moves to DEFERRED and so does a scope DEFER', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  assert.equal(
    await processor(f, { status: 'STALE', reasonCode: 'MEMBERSHIP_CONTEXT_STALE' }).executeNext(
      f.tenantId,
      'worker-1',
    ),
    'DEFERRED',
  );
  const deferred = await cursor(f);
  assert.equal(deferred.state, 'DEFERRED');
  assert.equal(deferred.attempts, 1);
  assert.equal(deferred.settledAt, null);

  // the time has not come, so it cannot be claimed
  assert.equal(
    await processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'worker-2'),
    undefined,
  );

  // once the time comes it must come back on its own, and a scope DEFER gives the same result
  const later = new JourneySegmentRefilterProcessor(
    f.application,
    f.definitions,
    {
      membershipReader: reader(eligible(f, entryId)) as never,
      teamContactScopeAuthorizer: authorizer(DEFER) as never,
    },
    { now: () => new Date(Date.now() + 120_000) },
  );
  assert.equal(await later.executeNext(f.tenantId, 'worker-3'), 'DEFERRED');
  assert.equal((await cursor(f)).attempts, 2);
});

test('a scope revoked after enrollment ends as CANCELLED without touching Governance', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const outcome = await processor(f, eligible(f, entryId), DENY).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'CANCELLED');
  assert.equal((await cursor(f)).reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
  assert.equal(
    await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }).catch(() => 0),
    0,
    'a team permission revocation must not be recorded as a Governance BLOCK',
  );
});

test('an IAM WORK grant is revoked and re-filter closes an action not yet dispatched inside Journey without creating another owner command', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `iam-revoke-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);
  const grant = await f.iam.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'WORK',
    correlationId: `iam-grant-${f.suffix}`,
  });
  await f.iam.revoke({
    tenantId: f.tenantId,
    grantId: grant.grant.id,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: `iam-revoke-${f.suffix}`,
  });
  await queueRefilter(f, 2, 'CORRECTED', entryId);

  const processor = new JourneySegmentRefilterProcessor(f.application, f.definitions, {
    membershipReader: reader(eligible(f, entryId, 2)) as never,
    teamContactScopeAuthorizer: new IamTeamContactScopeAuthorizer(f.application),
  });
  assert.equal(await processor.executeNext(f.tenantId, 'iam-revoke-worker'), 'CANCELLED');
  assert.equal(
    (
      await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey },
      })
    ).state,
    'CANCELLED',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, actionKey, state: 'CANCELLED' },
    }),
    1,
    'the original command not yet dispatched must be cancelled inside Journey',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionKey}` },
    }),
    0,
    'a cancel command must not be created when the owner has not yet received the original command',
  );
  assert.equal(await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }), 0);
});

test('an IAM revoke for team A creates a durable cursor and cancels only the Journeys of team A', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const teamB = randomUUID();
  await f.owner.team.create({ data: { id: teamB, tenantId: f.tenantId, name: 'Retention' } });
  const journeyA = await publishJourney(f, f.teamId);
  const journeyB = await publishJourney(f, teamB);

  const received = await f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    changeKind: 'ENTERED',
    entryId,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
  });
  await f.receipts.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents: [
        {
          journeyId: journeyA,
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
        {
          journeyId: journeyB,
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${f.contactId}:${f.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  const intents = await f.owner.jrSegmentEnrollmentIntent.findMany({
    where: { tenantId: f.tenantId, receiptId: received.receipt.id },
    select: { id: true, journeyId: true },
  });
  const enrollmentA = await f.owner.jrEnrollment.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      segmentIntentId: intents.find((i) => i.journeyId === journeyA)?.id,
    },
  });
  const enrollmentB = await f.owner.jrEnrollment.findFirstOrThrow({
    where: {
      tenantId: f.tenantId,
      segmentIntentId: intents.find((i) => i.journeyId === journeyB)?.id,
    },
  });
  const actionA = `team-a-${f.suffix}`;
  const actionB = `team-b-${f.suffix}`;
  await ownerAction(f, enrollmentA.id, actionA);
  await ownerAction(f, enrollmentB.id, actionB);

  const event = {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: `iam-revoke:${randomUUID()}`,
    type: 'team.segment-scope.changed',
    tenantId: f.tenantId,
    occurredAt: '2099-01-01T00:00:00.000Z',
    correlationId: `iam-revoke-${f.suffix}`,
    orderingKey: f.teamId,
    aggregateType: 'iam_team_scope',
    aggregateId: f.teamId,
    aggregateVersion: 2,
    payload: {
      contractVersion: 1,
      teamId: f.teamId,
      grantId: randomUUID(),
      scopeVersion: 2,
      kind: 'REVOKED',
    },
  } as const;
  const service = new JourneyIamScopeInvalidationService();
  const result = await withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
    service.apply(event, 'journey-iam-scope-test', transaction),
  );
  assert.deepEqual(result, { state: 'RECORDED', scheduledCursorCount: 1 });
  assert.equal(
    await f.owner.jrIamScopeInvalidationInbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  const scopedCursor = await f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: f.tenantId, scopeTeamId: f.teamId },
  });
  assert.equal(scopedCursor.receiptId, received.receipt.id);

  assert.equal(
    await processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'iam-scope-worker'),
    'CANCELLED',
  );
  assert.equal(
    (
      await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey: actionA },
      })
    ).state,
    'CANCELLED',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, actionKey: actionA, state: 'CANCELLED' },
    }),
    1,
    'the team A revoke must cancel only the not-yet-dispatched commands of team A',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionA}` },
    }),
    0,
  );
  assert.equal(
    (
      await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey: actionB },
      })
    ).state,
    'PENDING',
    'the team A revoke must not cancel the actions of team B',
  );
  assert.equal(
    (await f.owner.jrEnrollment.findUniqueOrThrow({ where: { id: enrollmentB.id } })).runState,
    'WAITING',
  );

  const duplicate = await withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
    service.apply(event, 'journey-iam-scope-test', transaction),
  );
  assert.deepEqual(duplicate, { state: 'DUPLICATE' });
  assert.equal(
    await f.owner.jrSegmentRefilterCursor.count({
      where: { tenantId: f.tenantId, scopeTeamId: f.teamId },
    }),
    1,
  );
});

test('an entry that has changed must not be treated as a correction of the original entry', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', `entry-old-${f.suffix}`);

  // Customer 360 answering with a new entry = a new round of entry, not a correction of the original round
  const outcome = await processor(f, eligible(f, `entry-new-${f.suffix}`)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'RECONCILING');
  assert.equal((await cursor(f)).reasonCode, 'INVALID_MEMBERSHIP_TRANSITION');
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
    'must not create a new enrollment from re-filter — a new entry must come with ENTERED only',
  );
});

test('lease: a second worker does not get the same cursor until the lease expires', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const claimed = await f.receipts.claimNextRefilter(f.tenantId, 'worker-1', 60);
  assert.ok(claimed);
  assert.equal(claimed.state, 'REVALIDATING');
  assert.equal(await f.receipts.claimNextRefilter(f.tenantId, 'worker-2', 60), undefined);

  // the first worker died midway, the work must return to the queue
  const expired = new JourneySegmentReceiptRepository(f.application, {
    now: () => new Date(Date.now() + 120_000),
  });
  const retaken = await expired.claimNextRefilter(f.tenantId, 'worker-2', 60);
  assert.equal(retaken?.id, claimed.id);
  assert.equal(retaken?.leaseOwner, 'worker-2');
});

test('no re-filter work returns undefined without touching anything', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await processor(f, eligible(f, 'entry')).executeNext(f.tenantId, 'worker-1'),
    undefined,
  );
});

/** creates a real enrollment through applyEnrollment and returns the enrollmentId */
async function enrollFor(f: Fixture, entryId: string, journeyId: string) {
  const received = await f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    changeKind: 'ENTERED',
    entryId,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
  });
  await f.receipts.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents: [
        {
          journeyId,
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${f.contactId}:${f.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  return enrollment.id;
}

async function ownerAction(f: Fixture, enrollmentId: string, actionKey: string) {
  return f.actions.ensureAction({
    tenantId: f.tenantId,
    actionKey,
    enrollmentId,
    kind: 'ENSURE_CASE',
    requestHash: 'b'.repeat(64),
    correlationId: `corr-${f.suffix}`,
    commandId: `command-${randomUUID()}`,
  });
}

test('pre-barrier: an action whose command has not left Journey is cancelled in-house and must not be dispatched', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);

  await queueRefilter(f, 2, 'LEFT', entryId);
  const outcome = await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'CANCELLED');

  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  // the command never left Journey — it can be cancelled in-house immediately without sending a cancel to the owner (#123)
  assert.equal(action.state, 'CANCELLED');
  const commands = await f.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.deepEqual(
    commands.map(({ state }) => state),
    ['CANCELLED'],
  );

  // the enrollment must end with the reason CANCELLED
  const enrollment = await f.owner.jrEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.equal(enrollment.runState, 'TERMINAL');
  assert.equal(enrollment.terminalReason, 'CANCELLED');
  assert.equal(enrollment.state, 'BLOCKED');
});

test('post-barrier: an action the owner has acked is not touched because an owner fact cannot be deleted', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);
  // the owner has really created the Case — past the barrier
  await f.owner.jrOwnerAction.updateMany({
    where: { tenantId: f.tenantId, actionKey },
    data: { state: 'ACKNOWLEDGED' },
  });

  await queueRefilter(f, 2, 'LEFT', entryId);
  assert.equal(
    await processor(f, {
      status: 'NOT_ELIGIBLE',
      reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
    }).executeNext(f.tenantId, 'worker-1'),
    'CANCELLED',
  );

  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(
    action.state,
    'ACKNOWLEDGED',
    'something the owner already created must not be reverted',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId, actionKey } }),
    1,
    'must not order cancellation of something that cannot be cancelled — only the original command exists',
  );
});

test('an enrollment already ended for another reason must not be overwritten as CANCELLED', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  // the goal was reached first — first-terminal-commit-wins
  await f.owner.jrEnrollment.update({
    where: { id: enrollmentId },
    data: { runState: 'TERMINAL', terminalReason: 'GOAL_REACHED', state: 'AUTHORIZED' },
  });

  await queueRefilter(f, 2, 'LEFT', entryId);
  await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');

  const enrollment = await f.owner.jrEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.equal(
    enrollment.terminalReason,
    'GOAL_REACHED',
    'the reason it ended must be recorded only once',
  );
  assert.equal(enrollment.state, 'AUTHORIZED');
});

test('cancelling again does not order the owner to cancel a second time', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);

  for (const revision of [2, 3]) {
    await queueRefilter(f, revision, 'LEFT', entryId);
    await new JourneySegmentRefilterProcessor(
      f.application,
      f.definitions,
      {
        membershipReader: reader({
          status: 'NOT_ELIGIBLE',
          reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
        }) as never,
        teamContactScopeAuthorizer: authorizer(ALLOW) as never,
      },
      { now: () => new Date(Date.now() + revision * 120_000) },
    ).executeNext(f.tenantId, `worker-${revision}`);
  }

  // the second round finds an action that is already terminal — no new command and nothing can go back to dispatch
  const commands = await f.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.deepEqual(
    commands.map(({ state }) => state),
    ['CANCELLED'],
  );
});

for (const operation of ['process', 'recover'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual refilter ${operation} ${order}`, async (t) => {
      const f = await fixture(t);
      const entryId = `entry-${f.suffix}`;
      await publishJourney(f);
      await queueRefilter(f, 1, 'CORRECTED', entryId);
      const current = await cursor(f);
      await f.owner.jrSegmentRefilterCursor.update({
        where: { id: current.id },
        data: { scopeTeamId: f.teamId, ...(operation === 'recover' ? { state: 'HELD' } : {}) },
      });
      await teamWriterRace({
        owner: f.owner,
        tenantId: f.tenantId,
        teamId: f.teamId,
        table: 'jr_segment_refilter_cursors',
        order,
        existingReferences: true,
        write: () =>
          operation === 'process'
            ? processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'core-writer')
            : new JourneySegmentRecovery(f.application).revalidateRefilter({
                tenantId: f.tenantId,
                targetRef: current.id,
                expectedVersion: current.version,
                reasonCode: 'ISOLATED_RECHECK',
                actorId: randomUUID(),
              }),
      });
    });

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual IAM invalidation scoped refilter ${order}`, async (t) => {
    const f = await fixture(t);
    const entryId = `entry-${f.suffix}`;
    await publishJourney(f);
    await f.receipts.ingest({
      tenantId: f.tenantId,
      source: 'CUSTOMER_360',
      eventId: randomUUID(),
      contactId: f.contactId,
      segmentId: f.segmentId,
      membershipRevision: 1,
      changeKind: 'ENTERED',
      entryId,
      segmentDefinitionVersion: 1,
      payloadHash: HASH,
      correlationId: randomUUID(),
    });
    await new JourneySegmentTriggerProcessor(f.application, f.definitions, {
      membershipReader: reader(eligible(f, entryId)) as never,
      teamContactScopeAuthorizer: authorizer(ALLOW) as never,
    }).executeNext(f.tenantId, 'core-trigger');
    const event = {
      schemaVersion: 2,
      eventKind: 'CANONICAL',
      eventId: randomUUID(),
      type: 'team.segment-scope.changed',
      tenantId: f.tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      orderingKey: f.teamId,
      aggregateType: 'iam_team_scope',
      aggregateId: f.teamId,
      aggregateVersion: 2,
      payload: {
        contractVersion: 1,
        teamId: f.teamId,
        grantId: randomUUID(),
        scopeVersion: 2,
        kind: 'REVOKED',
      },
    } as const;
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.tenantId,
      teamId: f.teamId,
      table: 'jr_segment_refilter_cursors',
      order,
      existingReferences: true,
      write: () =>
        withTenantDatabaseTransaction(f.application, f.tenantId, (tx) =>
          new JourneyIamScopeInvalidationService().apply(event, 'core-writer', tx),
        ),
    });
  });
