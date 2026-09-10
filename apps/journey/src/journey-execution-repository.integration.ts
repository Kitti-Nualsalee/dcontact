import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import type { CreateJourneyVersionInput } from './journey-definition.js';
import { JourneyExecutionRepository } from './journey-execution-repository.js';
import {
  JourneyDefinitionNotPublishedError,
  JourneySubmissionBarrierError,
  type JourneyActionPort,
  type JourneyActionResult,
} from './journey-execution.js';

const evaluator = new DcExprEvaluator();

function fakeActionPort(result: JourneyActionResult = { status: 'SUBMITTED' }) {
  const calls: string[] = [];
  const port: JourneyActionPort = {
    async send(command) {
      calls.push(command.actionKey);
      return result;
    },
  };
  return { port, calls };
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
  const rawTenantId = randomUUID();
  const rawTeamId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  t.after(async () => {
    await owner.jrExecutionStep.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrExecution.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `Journey executions ${suffix}`,
      slug: `jr-exec-${suffix}`,
      sipDomain: `${suffix}.jr-exec.test`,
    },
  });
  await owner.team.create({ data: { id: rawTeamId, tenantId: rawTenantId, name: 'Collections' } });

  return { owner, application, tenantId: rawTenantId, teamId: rawTeamId };
}

function definitionInput(
  f: Awaited<ReturnType<typeof fixture>>,
  journeyId: string,
  overrides: Partial<CreateJourneyVersionInput> = {},
): CreateJourneyVersionInput {
  return {
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    name: 'ทวงหนี้ค้างชำระ',
    ownerTeamId: f.teamId,
    trigger: { kind: 'EVENT', eventType: 'payment.failed' },
    graph: {
      entryStepId: 'send-line',
      steps: [
        {
          id: 'send-line',
          type: 'SEND',
          channel: 'LINE',
          contentRef: 'tmpl-1',
          next: 'branch-paid',
        },
        {
          id: 'branch-paid',
          type: 'BRANCH',
          expression: {
            language: 'DC_EXPR',
            version: 1,
            expression: { type: 'isNull', operand: { type: 'ref', path: ['vars', 'paidAt'] } },
          },
          whenTrue: 'wait-a-day',
          whenFalse: 'exit-goal',
        },
        { id: 'wait-a-day', type: 'WAIT', waitSeconds: 1, next: 'send-reminder' },
        {
          id: 'send-reminder',
          type: 'SEND',
          channel: 'WEBCHAT',
          contentRef: 'tmpl-2',
          next: 'exit-timeout',
        },
        { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        { id: 'exit-timeout', type: 'EXIT', reason: 'MAX_AGE_REACHED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
    exitRules: [{ kind: 'GOAL' }, { kind: 'EVENT', eventType: 'customer.replied' }],
    maxDurationDays: 7,
    correlationId: 'correlation-c1-5-definition',
    ...overrides,
  };
}

async function publishedJourney(f: Awaited<ReturnType<typeof fixture>>, journeyId: string) {
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await definitions.createVersion(definitionInput(f, journeyId));
  await definitions.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'publish-c1-5',
  });
  return journeyId;
}

test('enroll สร้าง execution ที่ entryStepId และคืนค่าเดิมเมื่อ enrollmentKey เดิม', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);

  const snapshots = await Promise.all(
    Array.from({ length: 5 }, () =>
      repository.enroll({
        tenantId: f.tenantId,
        journeyId,
        journeyVersion: 1,
        enrollmentKey: 'event-inbox-1',
        correlationId: 'correlation-enroll',
      }),
    ),
  );
  for (const snapshot of snapshots) assert.deepEqual(snapshot, snapshots[0]);
  assert.equal(snapshots[0]?.currentStepId, 'send-line');
  assert.equal(snapshots[0]?.status, 'ACTIVE');
  assert.equal(await f.owner.jrExecution.count({ where: { tenantId: f.tenantId, journeyId } }), 1);
});

test('enroll ด้วย enrollmentKey แบบ SCHEDULE occurrence ก็ dedupe เหมือน EVENT', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const scheduleKey = 'schedule:2026-09-10T09:00:00.000Z';

  await Promise.all(
    Array.from({ length: 4 }, () =>
      repository.enroll({
        tenantId: f.tenantId,
        journeyId,
        journeyVersion: 1,
        enrollmentKey: scheduleKey,
        correlationId: 'correlation-schedule-tick',
      }),
    ),
  );
  assert.equal(
    await f.owner.jrExecution.count({
      where: { tenantId: f.tenantId, journeyId, enrollmentKey: scheduleKey },
    }),
    1,
  );
});

test('enroll ต่อ journey ที่ยังไม่ publish ถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const definitions = new JourneyDefinitionRepository(f.application, evaluator);
  await definitions.createVersion(definitionInput(f, journeyId));
  const repository = new JourneyExecutionRepository(f.application, evaluator);

  await assert.rejects(
    () =>
      repository.enroll({
        tenantId: f.tenantId,
        journeyId,
        journeyVersion: 1,
        enrollmentKey: 'event-inbox-1',
        correlationId: 'correlation-enroll',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyDefinitionNotPublishedError);
      return true;
    },
  );
});

test('advance เดินผ่าน BRANCH จนถึง SEND แรกในการเรียกเดียว', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });

  const advanced = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'correlation-advance-1',
  });
  assert.equal(advanced.status, 'SUBMITTING');
  assert.equal(advanced.currentStepId, 'send-line');
  assert.ok(advanced.pendingActionKey?.endsWith(':1:send-line'));
});

test('submit สำเร็จเดินต่อจนถึง WAIT และ retry ซ้ำไม่เรียก port ซ้ำ', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'correlation-advance-1',
  });

  const { port, calls } = fakeActionPort();
  const submitted = await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'correlation-submit' },
    port,
  );
  assert.equal(submitted.status, 'ACTIVE');
  assert.equal(submitted.currentStepId, 'branch-paid');

  const advancedToWait = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'correlation-advance-2',
  });
  assert.equal(advancedToWait.status, 'WAITING');
  assert.ok(advancedToWait.waitUntil);

  const retried = await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'correlation-submit-retry' },
    port,
  );
  assert.deepEqual(retried, advancedToWait);
  assert.equal(calls.length, 1);
});

test('WAIT ที่ยังไม่ถึงเวลาไม่ถูกเดินซ้ำ และ due แล้วเดินต่อไปหา SEND ถัดไป', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c1',
  });
  await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'c2' },
    fakeActionPort().port,
  );
  const waiting = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'c3',
  });
  assert.equal(waiting.status, 'WAITING');

  const stillWaiting = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'c4-too-early',
  });
  assert.deepEqual(stillWaiting, waiting);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const due = await repository.findDueWaiting(f.tenantId);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.id, enrolled.id);

  const resumed = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c5-resume',
  });
  assert.equal(resumed.status, 'SUBMITTING');
  assert.equal(resumed.currentStepId, 'send-reminder');
});

test('เรียก advance พร้อมกันหลายครั้งบน execution เดียวไม่ทำให้เดินซ้ำ', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      repository.advance({
        tenantId: f.tenantId,
        executionId: enrolled.id,
        context: {},
        correlationId: `correlation-race-${index}`,
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result.status, 'SUBMITTING');
    assert.equal(result.currentStepId, 'send-line');
    assert.equal(result.stepVersion, 1);
  }
  assert.equal(
    await f.owner.jrExecutionStep.count({
      where: { tenantId: f.tenantId, executionId: enrolled.id },
    }),
    1,
  );
});

test('cancel ระหว่าง WAITING ชนะก่อน SEND ถัดไปโดยไม่เรียก port', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c1',
  });
  const { port, calls } = fakeActionPort();
  await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'c2' },
    port,
  );
  const waiting = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'c3',
  });
  assert.equal(waiting.status, 'WAITING');

  const cancelled = await repository.cancel({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    reason: 'ลูกค้าขอยกเลิก',
    correlationId: 'c4-cancel',
  });
  assert.equal(cancelled.status, 'WAITING');
  assert.ok(cancelled.cancelledAt);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const terminal = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c5-resume',
  });
  assert.equal(terminal.status, 'CANCELLED');
  assert.equal(terminal.terminalReason, 'CANCELLED');
  assert.equal(calls.length, 1, 'send-reminder step ต้องไม่ถูกส่ง');
});

test('cancel หลัง submission barrier (SUBMITTING) ถูกปฏิเสธ ต้อง reconcile แทน', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  const submitting = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c1',
  });
  assert.equal(submitting.status, 'SUBMITTING');

  await assert.rejects(
    () =>
      repository.cancel({
        tenantId: f.tenantId,
        executionId: enrolled.id,
        reason: 'สายเกินไป',
        correlationId: 'c2-cancel',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneySubmissionBarrierError);
      return true;
    },
  );
});

test('recordGoalReached ทำให้ advance ถัดไปจบแบบ GOAL_REACHED แทนการส่งซ้ำ', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c1',
  });
  const { port, calls } = fakeActionPort();
  await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'c2' },
    port,
  );

  await repository.recordGoalReached({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    correlationId: 'c3-goal',
  });
  const terminal = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'c4',
  });
  assert.equal(terminal.status, 'EXITED');
  assert.equal(terminal.terminalReason, 'GOAL_REACHED');
  assert.equal(calls.length, 1);
});

test('recordExitEvent ที่ตรง exitRules ทำให้ advance ถัดไปจบแบบ EXIT_RULE', async (t) => {
  const f = await fixture(t);
  const journeyId = await publishedJourney(f, randomUUID());
  const repository = new JourneyExecutionRepository(f.application, evaluator);
  const enrolled = await repository.enroll({
    tenantId: f.tenantId,
    journeyId,
    journeyVersion: 1,
    enrollmentKey: 'event-inbox-1',
    correlationId: 'correlation-enroll',
  });
  await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: {},
    correlationId: 'c1',
  });
  await repository.submit(
    { tenantId: f.tenantId, executionId: enrolled.id, correlationId: 'c2' },
    fakeActionPort().port,
  );

  await repository.recordExitEvent({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    eventType: 'customer.replied',
    correlationId: 'c3-exit',
  });
  const terminal = await repository.advance({
    tenantId: f.tenantId,
    executionId: enrolled.id,
    context: { vars: {} },
    correlationId: 'c4',
  });
  assert.equal(terminal.status, 'EXITED');
  assert.equal(terminal.terminalReason, 'EXIT_RULE');
});

test('journeyId เดียวกันแยก tenant ได้อิสระต่อกัน', async (t) => {
  const tenantA = await fixture(t);
  const tenantB = await fixture(t);
  const journeyId = randomUUID();
  await publishedJourney(tenantA, journeyId);
  await publishedJourney(tenantB, journeyId);
  const repositoryA = new JourneyExecutionRepository(tenantA.application, evaluator);
  const repositoryB = new JourneyExecutionRepository(tenantB.application, evaluator);

  const [enrolledA, enrolledB] = await Promise.all([
    repositoryA.enroll({
      tenantId: tenantA.tenantId,
      journeyId,
      journeyVersion: 1,
      enrollmentKey: 'event-inbox-1',
      correlationId: 'c1',
    }),
    repositoryB.enroll({
      tenantId: tenantB.tenantId,
      journeyId,
      journeyVersion: 1,
      enrollmentKey: 'event-inbox-1',
      correlationId: 'c1',
    }),
  ]);
  assert.notEqual(enrolledA.id, enrolledB.id);

  await assert.rejects(() =>
    repositoryA.advance({
      tenantId: tenantA.tenantId,
      executionId: enrolledB.id,
      context: {},
      correlationId: 'x',
    }),
  );
});
