import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createJourneyOutcomeTriggerPorts } from '@d-contact/journey-composition';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  contactId as toContactId,
  type ContactIdentityResolution,
  type ResolveContactIdentityInput,
  type TeamContactScopeAuthorization,
  type AuthorizeTeamContactScopeInput,
} from '@d-contact/cxa-contracts';
import type { CreateJourneyVersionInput, JourneyGraph } from './journey-definition.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneyOutcomeReceiptRepository } from './journey-outcome-receipt-repository.js';
import {
  JourneyOwnerActionRepository,
  cancelCommandIdFor,
} from './journey-owner-action-repository.js';
import { JourneyOutcomeTriggerProcessor } from './journey-outcome-trigger-processor.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const evaluator = new DcExprEvaluator();

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const ownerTeamId = randomUUID();
  const targetTeamId = randomUUID();
  const contactId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.7 trigger ${suffix}`,
      slug: `j2-7-trigger-${suffix}`,
      sipDomain: `${suffix}.j2-7-trigger.test`,
    },
  });
  await owner.team.create({ data: { id: ownerTeamId, tenantId, name: 'Journey owner' } });
  await owner.team.create({ data: { id: targetTeamId, tenantId, name: 'Dialer target' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });

  t.after(async () => {
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrOutcomeReceipt.deleteMany({ where: { tenantId } });
    await owner.jrOutcomeHead.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.c360IdentityHead.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { owner, application, tenantId, ownerTeamId, targetTeamId, contactId };
}

function admitCampaignGraph(targetOwnerTeamId: string): JourneyGraph {
  return {
    entryStepId: 'admit',
    steps: [
      {
        id: 'admit',
        type: 'ADMIT_CAMPAIGN_TARGET',
        campaignId: 'campaign-collections',
        targetOwnerTeamId,
        next: 'exit-goal',
        onReject: 'exit-rejected',
      },
      { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
      { id: 'exit-rejected', type: 'EXIT', reason: 'REJECTED' },
    ],
  };
}

async function publishOutcomeJourney(
  definitions: JourneyDefinitionRepository,
  f: { tenantId: string; ownerTeamId: string; targetTeamId: string },
  overrides: Partial<CreateJourneyVersionInput> = {},
) {
  const journeyId = randomUUID();
  const input: CreateJourneyVersionInput = {
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    correlationId: 'corr-def-1',
    name: 'Admit to collections campaign',
    ownerTeamId: f.ownerTeamId,
    purpose: 'SERVICE',
    senderIdentityId: 'sender-1',
    trigger: {
      kind: 'INTERACTION_OUTCOME',
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeCode: 'CALLBACK_REQUESTED',
      coalescingPolicy: 'PER_LOGICAL_OUTCOME',
    },
    graph: admitCampaignGraph(f.targetTeamId),
    goal: { kind: 'EVENT', eventType: 'campaign.completed' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 30,
    ...overrides,
  };
  await definitions.createVersion(input);
  return definitions.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: (await definitions.getVersion(f.tenantId, journeyId, 1))!.contentHash,
    correlationId: 'corr-pub-1',
  });
}

function allowResolver(contactId: string) {
  return {
    async resolveByContactId(
      _input: ResolveContactIdentityInput,
    ): Promise<ContactIdentityResolution> {
      return {
        status: 'RESOLVED',
        contactId: toContactId(contactId),
        segmentMemberships: [],
        snapshotVersion: 1,
        evaluatedAt: new Date().toISOString(),
      };
    },
  };
}

function fixedScope(decision: TeamContactScopeAuthorization['decision']) {
  return {
    async authorize(
      _input: AuthorizeTeamContactScopeInput,
    ): Promise<TeamContactScopeAuthorization> {
      if (decision === 'ALLOW') {
        return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: new Date().toISOString() };
      }
      if (decision === 'DEFER') {
        return {
          decision: 'DEFER',
          reasonCode: 'SCOPE_CONTEXT_STALE',
          evaluatedAt: new Date().toISOString(),
        };
      }
      return {
        decision: 'DENY',
        reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
        evaluatedAt: new Date().toISOString(),
      };
    },
  };
}

async function ingestReceipt(
  receipts: JourneyOutcomeReceiptRepository,
  f: { tenantId: string; contactId?: string },
  overrides: {
    outcomeCode?: string;
    outcomeId?: string;
    outcomeVersion?: number;
    interactionId?: string;
  } = {},
) {
  const interactionId = overrides.interactionId ?? randomUUID();
  return receipts.ingest({
    tenantId: f.tenantId,
    source: 'INTERACTION',
    eventId: randomUUID(),
    outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
    outcomeId: overrides.outcomeId ?? randomUUID(),
    outcomeVersion: overrides.outcomeVersion ?? 1,
    payloadHash: String(overrides.outcomeVersion ?? 1)
      .repeat(64)
      .slice(0, 64),
    payload: {
      interactionId,
      ...(f.contactId ? { contactId: f.contactId } : {}),
      outcomeCode: overrides.outcomeCode ?? 'CALLBACK_REQUESTED',
      effectiveAt: new Date().toISOString(),
    },
    correlationId: 'corr-outcome-1',
  });
}

test('an outcome that matches a trigger and passes WORK scope on both sides creates an enrollment + owner action intent atomically with the receipt APPLIED', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const actions = new JourneyOwnerActionRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, f);

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'ENROLLED');

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(enrollment.state, 'AUTHORIZED');
  assert.equal(enrollment.contactId, f.contactId);
  assert.equal(enrollment.currentStepId, 'admit');

  const action = await actions.getAction(
    f.tenantId,
    `${enrollment.id}:${enrollment.journeyVersion}:admit`,
  );
  assert.equal(action?.state, 'PENDING');
  assert.equal(action?.kind, 'ADMIT_CAMPAIGN_TARGET');
  assert.equal(action?.outcomeReceiptId, enrollment.outcomeReceiptId);

  const outbox = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey: action!.actionKey },
  });
  assert.ok(outbox.payload, 'the command payload must be staged ready for a real relay');

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'APPLIED');
});

test('a receipt without a contactId goes to REVIEW/IDENTITY_UNRESOLVED and creates no enrollment', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, { tenantId: f.tenantId });

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'REVIEW');

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'REVIEW');
  assert.equal(receipt.reviewReasonCode, 'IDENTITY_UNRESOLVED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
});

test('a stale scope returns DEFER with no side effect and the receipt goes back to READY for retry', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, f);

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('DEFER'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'DEFERRED');

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'READY');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
});

test('a scope denial creates a BLOCKED enrollment with no owner action and the receipt still counts as APPLIED', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, f);

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('DENY'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'BLOCKED');

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(enrollment.state, 'BLOCKED');
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 0);

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'APPLIED');
});

test('an outcome with no matching published journey is applied as a no-op with no enrollment/action', async (t) => {
  const f = await fixture(t);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  await ingestReceipt(receipts, f, { outcomeCode: 'ABANDONED' });

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'NO_MATCH');

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'APPLIED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
});

test('a retry on an enrollment left over from an earlier crash does not create a duplicate enrollment (restart-safe)', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const matched = await publishOutcomeJourney(definitions, f);
  const ingested = await ingestReceipt(receipts, f);

  // simulate that the previous worker died after ensureEnrollment committed but before the settle transaction
  await f.owner.jrEnrollment.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      outcomeReceiptId: ingested.receipt.id,
      journeyId: matched.journeyId,
      journeyVersion: matched.version,
      contactId: f.contactId,
      currentStepId: 'admit',
      state: 'PENDING',
      runState: 'WAITING',
      correlationId: 'corr-outcome-1',
    },
  });
  await f.owner.jrOutcomeReceipt.update({
    where: { id: ingested.receipt.id },
    data: { state: 'READY' },
  });

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  const outcome = await processor.executeNext(f.tenantId, 'worker-2');
  assert.equal(outcome, 'ENROLLED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 1);
});

function processorWith(
  f: { application: PrismaClient; contactId: string },
  definitions: JourneyDefinitionRepository,
  decision: TeamContactScopeAuthorization['decision'] = 'ALLOW',
) {
  return new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: fixedScope(decision),
  });
}

test('a correction revision that still matches re-evaluates the existing enrollment and creates no new enrollment/action', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  const outcomeId = randomUUID();
  const interactionId = randomUUID();
  const processor = processorWith(f, definitions);

  await ingestReceipt(receipts, f, { outcomeId, interactionId });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');

  const corrected = await ingestReceipt(receipts, f, {
    outcomeId,
    interactionId,
    outcomeVersion: 2,
  });
  assert.equal(corrected.outcome, 'READY');
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'UNCHANGED');

  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 1);
  const head = await f.owner.jrOutcomeHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedVersion, 2);
});

test('a correction that no longer matches the trigger requests cancelling the still-reversible action with the same actionKey and stops the enrollment', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  const outcomeId = randomUUID();
  const interactionId = randomUUID();
  const processor = processorWith(f, definitions);

  await ingestReceipt(receipts, f, { outcomeId, interactionId });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');
  const [original] = await f.owner.jrOwnerAction.findMany({ where: { tenantId: f.tenantId } });
  const [originalCommand] = await f.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: f.tenantId },
  });
  // the relay already sent the command out — cancellation must go through the owner
  await new JourneyOwnerActionRepository(f.application).markCommandDispatched(
    f.tenantId,
    originalCommand!.commandId,
  );

  await ingestReceipt(receipts, f, {
    outcomeId,
    interactionId,
    outcomeVersion: 2,
    outcomeCode: 'RESOLVED_FIRST_CONTACT',
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'CANCELLED');

  const actions = await f.owner.jrOwnerAction.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(actions.length, 1, 'a new action key must not be issued to cancel');
  assert.equal(actions[0]!.actionKey, original!.actionKey);
  assert.equal(actions[0]!.state, 'CANCEL_REQUESTED');
  const cancelCommand = await f.owner.jrOwnerCommandOutbox.findUniqueOrThrow({
    where: {
      tenantId_commandId: {
        tenantId: f.tenantId,
        commandId: cancelCommandIdFor(
          f.tenantId,
          original!.actionKey,
          `outcome-correction:${original!.actionKey}`,
        ),
      },
    },
  });
  const cancelPayload = cancelCommand.payload as {
    commandType: string;
    actionKey: string;
    intent: { reasonCode: string };
  };
  assert.equal(cancelPayload.commandType, 'CANCEL_CAMPAIGN_TARGET');
  assert.equal(cancelPayload.actionKey, original!.actionKey);
  assert.equal(cancelPayload.intent.reasonCode, 'OUTCOME_CORRECTED');

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(enrollment.runState, 'TERMINAL');
  assert.equal(enrollment.terminalReason, 'CANCELLED');

  // a later correction revision that matches again does not wake the ended enrollment and creates no new one
  await ingestReceipt(receipts, f, { outcomeId, interactionId, outcomeVersion: 3 });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'UNCHANGED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 1);
});

test('a correction before the original command leaves Journey cancels in-house and no command is dispatched', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  const outcomeId = randomUUID();
  const interactionId = randomUUID();
  const processor = processorWith(f, definitions);

  await ingestReceipt(receipts, f, { outcomeId, interactionId });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');
  await ingestReceipt(receipts, f, {
    outcomeId,
    interactionId,
    outcomeVersion: 2,
    outcomeCode: 'RESOLVED_FIRST_CONTACT',
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'CANCELLED');

  const action = await f.owner.jrOwnerAction.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(action.state, 'CANCELLED');
  const commands = await f.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: f.tenantId },
  });
  assert.deepEqual(
    commands.map(({ state }) => state),
    ['CANCELLED'],
  );
});

test('the first revision does not match but a correction does — enroll once bound to the matching revision', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  const outcomeId = randomUUID();
  const interactionId = randomUUID();
  const processor = processorWith(f, definitions);

  await ingestReceipt(receipts, f, { outcomeId, interactionId, outcomeCode: 'NO_ANSWER' });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'NO_MATCH');

  const corrected = await ingestReceipt(receipts, f, {
    outcomeId,
    interactionId,
    outcomeVersion: 2,
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(enrollment.outcomeReceiptId, corrected.receipt.id);
});

test('a single outcome can fan out to several published journeys deterministically and a replay creates no duplicates', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const specific = await publishOutcomeJourney(definitions, f);
  const wildcard = await publishOutcomeJourney(definitions, f, {
    name: 'Any disposition',
    trigger: {
      kind: 'INTERACTION_OUTCOME',
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      coalescingPolicy: 'PER_LOGICAL_OUTCOME',
    },
  });
  const processor = processorWith(f, definitions);
  const ingested = await ingestReceipt(receipts, f);

  const matched = await definitions.findPublishedByOutcomeTrigger(
    f.tenantId,
    'INTERACTION_DISPOSITION_RECORDED',
    'CALLBACK_REQUESTED',
  );
  assert.deepEqual(
    matched.map(({ journeyId }) => journeyId),
    [specific.journeyId, wildcard.journeyId].sort(),
  );

  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');
  const enrollments = await f.owner.jrEnrollment.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { journeyId: 'asc' },
  });
  assert.deepEqual(
    enrollments.map(({ journeyId }) => journeyId),
    [specific.journeyId, wildcard.journeyId].sort(),
  );
  assert.ok(enrollments.every(({ outcomeReceiptId }) => outcomeReceiptId === ingested.receipt.id));
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 2);

  // at-least-once: the same receipt processed again after a crash must give the same result
  await f.owner.jrOutcomeReceipt.update({
    where: { id: ingested.receipt.id },
    data: { state: 'READY' },
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-2'), 'UNCHANGED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 2);
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 2);
});

test('fan-out: a stale scope in any one journey defers the whole receipt with no partial side effect', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const otherTeamId = randomUUID();
  await f.owner.team.create({ data: { id: otherTeamId, tenantId: f.tenantId, name: 'Stale' } });
  await publishOutcomeJourney(definitions, f);
  await publishOutcomeJourney(definitions, f, { graph: admitCampaignGraph(otherTeamId) });
  await ingestReceipt(receipts, f);

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: allowResolver(f.contactId),
    teamContactScopeAuthorizer: {
      async authorize(input: AuthorizeTeamContactScopeInput) {
        return input.teamId === otherTeamId
          ? fixedScope('DEFER').authorize(input)
          : fixedScope('ALLOW').authorize(input);
      },
    },
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'DEFERRED');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 0);
});

async function identityHead(
  f: { owner: PrismaClient; tenantId: string },
  contactIdValue: string,
  state: 'ACTIVE' | 'MERGED' | 'AMBIGUOUS',
  canonicalContactId: string,
  lineageRevision = 1,
) {
  await f.owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId: contactIdValue,
      state,
      canonicalContactId,
      lineageRevision,
      stateDigest: 'd'.repeat(64),
    },
  });
}

test('a merged contact uses the Customer 360 survivor for the enrollment/command and the receipt keeps the original lineage', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const survivorId = randomUUID();
  await f.owner.contact.create({ data: { id: survivorId, tenantId: f.tenantId } });
  await identityHead(f, survivorId, 'ACTIVE', survivorId);
  await identityHead(f, f.contactId, 'MERGED', survivorId);
  await publishOutcomeJourney(definitions, f);
  const ingested = await ingestReceipt(receipts, f);

  const ports = createJourneyOutcomeTriggerPorts(f.application);
  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: ports.identityResolver,
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'ENROLLED');

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(enrollment.contactId, survivorId);
  const outbox = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal((outbox.payload as { contactId: string }).contactId, survivorId);

  const receipt = await f.owner.jrOutcomeReceipt.findUniqueOrThrow({
    where: { id: ingested.receipt.id },
  });
  assert.equal((receipt.payload as { contactId: string }).contactId, f.contactId);

  const resolution = await ports.identityResolver.resolveByContactId({
    tenantId: f.tenantId as never,
    contactId: f.contactId as never,
    at: new Date().toISOString(),
  });
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.status === 'RESOLVED' && resolution.originalContactId, f.contactId);
});

test('an ambiguous identity or a merge chain that is not yet settled goes to REVIEW/IDENTITY_UNRESOLVED with no enrollment', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const survivorId = randomUUID();
  const ambiguousId = randomUUID();
  await f.owner.contact.create({ data: { id: survivorId, tenantId: f.tenantId } });
  await f.owner.contact.create({ data: { id: ambiguousId, tenantId: f.tenantId } });
  await identityHead(f, ambiguousId, 'AMBIGUOUS', ambiguousId);
  // the survivor was marked ambiguous in turn — never guess the survivor for a contact merged into it
  await identityHead(f, survivorId, 'AMBIGUOUS', survivorId);
  await identityHead(f, f.contactId, 'MERGED', survivorId);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, f);
  await ingestReceipt(receipts, { tenantId: f.tenantId, contactId: ambiguousId });

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: createJourneyOutcomeTriggerPorts(f.application).identityResolver,
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'REVIEW');
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'REVIEW');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
  const reasons = await f.owner.jrOutcomeReceipt.findMany({
    where: { tenantId: f.tenantId },
    select: { state: true, reviewReasonCode: true },
  });
  assert.ok(
    reasons.every(
      ({ state, reviewReasonCode }) =>
        state === 'REVIEW' && reviewReasonCode === 'IDENTITY_UNRESOLVED',
    ),
  );
});

test('a contactId from another tenant is rejected as NOT_FOUND without revealing that it exists', async (t) => {
  const f = await fixture(t);
  const foreign = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  await publishOutcomeJourney(definitions, f);
  await ingestReceipt(receipts, { tenantId: f.tenantId, contactId: foreign.contactId });

  const ports = createJourneyOutcomeTriggerPorts(f.application);
  const resolution = await ports.identityResolver.resolveByContactId({
    tenantId: f.tenantId as never,
    contactId: foreign.contactId as never,
    at: new Date().toISOString(),
  });
  assert.deepEqual(resolution, { status: 'NOT_FOUND', reasonCode: 'IDENTITY_NOT_FOUND' });

  const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
    identityResolver: ports.identityResolver,
    teamContactScopeAuthorizer: fixedScope('ALLOW'),
  });
  assert.equal(await processor.executeNext(f.tenantId, 'worker-1'), 'REVIEW');
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
});

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual outcome trigger enrollment ${order}`, async (t) => {
    const f = await fixture(t);
    const definitions = new JourneyDefinitionRepository(f.application, evaluator);
    await publishOutcomeJourney(definitions, f);
    await ingestReceipt(new JourneyOutcomeReceiptRepository(f.application), f);
    const processor = new JourneyOutcomeTriggerProcessor(f.application, definitions, {
      identityResolver: allowResolver(f.contactId),
      teamContactScopeAuthorizer: fixedScope('ALLOW'),
    });
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.tenantId,
      teamId: f.ownerTeamId,
      table: 'jr_enrollments',
      order,
      write: () => processor.executeNext(f.tenantId, 'core-writer'),
    });
  });
