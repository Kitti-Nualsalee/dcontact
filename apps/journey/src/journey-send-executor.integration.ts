import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
/**
 * C1.6 acceptance: SEND composition against the real ContactGovernanceService and DeliveryTestAdapter
 * on real Postgres — proves the cross-app boundary rather than borrowing code (`@d-contact/contact-governance`
 * and `@d-contact/delivery` are dependencies for composing in tests only)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { DeliveryTestAdapter } from '@d-contact/delivery';
import { IamTeamContactScopeAuthorizer, IamTeamSegmentScopeRepository } from '@d-contact/iam';
import type {
  AuthorizeTeamContactScopeInput,
  ContactGovernancePort,
  DeliveryPort,
  EnqueueDeliveryCommand,
  EnqueueDeliveryResult,
  TeamContactScopeAuthorization,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  contactId as toContactId,
  customerSnapshotVersion,
  membershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentId,
} from '@d-contact/cxa-contracts';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import type { CreateJourneyVersionInput, JourneyGraph } from './journey-definition.js';
import {
  JourneyExecutionService,
  JourneyDefinitionNotPublishedError,
} from './journey-execution.js';
import { JourneySendExecutor } from './journey-send-executor.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

class AllowAllScope implements TeamContactScopeAuthorizer {
  async authorize(input: AuthorizeTeamContactScopeInput): Promise<TeamContactScopeAuthorization> {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  }
}

class DenyAllScope implements TeamContactScopeAuthorizer {
  async authorize(input: AuthorizeTeamContactScopeInput): Promise<TeamContactScopeAuthorization> {
    return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt: input.at };
  }
}

class DeferredScope implements TeamContactScopeAuthorizer {
  async authorize(input: AuthorizeTeamContactScopeInput): Promise<TeamContactScopeAuthorization> {
    return { decision: 'DEFER', reasonCode: 'SCOPE_CONTEXT_STALE', evaluatedAt: input.at };
  }
}

/** simulates a cancel that cuts in right after the reservation is held but before enqueue — wired to the real ports everywhere else */
class CancelAfterReserveGovernance implements ContactGovernancePort {
  constructor(
    private readonly inner: ContactGovernancePort,
    private readonly onReserved: () => Promise<void>,
  ) {}

  async authorizeAndReserve(
    ...args: Parameters<ContactGovernancePort['authorizeAndReserve']>
  ): ReturnType<ContactGovernancePort['authorizeAndReserve']> {
    const outcome = await this.inner.authorizeAndReserve(...args);
    await this.onReserved();
    return outcome;
  }

  claimReservationForDelivery(
    ...args: Parameters<ContactGovernancePort['claimReservationForDelivery']>
  ) {
    return this.inner.claimReservationForDelivery(...args);
  }

  renewReservationLease(...args: Parameters<ContactGovernancePort['renewReservationLease']>) {
    return this.inner.renewReservationLease(...args);
  }

  beginProviderSubmission(...args: Parameters<ContactGovernancePort['beginProviderSubmission']>) {
    return this.inner.beginProviderSubmission(...args);
  }

  confirmProviderAcceptance(
    ...args: Parameters<ContactGovernancePort['confirmProviderAcceptance']>
  ) {
    return this.inner.confirmProviderAcceptance(...args);
  }

  releaseBeforeSubmit(...args: Parameters<ContactGovernancePort['releaseBeforeSubmit']>) {
    return this.inner.releaseBeforeSubmit(...args);
  }

  settleDelivery(...args: Parameters<ContactGovernancePort['settleDelivery']>) {
    return this.inner.settleDelivery(...args);
  }
}

class UnreachableDelivery implements DeliveryPort {
  async enqueue(_command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    throw new Error('enqueue must not be called after a cancel cuts in');
  }
}

function sendThenExitGraph(): JourneyGraph {
  return {
    entryStepId: 'send-reminder',
    steps: [
      {
        id: 'send-reminder',
        type: 'SEND',
        channel: 'EMAIL',
        contentRef: 'template:c1-6/v1',
        next: 'exit-done',
      },
      { id: 'exit-done', type: 'EXIT', reason: 'GOAL_REACHED' },
    ],
  };
}

/** BRANCH decides deterministically from `vars.stillUnpaid` through DC_EXPR:1 before reaching SEND */
function branchThenSendGraph(): JourneyGraph {
  return {
    entryStepId: 'branch-unpaid',
    steps: [
      {
        id: 'branch-unpaid',
        type: 'BRANCH',
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: { type: 'ref', path: ['vars', 'stillUnpaid'] },
        },
        whenTrue: 'send-reminder',
        whenFalse: 'exit-paid',
      },
      {
        id: 'send-reminder',
        type: 'SEND',
        channel: 'EMAIL',
        contentRef: 'template:c1-6/v1',
        next: 'exit-done',
      },
      { id: 'exit-paid', type: 'EXIT', reason: 'GOAL_REACHED' },
      { id: 'exit-done', type: 'EXIT', reason: 'GOAL_REACHED' },
    ],
  };
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const rawContactId = randomUUID();
  const rawIdentityId = randomUUID();
  const rawTeamId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  t.after(async () => {
    await owner.dlOutboxEntry.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrStepRun.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrScheduleOccurrence.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.updateMany({
      where: { tenantId: rawTenantId },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamScopeInvalidationOutbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamScopeConsumerInbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.iamTeamScopeVersion.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `C1.6 send ${suffix}`,
      slug: `c1-6-send-${suffix}`,
      sipDomain: `${suffix}.c1-6-send.test`,
    },
  });
  await owner.team.create({ data: { id: rawTeamId, tenantId: rawTenantId, name: 'Collections' } });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'C1.6 contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: rawIdentityId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      type: 'EMAIL',
      value: `c1-6-${suffix}@example.test`,
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId: rawTenantId,
      contactId: rawContactId,
      identityId: rawIdentityId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });

  const evaluator = new DcExprEvaluator();
  const definitions = new JourneyDefinitionRepository(application, evaluator);
  const governance = new ContactGovernanceService(application);
  const delivery = new DeliveryTestAdapter(application, governance);
  const execution = new JourneyExecutionService(application, definitions, evaluator);

  const journeyId = randomUUID();
  async function publish(overrides: Partial<CreateJourneyVersionInput> = {}) {
    const draft = await definitions.createVersion({
      tenantId: rawTenantId,
      journeyId,
      version: 1,
      name: `Journey ${suffix}`,
      ownerTeamId: rawTeamId,
      purpose: 'MARKETING',
      senderIdentityId: `sender-${suffix}`,
      trigger: { kind: 'SCHEDULE', cron: '0 9 * * *', timezone: 'Asia/Bangkok' },
      graph: sendThenExitGraph(),
      goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 7,
      correlationId: `corr-${suffix}`,
      ...overrides,
    });
    await definitions.publishVersion({
      tenantId: rawTenantId,
      journeyId,
      version: 1,
      expectedContentHash: draft.contentHash,
      correlationId: `publish-${suffix}`,
    });
  }
  await publish();

  async function enrollAndAdvanceToSend() {
    const enrollment = await execution.enrollFromSchedule(rawTenantId, {
      journeyId,
      journeyVersion: 1,
      occurrenceAt: '2026-09-10T09:00:00.000Z',
      correlationId: `corr-${suffix}`,
    });
    const outcome = await execution.advance(rawTenantId, enrollment.enrollmentId, {
      correlationId: `corr-${suffix}`,
    });
    assert.equal(outcome.kind, 'AWAITING_SEND');
    return outcome as Extract<typeof outcome, { kind: 'AWAITING_SEND' }>;
  }

  return {
    owner,
    application,
    execution,
    definitions,
    governance,
    delivery,
    rawTenantId,
    rawContactId,
    rawIdentityId,
    rawTeamId,
    journeyId,
    suffix,
    enrollAndAdvanceToSend,
  };
}

test('a SEND whose scope is ALLOW calls authorize/reserve before enqueue and then advances the cursor', async (t) => {
  const f = await fixture(t);
  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new AllowAllScope(),
    f.governance,
    f.delivery,
  );

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}`,
  });

  assert.equal(result.kind, 'SENT');
  assert.equal(result.enrollment.currentStepId, 'exit-done');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 1);
  const reservation = await f.owner.cgReservation.findFirst({ where: { tenantId: f.rawTenantId } });
  assert.equal(reservation?.settlementStatus, 'CLAIMED');
  assert.equal(reservation?.contactId, f.rawContactId);
});

test('a SEND whose scope is DENY does not authorize/reserve or enqueue but still advances the cursor', async (t) => {
  const f = await fixture(t);
  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new DenyAllScope(),
    f.governance,
    f.delivery,
  );

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}`,
  });

  assert.equal(result.kind, 'SCOPE_DENIED');
  if (result.kind === 'SCOPE_DENIED') assert.equal(result.reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
  assert.equal(result.enrollment.currentStepId, 'exit-done');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('a revoked IAM CONTACT grant stops SEND before the Governance reservation and Delivery', async (t) => {
  const f = await fixture(t);
  const scope = new IamTeamSegmentScopeRepository(f.application);
  const scopeSegment = `send-scope-${f.suffix}`;
  const grant = await scope.grant({
    tenantId: f.rawTenantId,
    teamId: f.rawTeamId,
    segmentId: scopeSegment,
    permission: 'CONTACT',
    correlationId: `grant-contact-${f.suffix}`,
  });
  await scope.applyMembershipChange({
    tenantId: f.rawTenantId,
    consumerGroup: 'journey-send-iam-test',
    eventId: `membership-${f.suffix}`,
    occurredAt: '2099-01-01T00:00:00.000Z',
    payload: {
      contractVersion: 1,
      contactId: toContactId(f.rawContactId),
      segmentId: segmentId(scopeSegment),
      membershipRevision: membershipRevision(1),
      changeKind: 'ENTERED',
      entryId: segmentEntryId(`entry-${f.suffix}`),
      segmentDefinitionVersion: segmentDefinitionVersion(1),
      snapshotVersion: customerSnapshotVersion(1),
      evaluatedAt: '2099-01-01T00:00:00.000Z',
      stateDigest: 'c'.repeat(64),
    },
  });
  if (grant.outcome !== 'GRANTED') throw new Error('the fixture must create a new CONTACT grant');
  await scope.revoke({
    tenantId: f.rawTenantId,
    grantId: grant.grant.id,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: `revoke-contact-${f.suffix}`,
  });

  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new IamTeamContactScopeAuthorizer(f.application),
    f.governance,
    f.delivery,
  );
  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-after-revoke-${f.suffix}`,
  });

  assert.equal(result.kind, 'SCOPE_DENIED');
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.rawTenantId } }), 0);
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('a SEND whose scope is stale does not reserve or enqueue and keeps the cursor to resolve IAM again', async (t) => {
  const f = await fixture(t);
  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new DeferredScope(),
    f.governance,
    f.delivery,
  );

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-stale-${f.suffix}`,
  });

  assert.equal(result.kind, 'SCOPE_DEFERRED');
  if (result.kind === 'SCOPE_DEFERRED') {
    assert.equal(result.reasonCode, 'SCOPE_CONTEXT_STALE');
    assert.equal(result.enrollment.currentStepId, 'send-reminder');
  }
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('a SEND with no consent is suppressed by Governance but still advances the cursor without enqueue', async (t) => {
  const f = await fixture(t);
  await f.owner.cgConsent.deleteMany({ where: { tenantId: f.rawTenantId } });
  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new AllowAllScope(),
    f.governance,
    f.delivery,
  );

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}`,
  });

  assert.equal(result.kind, 'SUPPRESSED');
  assert.equal(result.enrollment.currentStepId, 'exit-done');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('calling handleSend again after completeSend has succeeded does not enqueue again (idempotent retry)', async (t) => {
  const f = await fixture(t);
  const parked = await f.enrollAndAdvanceToSend();
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new AllowAllScope(),
    f.governance,
    f.delivery,
  );
  const input = {
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}`,
  };

  const first = await executor.handleSend(input);
  assert.equal(first.kind, 'SENT');
  const retry = await executor.handleSend(input);
  assert.equal(retry.kind, 'RACE_LOST');
  assert.equal(retry.enrollment.currentStepId, first.enrollment.currentStepId);
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('a cancel that cuts in after the reservation but before enqueue makes the reservation be released instead of sending', async (t) => {
  const f = await fixture(t);
  const parked = await f.enrollAndAdvanceToSend();

  const governance = new CancelAfterReserveGovernance(f.governance, () =>
    f.execution.cancel(f.rawTenantId, parked.enrollment.enrollmentId).then(() => undefined),
  );
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new AllowAllScope(),
    governance,
    new UnreachableDelivery(),
  );

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}`,
  });

  assert.equal(result.kind, 'RELEASED_BEFORE_SUBMIT');
  const reservation = await f.owner.cgReservation.findFirst({ where: { tenantId: f.rawTenantId } });
  assert.equal(reservation?.state, 'RELEASED');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('a SEND on a journey that is not published makes advance reject before reaching C1.6', async (t) => {
  const f = await fixture(t);
  const secondJourneyId = randomUUID();
  const draft = await f.definitions.createVersion({
    tenantId: f.rawTenantId,
    journeyId: secondJourneyId,
    version: 1,
    name: `Journey unpublished ${f.suffix}`,
    ownerTeamId: f.rawTeamId,
    purpose: 'MARKETING',
    senderIdentityId: `sender-${f.suffix}`,
    trigger: { kind: 'SCHEDULE', cron: '0 9 * * *', timezone: 'Asia/Bangkok' },
    graph: sendThenExitGraph(),
    goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    correlationId: `corr-${f.suffix}`,
  });
  assert.equal(draft.status, 'DRAFT');

  await assert.rejects(
    () =>
      f.execution.enrollFromSchedule(f.rawTenantId, {
        journeyId: secondJourneyId,
        journeyVersion: 1,
        occurrenceAt: '2026-09-10T09:00:00.000Z',
        correlationId: `corr-${f.suffix}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyDefinitionNotPublishedError);
      return true;
    },
  );
});

test('BRANCH decides through DC_EXPR:1 before reaching SEND — the true path really enqueues, the false path does not touch Governance at all', async (t) => {
  const f = await fixture(t);
  const branchJourneyId = randomUUID();
  const draft = await f.definitions.createVersion({
    tenantId: f.rawTenantId,
    journeyId: branchJourneyId,
    version: 1,
    name: `Journey branch ${f.suffix}`,
    ownerTeamId: f.rawTeamId,
    purpose: 'MARKETING',
    senderIdentityId: `sender-${f.suffix}`,
    trigger: { kind: 'SCHEDULE', cron: '0 9 * * *', timezone: 'Asia/Bangkok' },
    graph: branchThenSendGraph(),
    goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    correlationId: `corr-${f.suffix}`,
  });
  await f.definitions.publishVersion({
    tenantId: f.rawTenantId,
    journeyId: branchJourneyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: `publish-${f.suffix}`,
  });
  const executor = new JourneySendExecutor(
    f.execution,
    f.definitions,
    new AllowAllScope(),
    f.governance,
    f.delivery,
  );

  // the whenFalse path: the first advance() walks BRANCH to exit-paid (ADVANCED) and then calls again
  // to process that EXIT — this engine always walks one node per call
  const paidEnrollment = await f.execution.enrollFromSchedule(f.rawTenantId, {
    journeyId: branchJourneyId,
    journeyVersion: 1,
    occurrenceAt: '2026-09-10T09:00:00.000Z',
    correlationId: `corr-${f.suffix}-paid`,
  });
  const paidBranch = await f.execution.advance(f.rawTenantId, paidEnrollment.enrollmentId, {
    correlationId: `corr-${f.suffix}-paid`,
    context: { vars: { stillUnpaid: false } },
  });
  assert.equal(paidBranch.kind, 'ADVANCED');
  if (paidBranch.kind === 'ADVANCED') assert.equal(paidBranch.nextStepId, 'exit-paid');
  const paidOutcome = await f.execution.advance(f.rawTenantId, paidEnrollment.enrollmentId, {
    correlationId: `corr-${f.suffix}-paid`,
  });
  assert.equal(paidOutcome.kind, 'TERMINAL');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 0);
  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.rawTenantId } }), 0);

  // the whenTrue path: the first advance() walks BRANCH to send-reminder (ADVANCED) and then calls again to
  // process that SEND and get AWAITING_SEND for C1.6 to take over
  const unpaidEnrollment = await f.execution.enrollFromSchedule(f.rawTenantId, {
    journeyId: branchJourneyId,
    journeyVersion: 1,
    occurrenceAt: '2026-09-10T10:00:00.000Z',
    correlationId: `corr-${f.suffix}-unpaid`,
  });
  const unpaidBranch = await f.execution.advance(f.rawTenantId, unpaidEnrollment.enrollmentId, {
    correlationId: `corr-${f.suffix}-unpaid`,
    context: { vars: { stillUnpaid: true } },
  });
  assert.equal(unpaidBranch.kind, 'ADVANCED');
  if (unpaidBranch.kind === 'ADVANCED') assert.equal(unpaidBranch.nextStepId, 'send-reminder');
  const unpaidOutcome = await f.execution.advance(f.rawTenantId, unpaidEnrollment.enrollmentId, {
    correlationId: `corr-${f.suffix}-unpaid`,
  });
  assert.equal(unpaidOutcome.kind, 'AWAITING_SEND');
  const parked = unpaidOutcome as Extract<typeof unpaidOutcome, { kind: 'AWAITING_SEND' }>;
  assert.equal(parked.stepId, 'send-reminder');

  const result = await executor.handleSend({
    tenantId: f.rawTenantId,
    enrollmentId: parked.enrollment.enrollmentId,
    stepId: parked.stepId,
    stepSequence: parked.stepSequence,
    contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
    correlationId: `send-${f.suffix}-unpaid`,
  });
  assert.equal(result.kind, 'SENT');
  assert.equal(result.enrollment.currentStepId, 'exit-done');
  assert.equal(await f.owner.dlOutboxEntry.count({ where: { tenantId: f.rawTenantId } }), 1);
});

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual legacy SEND reservation ${order}`, async (t) => {
    const f = await fixture(t);
    const parked = await f.enrollAndAdvanceToSend();
    const executor = new JourneySendExecutor(
      f.execution,
      f.definitions,
      new AllowAllScope(),
      f.governance,
      f.delivery,
    );
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.rawTenantId,
      teamId: f.rawTeamId,
      table: 'cg_reservations',
      order,
      existingReferences: true,
      write: () =>
        executor.handleSend({
          tenantId: f.rawTenantId,
          enrollmentId: parked.enrollment.enrollmentId,
          stepId: parked.stepId,
          stepSequence: parked.stepSequence,
          contact: { contactId: f.rawContactId, identityId: f.rawIdentityId },
          correlationId: randomUUID(),
        }),
    });
  });
