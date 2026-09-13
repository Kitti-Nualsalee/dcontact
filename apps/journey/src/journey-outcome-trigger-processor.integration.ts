import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
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
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
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
  overrides: { outcomeCode?: string; outcomeId?: string; interactionId?: string } = {},
) {
  const interactionId = overrides.interactionId ?? randomUUID();
  return receipts.ingest({
    tenantId: f.tenantId,
    source: 'INTERACTION',
    eventId: randomUUID(),
    outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
    outcomeId: overrides.outcomeId ?? randomUUID(),
    outcomeVersion: 1,
    payloadHash: 'a'.repeat(64),
    payload: {
      interactionId,
      ...(f.contactId ? { contactId: f.contactId } : {}),
      outcomeCode: overrides.outcomeCode ?? 'CALLBACK_REQUESTED',
      effectiveAt: new Date().toISOString(),
    },
    correlationId: 'corr-outcome-1',
  });
}

test('outcome ที่ match trigger และผ่าน WORK scope ทั้งสองฝั่งสร้าง enrollment + owner action intent atomic กับ receipt APPLIED', async (t) => {
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
  assert.ok(outbox.payload, 'command payload ต้องถูก stage พร้อม relay จริง');

  const receipt = await f.owner.jrOutcomeReceipt.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(receipt.state, 'APPLIED');
});

test('receipt ที่ไม่มี contactId เข้า REVIEW/IDENTITY_UNRESOLVED และไม่สร้าง enrollment', async (t) => {
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

test('scope ที่ stale คืน DEFER ไม่มี side effect และ receipt กลับไป READY ให้ retry', async (t) => {
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

test('scope denial สร้าง enrollment BLOCKED โดยไม่มี owner action และ receipt ยังถือว่า APPLIED', async (t) => {
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

test('outcome ที่ไม่มี published journey จับคู่ถูก apply เป็น no-op โดยไม่มี enrollment/action', async (t) => {
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

test('retry บน enrollment ที่ค้างจาก crash ก่อนหน้าไม่สร้าง enrollment ซ้ำ (restart-safe)', async (t) => {
  const f = await fixture(t);
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const receipts = new JourneyOutcomeReceiptRepository(f.application);
  const matched = await publishOutcomeJourney(definitions, f);
  const ingested = await ingestReceipt(receipts, f);

  // simulate ว่า worker คนก่อนหน้าตายหลัง ensureEnrollment commit แต่ก่อน settle transaction
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
