import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneyOwnerActionRepository,
  type ApplyOwnerResultInput,
} from './journey-owner-action-repository.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const STEP_ID = 'ensure-case';
const SUCCESS_STEP_ID = 'success-exit';
const REJECT_STEP_ID = 'reject-exit';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const journeyId = randomUUID();
  const enrollmentId = randomUUID();
  const teamId = randomUUID();
  const actionKey = `${enrollmentId}:1:${STEP_ID}`;
  const commandId = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J5.0 continuation ${tenantId.slice(0, 8)}`,
      slug: `j5-0-continuation-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j5-0.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'J5.0 owner team' } });
  await owner.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'J5.0 fixture',
      ownerTeamId: teamId,
      purpose: 'SERVICE',
      senderIdentityId: 'test-adapter',
      status: 'PUBLISHED',
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
      graph: {
        entryStepId: STEP_ID,
        steps: [
          {
            id: STEP_ID,
            type: 'ENSURE_CASE',
            caseTypeId: 'case-type',
            routingIntentRef: 'route-policy',
            targetOwnerTeamId: teamId,
            next: SUCCESS_STEP_ID,
            onReject: REJECT_STEP_ID,
          },
          { id: SUCCESS_STEP_ID, type: 'EXIT', reason: 'SUCCESS' },
          { id: REJECT_STEP_ID, type: 'EXIT', reason: 'REJECTED' },
        ],
      },
      goal: { kind: 'EVENT', eventType: 'resolved' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 30,
      inputHash: 'd'.repeat(64),
      correlationId: 'corr-definition',
      publishedAt: new Date(),
    },
  });
  await owner.jrEnrollment.create({
    data: {
      id: enrollmentId,
      tenantId,
      journeyId,
      journeyVersion: 1,
      state: 'AUTHORIZED',
      runState: 'WAITING',
      currentStepId: STEP_ID,
      stepSequence: 0,
      correlationId: 'corr-enrollment',
    },
  });

  t.after(async () => {
    await owner.jrOwnerContinuation.deleteMany({ where: { tenantId } });
    await owner.jrStepRun.deleteMany({ where: { tenantId } });
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const actionInput = {
    tenantId,
    actionKey,
    enrollmentId,
    stepId: STEP_ID,
    stepSequence: 0,
    kind: 'ENSURE_CASE' as const,
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-command',
    commandId,
  };
  const resultInput = (
    resultKind: ApplyOwnerResultInput['resultKind'] = 'ACKNOWLEDGED',
  ): ApplyOwnerResultInput => ({
    tenantId,
    commandId,
    actionKey,
    resultKind,
    resultHash: resultKind === 'REJECTED' ? 'b'.repeat(64) : 'c'.repeat(64),
    correlationId: 'corr-result',
    ownerAggregateRef: 'case-1',
    ownerAggregateVersion: 1,
  });

  return {
    owner,
    application,
    tenantId,
    journeyId,
    enrollmentId,
    actionKey,
    commandId,
    actionInput,
    resultInput,
  };
}

async function dispatched(
  f: Awaited<ReturnType<typeof fixture>>,
  repository: JourneyOwnerActionRepository,
) {
  await repository.ensureAction(f.actionInput);
  await repository.markCommandDispatched(f.tenantId, f.commandId);
}

test('ACKNOWLEDGED commit result, continuation, step run และ success cursor แบบ atomic', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await dispatched(f, repository);

  const applied = await repository.applyResult(f.resultInput());
  assert.equal(applied.outcome, 'APPLIED');

  const [enrollment, continuation, runs] = await Promise.all([
    f.owner.jrEnrollment.findFirstOrThrow({ where: { tenantId: f.tenantId, id: f.enrollmentId } }),
    f.owner.jrOwnerContinuation.findFirstOrThrow({ where: { tenantId: f.tenantId } }),
    f.owner.jrStepRun.findMany({ where: { tenantId: f.tenantId, enrollmentId: f.enrollmentId } }),
  ]);
  assert.equal(enrollment.currentStepId, SUCCESS_STEP_ID);
  assert.equal(enrollment.stepSequence, 1);
  assert.equal(enrollment.runState, 'RUNNING');
  assert.equal(continuation.outcome, 'ADVANCED');
  assert.equal(continuation.nextStepId, SUCCESS_STEP_ID);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.stepId, STEP_ID);
  assert.equal(runs[0]?.nextStepId, SUCCESS_STEP_ID);
});

test('REJECTED เลือก onReject และ duplicate/concurrent replay ไม่ advance ซ้ำ', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await dispatched(f, repository);
  const input = f.resultInput('REJECTED');

  const outcomes = await Promise.all([
    repository.applyResult(input),
    repository.applyResult(input),
  ]);
  assert.deepEqual(outcomes.map(({ outcome }) => outcome).sort(), ['APPLIED', 'DUPLICATE']);
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId, id: f.enrollmentId },
  });
  assert.equal(enrollment.currentStepId, REJECT_STEP_ID);
  assert.equal(enrollment.stepSequence, 1);
  assert.equal(await f.owner.jrOwnerContinuation.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.jrStepRun.count({ where: { tenantId: f.tenantId } }), 1);
});

test('terminal enrollment ชนะผล success และบันทึก TERMINAL_IGNORED โดยไม่เดิน cursor', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await dispatched(f, repository);
  await f.owner.jrEnrollment.update({
    where: { id: f.enrollmentId },
    data: { runState: 'TERMINAL', terminalReason: 'CANCELLED', terminalAt: new Date() },
  });

  await repository.applyResult(f.resultInput());
  const continuation = await f.owner.jrOwnerContinuation.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { id: f.enrollmentId },
  });
  assert.equal(continuation.outcome, 'TERMINAL_IGNORED');
  assert.equal(continuation.nextStepId, null);
  assert.equal(enrollment.currentStepId, STEP_ID);
  assert.equal(enrollment.stepSequence, 0);
  assert.equal(await f.owner.jrStepRun.count({ where: { tenantId: f.tenantId } }), 0);
});

test('TOO_LATE ไม่ถูกตีความเป็น success และบันทึก TERMINAL_IGNORED', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await dispatched(f, repository);
  const input = { ...f.resultInput(), resultKind: 'TOO_LATE' as const, resultHash: 'e'.repeat(64) };

  const applied = await repository.applyResult(input);
  assert.equal(applied.action.state, 'TOO_LATE');
  const continuation = await f.owner.jrOwnerContinuation.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(continuation.outcome, 'TERMINAL_IGNORED');
  assert.equal(continuation.nextStepId, null);
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({ where: { id: f.enrollmentId } });
  assert.equal(enrollment.currentStepId, STEP_ID);
  assert.equal(enrollment.stepSequence, 0);
});

test('action terminal ที่ commit ก่อน ACK ชนะและเก็บ evidence โดยไม่เดิน cursor', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await dispatched(f, repository);
  await f.owner.jrOwnerAction.update({
    where: { tenantId_actionKey: { tenantId: f.tenantId, actionKey: f.actionKey } },
    data: { state: 'CANCELLED', version: { increment: 1 } },
  });

  const applied = await repository.applyResult(f.resultInput());
  assert.equal(applied.outcome, 'TERMINAL_IGNORED');
  const continuation = await f.owner.jrOwnerContinuation.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(continuation.outcome, 'TERMINAL_IGNORED');
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({ where: { id: f.enrollmentId } });
  assert.equal(enrollment.currentStepId, STEP_ID);
  assert.equal(enrollment.stepSequence, 0);
});

for (const phase of ['RESULT_PERSISTED', 'CONTINUATION_PERSISTED', 'STEP_RECORDED'] as const) {
  test(`crash หลัง ${phase} rollback result/action/ledger/cursor ทั้ง transaction`, async (t) => {
    const f = await fixture(t);
    const setup = new JourneyOwnerActionRepository(f.application);
    await dispatched(f, setup);
    const crashing = new JourneyOwnerActionRepository(f.application, {
      checkpoint(checkpoint) {
        if (checkpoint === phase) throw new Error(`crash:${phase}`);
      },
    });

    await assert.rejects(() => crashing.applyResult(f.resultInput()), new RegExp(`crash:${phase}`));
    const action = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey: f.actionKey },
    });
    const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
      where: { id: f.enrollmentId },
    });
    assert.equal(action.state, 'DISPATCHED');
    assert.equal(enrollment.currentStepId, STEP_ID);
    assert.equal(enrollment.stepSequence, 0);
    assert.equal(await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId } }), 0);
    assert.equal(await f.owner.jrOwnerContinuation.count({ where: { tenantId: f.tenantId } }), 0);
    assert.equal(await f.owner.jrStepRun.count({ where: { tenantId: f.tenantId } }), 0);
  });
}

test('reconciler เติม continuation ให้ legacy committed result และ replayซ้ำไม่เดินอีก', async (t) => {
  const f = await fixture(t);
  const actionId = randomUUID();
  await f.owner.jrOwnerAction.create({
    data: {
      id: actionId,
      tenantId: f.tenantId,
      actionKey: f.actionKey,
      enrollmentId: f.enrollmentId,
      stepId: STEP_ID,
      stepSequence: 0,
      kind: 'ENSURE_CASE',
      requestHash: f.actionInput.requestHash,
      state: 'ACKNOWLEDGED',
      version: 2,
      correlationId: 'corr-command',
      acknowledgedAt: new Date(),
    },
  });
  await f.owner.jrOwnerCommandOutbox.create({
    data: {
      tenantId: f.tenantId,
      commandId: f.commandId,
      actionId,
      actionKey: f.actionKey,
      kind: 'ENSURE_CASE',
      requestHash: f.actionInput.requestHash,
      correlationId: 'corr-command',
      state: 'SENT',
    },
  });
  const input = f.resultInput();
  await f.owner.jrOwnerResultInbox.create({
    data: {
      tenantId: f.tenantId,
      commandId: f.commandId,
      actionKey: f.actionKey,
      resultKind: input.resultKind,
      resultHash: input.resultHash,
      outcome: 'APPLIED',
      correlationId: input.correlationId,
    },
  });

  const repository = new JourneyOwnerActionRepository(f.application);
  assert.equal(await repository.reconcileCommittedContinuations(f.tenantId), 1);
  assert.equal(await repository.reconcileCommittedContinuations(f.tenantId), 0);
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({ where: { id: f.enrollmentId } });
  assert.equal(enrollment.currentStepId, SUCCESS_STEP_ID);
  assert.equal(enrollment.stepSequence, 1);
  assert.equal(await f.owner.jrOwnerContinuation.count({ where: { tenantId: f.tenantId } }), 1);
});

test('legacy action ที่ไม่มี deterministic binding ยังรับผลได้แต่ห้ามเดา cursor', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  await repository.ensureAction({
    ...f.actionInput,
    stepId: undefined,
    stepSequence: undefined,
  });
  await repository.markCommandDispatched(f.tenantId, f.commandId);
  await repository.applyResult(f.resultInput());

  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({ where: { id: f.enrollmentId } });
  assert.equal(enrollment.currentStepId, STEP_ID);
  assert.equal(enrollment.stepSequence, 0);
  assert.equal(await f.owner.jrOwnerContinuation.count({ where: { tenantId: f.tenantId } }), 0);
});
