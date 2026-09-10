/**
 * C1.5 acceptance: durable execution ของ J1 บน Postgres จริง
 *
 * ทุกเคสยืนยันสัญญาเดียวกัน — node หนึ่งตัวรันได้ครั้งเดียว, terminal แรกชนะ และ
 * restart/worker ซ้อนกันต้องไม่ทำให้ enrollment ข้ามหรือย้อน
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import type { ExpressionDocument } from '@d-contact/cxa-contracts';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneyExecutionService, JourneyStepRaceError } from './journey-execution.js';
import type { JourneyGraph } from './journey-definition.js';

const OPT_IN: ExpressionDocument = {
  language: 'DC_EXPR',
  version: 1,
  expression: {
    type: 'comparison',
    operator: 'eq',
    left: { type: 'ref', path: ['vars', 'optIn'] },
    right: { type: 'literal', value: true },
  },
};

const BROKEN: ExpressionDocument = {
  language: 'DC_EXPR',
  version: 1,
  expression: { type: 'ref', path: ['vars', 'missing'] },
};

function graph(expression: ExpressionDocument): JourneyGraph {
  return {
    entryStepId: 'branch-1',
    steps: [
      {
        id: 'branch-1',
        type: 'BRANCH',
        expression,
        whenTrue: 'send-1',
        whenFalse: 'exit-declined',
      },
      { id: 'send-1', type: 'SEND', channel: 'EMAIL', contentRef: 'template:a', next: 'wait-1' },
      { id: 'wait-1', type: 'WAIT', waitSeconds: 600, next: 'exit-done' },
      { id: 'exit-done', type: 'EXIT', reason: 'DONE' },
      { id: 'exit-declined', type: 'EXIT', reason: 'DECLINED' },
    ],
  };
}

async function fixture(t: TestContext, expression: ExpressionDocument = OPT_IN) {
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
  const rawTenantId = randomUUID();
  const otherTenantId = randomUUID();
  const journeyId = randomUUID();
  const ownerTeamIds = new Map<string, string>();
  const suffix = rawTenantId.slice(0, 8);
  let currentTime = new Date('2026-09-10T09:00:00.000Z');

  t.after(async () => {
    for (const scope of [rawTenantId, otherTenantId]) {
      await owner.jrStepRun.deleteMany({ where: { tenantId: scope } });
      await owner.jrEnrollment.deleteMany({ where: { tenantId: scope } });
      await owner.jrScheduleOccurrence.deleteMany({ where: { tenantId: scope } });
      await owner.jrEventInbox.deleteMany({ where: { tenantId: scope } });
      await owner.team.deleteMany({ where: { tenantId: scope } });
      await owner.jrJourneyDefinition.deleteMany({ where: { tenantId: scope } });
      await owner.tenant.deleteMany({ where: { id: scope } });
    }
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  for (const [index, scope] of [rawTenantId, otherTenantId].entries()) {
    await owner.tenant.create({
      data: {
        id: scope,
        name: `Journey exec ${suffix}-${index}`,
        slug: `journey-exec-${suffix}-${index}`,
        sipDomain: `${suffix}-${index}.journey-exec.test`,
      },
    });
    // publish ตรวจว่า ownerTeamId เป็นทีมจริงของ tenant นั้น ไม่ใช่ uuid ลอย ๆ
    const teamId = randomUUID();
    ownerTeamIds.set(scope, teamId);
    await owner.team.create({
      data: { id: teamId, tenantId: scope, name: `Journey owners ${suffix}` },
    });
  }

  const evaluator = new DcExprEvaluator();
  const definitions = new JourneyDefinitionRepository(application, evaluator);

  async function publish(tenantId: string) {
    const created = await definitions.createVersion({
      tenantId,
      journeyId,
      version: 1,
      name: `Journey ${suffix}`,
      ownerTeamId: ownerTeamIds.get(tenantId) ?? '',
      purpose: 'MARKETING',
      senderIdentityId: `sender-${suffix}`,
      trigger: { kind: 'EVENT', eventType: 'order.created' },
      graph: graph(expression),
      goal: { kind: 'EVENT', eventType: 'order.paid' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 30,
      correlationId: `corr-${suffix}`,
    });
    await definitions.publishVersion({
      tenantId,
      journeyId,
      version: 1,
      expectedContentHash: created.contentHash,
      correlationId: `corr-${suffix}`,
    });
  }
  await publish(rawTenantId);
  await publish(otherTenantId);

  const execution = new JourneyExecutionService(application, definitions, evaluator, {
    now: () => currentTime,
    claimSeconds: 60,
  });

  async function acceptEvent(tenantId = rawTenantId) {
    const receiptId = randomUUID();
    await owner.jrEventInbox.create({
      data: {
        id: receiptId,
        tenantId,
        source: 'crm',
        eventId: `event-${receiptId.slice(0, 8)}`,
        eventType: 'order.created',
        occurredAt: currentTime,
        payload: { type: 'order.created' },
        payloadHash: `hash-${receiptId.slice(0, 8)}`,
        state: 'PUBLISHED',
      },
    });
    return receiptId;
  }

  return {
    owner,
    application,
    execution,
    journeyId,
    tenantId: rawTenantId,
    otherTenantId,
    acceptEvent,
    advanceClock(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
    stepRuns(enrollmentId: string) {
      return owner.jrStepRun.findMany({
        where: { tenantId: rawTenantId, enrollmentId },
        orderBy: { stepSequence: 'asc' },
      });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function enrolled(context: Fixture) {
  const receiptId = await context.acceptEvent();
  return context.execution.enrollFromEvent(context.tenantId, {
    receiptId,
    journeyId: context.journeyId,
    journeyVersion: 1,
    correlationId: 'corr-enroll',
  });
}

const OPT_IN_CONTEXT = { correlationId: 'corr-advance', context: { vars: { optIn: true } } };

test('event ingress enrolls once per receipt', async (t) => {
  const context = await fixture(t);
  const receiptId = await context.acceptEvent();
  const first = await context.execution.enrollFromEvent(context.tenantId, {
    receiptId,
    journeyId: context.journeyId,
    journeyVersion: 1,
    correlationId: 'corr-enroll',
  });
  const second = await context.execution.enrollFromEvent(context.tenantId, {
    receiptId,
    journeyId: context.journeyId,
    journeyVersion: 1,
    correlationId: 'corr-enroll-retry',
  });

  assert.equal(second.enrollmentId, first.enrollmentId);
  assert.equal(first.currentStepId, 'branch-1');
  assert.equal(first.runState, 'RUNNING');
  assert.equal(
    await context.owner.jrEnrollment.count({ where: { tenantId: context.tenantId } }),
    1,
  );
});

test('schedule occurrence dedupes per tenant and enrolls once', async (t) => {
  const context = await fixture(t);
  const occurrenceAt = '2026-09-10T09:00:00.000Z';
  const first = await context.execution.enrollFromSchedule(context.tenantId, {
    journeyId: context.journeyId,
    journeyVersion: 1,
    occurrenceAt,
    correlationId: 'corr-schedule',
  });
  const replay = await context.execution.enrollFromSchedule(context.tenantId, {
    journeyId: context.journeyId,
    journeyVersion: 1,
    occurrenceAt,
    correlationId: 'corr-schedule-retry',
  });
  assert.equal(replay.enrollmentId, first.enrollmentId);

  // occurrence เดียวกันของอีก tenant เป็นคนละใบ ไม่ถูก dedupe ข้าม tenant
  const other = await context.execution.enrollFromSchedule(context.otherTenantId, {
    journeyId: context.journeyId,
    journeyVersion: 1,
    occurrenceAt,
    correlationId: 'corr-schedule-other',
  });
  assert.notEqual(other.enrollmentId, first.enrollmentId);
  assert.equal(
    await context.owner.jrScheduleOccurrence.count({ where: { tenantId: context.tenantId } }),
    1,
  );
});

test('concurrent schedule firings still produce exactly one enrollment', async (t) => {
  const context = await fixture(t);
  const occurrenceAt = '2026-09-10T10:00:00.000Z';
  const results = await Promise.all(
    Array.from({ length: 5 }, (_unused, index) =>
      context.execution.enrollFromSchedule(context.tenantId, {
        journeyId: context.journeyId,
        journeyVersion: 1,
        occurrenceAt,
        correlationId: `corr-race-${index}`,
      }),
    ),
  );
  const unique = new Set(results.map((result) => result.enrollmentId));
  assert.equal(unique.size, 1);
  assert.equal(
    await context.owner.jrEnrollment.count({ where: { tenantId: context.tenantId } }),
    1,
  );
});

test('BRANCH picks a path and records the decision in the ledger', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  const outcome = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );

  assert.equal(outcome.kind, 'ADVANCED');
  assert.equal(outcome.kind === 'ADVANCED' && outcome.nextStepId, 'send-1');
  const runs = await context.stepRuns(enrollment.enrollmentId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.branchResult, true);
  assert.equal(runs[0]?.stepSequence, 1);
});

test('a BRANCH that cannot be evaluated fails closed to the false path', async (t) => {
  const context = await fixture(t, BROKEN);
  const enrollment = await enrolled(context);
  const outcome = await context.execution.advance(context.tenantId, enrollment.enrollmentId, {
    correlationId: 'corr-advance',
  });

  assert.equal(outcome.kind === 'ADVANCED' && outcome.nextStepId, 'exit-declined');
  const runs = await context.stepRuns(enrollment.enrollmentId);
  assert.equal(runs[0]?.branchResult, false);
});

test('SEND parks the enrollment for C1.6 without touching Governance', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);
  const parked = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );

  assert.equal(parked.kind, 'AWAITING_SEND');
  assert.equal(
    await context.owner.cgReservation.count({ where: { tenantId: context.tenantId } }),
    0,
  );
  assert.equal(await context.owner.jrAction.count({ where: { tenantId: context.tenantId } }), 0);
});

test('advancing a parked SEND replays the hand-off instead of running the node twice', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);

  const runs = await context.stepRuns(enrollment.enrollmentId);
  assert.deepEqual(
    runs.map((run) => [run.stepId, run.state]),
    [
      ['branch-1', 'COMPLETED'],
      ['send-1', 'AWAITING_SEND'],
    ],
  );
});

test('WAIT parks until due and claimDueWork ignores work that is not due yet', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);
  await context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT);
  await context.execution.completeSend(context.tenantId, enrollment.enrollmentId, {
    correlationId: 'corr-send-done',
  });
  const waiting = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );

  assert.equal(waiting.kind, 'WAITING');
  assert.equal(waiting.kind === 'WAITING' && waiting.wakeAt, '2026-09-10T09:10:00.000Z');
  assert.deepEqual(
    await context.execution.claimDueWork(context.tenantId, { workerId: 'worker-1' }),
    [],
  );

  const early = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );
  assert.equal(early.kind, 'NOT_DUE');

  context.advanceClock(11 * 60_000);
  assert.deepEqual(
    await context.execution.claimDueWork(context.tenantId, { workerId: 'worker-1' }),
    [enrollment.enrollmentId],
  );
  const resumed = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );
  assert.equal(resumed.kind, 'TERMINAL');
  assert.equal(resumed.kind === 'TERMINAL' && resumed.reason, 'GRAPH_EXIT');
});

test('a claimed enrollment is invisible to another worker until the lease expires', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  assert.deepEqual(
    await context.execution.claimDueWork(context.tenantId, { workerId: 'worker-1' }),
    [enrollment.enrollmentId],
  );
  assert.deepEqual(
    await context.execution.claimDueWork(context.tenantId, { workerId: 'worker-2' }),
    [],
  );

  context.advanceClock(61_000);
  assert.deepEqual(
    await context.execution.claimDueWork(context.tenantId, { workerId: 'worker-2' }),
    [enrollment.enrollmentId],
  );
});

test('two workers advancing the same enrollment run the node exactly once', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  const results = await Promise.allSettled([
    context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT),
    context.execution.advance(context.tenantId, enrollment.enrollmentId, OPT_IN_CONTEXT),
  ]);

  const advanced = results.filter(
    (result) => result.status === 'fulfilled' && result.value.kind === 'ADVANCED',
  );
  assert.equal(advanced.length, 1, 'มีเพียง worker เดียวที่เดิน node ได้');
  const runs = await context.stepRuns(enrollment.enrollmentId);
  assert.equal(runs.filter((run) => run.stepId === 'branch-1').length, 1);
});

test('cancellation beats work that has not been handed off yet', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  const cancelled = await context.execution.cancel(context.tenantId, enrollment.enrollmentId);
  assert.equal(cancelled.runState, 'TERMINAL');
  assert.equal(cancelled.terminalReason, 'CANCELLED');

  const outcome = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );
  assert.equal(outcome.kind, 'TERMINAL');
  assert.equal(outcome.kind === 'TERMINAL' && outcome.reason, 'CANCELLED');
  assert.equal((await context.stepRuns(enrollment.enrollmentId)).length, 0);
});

test('the first terminal reason wins over every later one', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  await context.execution.cancel(context.tenantId, enrollment.enrollmentId);
  const goal = await context.execution.reachGoal(context.tenantId, enrollment.enrollmentId);
  const exit = await context.execution.applyExitRule(context.tenantId, enrollment.enrollmentId);

  assert.equal(goal.terminalReason, 'CANCELLED');
  assert.equal(exit.terminalReason, 'CANCELLED');
  assert.equal(goal.terminalAt, exit.terminalAt);
});

test('goal and exit rules record their own terminal reason', async (t) => {
  const context = await fixture(t);
  const goalEnrollment = await enrolled(context);
  const exitEnrollment = await enrolled(context);

  assert.equal(
    (await context.execution.reachGoal(context.tenantId, goalEnrollment.enrollmentId))
      .terminalReason,
    'GOAL_REACHED',
  );
  assert.equal(
    (await context.execution.applyExitRule(context.tenantId, exitEnrollment.enrollmentId))
      .terminalReason,
    'EXIT_RULE',
  );
});

test('max age closes enrollments and beats any pending step', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  context.advanceClock(31 * 24 * 60 * 60_000);

  const swept = await context.execution.sweepMaxAge(context.tenantId);
  assert.equal(swept.length, 1);
  assert.equal(swept[0]?.terminalReason, 'MAX_AGE');

  const outcome = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );
  assert.equal(outcome.kind === 'TERMINAL' && outcome.reason, 'MAX_AGE');
  assert.equal((await context.stepRuns(enrollment.enrollmentId)).length, 0);
});

test('an enrollment past max age terminates on advance even without a sweeper', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  context.advanceClock(31 * 24 * 60 * 60_000);

  const outcome = await context.execution.advance(
    context.tenantId,
    enrollment.enrollmentId,
    OPT_IN_CONTEXT,
  );
  assert.equal(outcome.kind === 'TERMINAL' && outcome.reason, 'MAX_AGE');
});

test('completeSend refuses an enrollment that is not parked on a SEND', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  await assert.rejects(
    () =>
      context.execution.completeSend(context.tenantId, enrollment.enrollmentId, {
        correlationId: 'corr-send-done',
      }),
    JourneyStepRaceError,
  );
});

test('enrollment evidence carries no event payload or contact data', async (t) => {
  const context = await fixture(t);
  const enrollment = await enrolled(context);
  const evidence = await context.execution.describe(context.tenantId, enrollment.enrollmentId);
  const serialized = JSON.stringify(evidence);

  assert.deepEqual(Object.keys(evidence).sort(), [
    'currentStepId',
    'enrollmentId',
    'journeyId',
    'journeyVersion',
    'maxAgeAt',
    'runState',
    'stepSequence',
  ]);
  assert.equal(serialized.includes('order.created'), false);
});
