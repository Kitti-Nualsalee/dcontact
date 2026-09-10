import assert from 'node:assert/strict';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import type { JourneyVersionSnapshot } from './journey-definition.js';
import { walkExecution } from './journey-execution-walker.js';

const evaluator = new DcExprEvaluator();

function definition(overrides: Partial<JourneyVersionSnapshot> = {}): JourneyVersionSnapshot {
  return {
    tenantId: 'tenant-1',
    journeyId: 'journey-1',
    version: 1,
    name: 'ทวงหนี้ค้างชำระ',
    ownerTeamId: 'team-1',
    status: 'PUBLISHED',
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
        { id: 'wait-a-day', type: 'WAIT', waitSeconds: 86400, next: 'exit-timeout' },
        { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        { id: 'exit-timeout', type: 'EXIT', reason: 'MAX_AGE_REACHED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
    exitRules: [{ kind: 'GOAL' }, { kind: 'EVENT', eventType: 'customer.replied' }],
    maxDurationDays: 7,
    contentHash: 'hash-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const enrolledAt = new Date('2026-09-01T00:00:00.000Z');
const now = new Date('2026-09-01T00:00:01.000Z');

test('เริ่มที่ SEND คืน outcome SUBMIT ของ step นั้น', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now,
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, {
    kind: 'SUBMIT',
    stepId: 'send-line',
    step: definition().graph.steps[0],
  });
});

test('BRANCH ประเมินตาม context และเดินต่อในหนึ่ง walk เดียวจนถึง WAIT', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'branch-paid',
    context: { vars: {} },
    evaluator,
    now,
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, {
    kind: 'WAIT',
    loggedStepId: 'wait-a-day',
    resumeStepId: 'exit-timeout',
    waitSeconds: 86400,
  });
});

test('BRANCH ที่ context บอกว่าจ่ายแล้วเดินไป exit-goal (terminal JOURNEY_EXIT)', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'branch-paid',
    context: { vars: { paidAt: '2026-09-01T00:00:00.000Z' } },
    evaluator,
    now,
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, { kind: 'TERMINAL', reason: 'JOURNEY_EXIT', stepId: 'exit-goal' });
});

test('ลำดับความสำคัญ: cancelled ชนะทุกสัญญาณแม้ goal/exit/max-age มาด้วยกัน', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now: new Date('2026-09-30T00:00:00.000Z'),
    enrolledAt,
    signals: {
      cancelledAt: new Date('2026-09-01T00:00:00.500Z'),
      goalReachedAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventType: 'customer.replied',
    },
  });
  assert.deepEqual(outcome, { kind: 'TERMINAL', reason: 'CANCELLED', stepId: 'send-line' });
});

test('goal reached ชนะ exit rule และ max-age เมื่อไม่มี cancel', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now: new Date('2026-09-30T00:00:00.000Z'),
    enrolledAt,
    signals: {
      goalReachedAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventType: 'customer.replied',
    },
  });
  assert.deepEqual(outcome, { kind: 'TERMINAL', reason: 'GOAL_REACHED', stepId: 'send-line' });
});

test('exit event ที่ตรงกับ exitRules ชนะ max-age', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now: new Date('2026-09-30T00:00:00.000Z'),
    enrolledAt,
    signals: {
      exitEventAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventType: 'customer.replied',
    },
  });
  assert.deepEqual(outcome, { kind: 'TERMINAL', reason: 'EXIT_RULE', stepId: 'send-line' });
});

test('exit event ที่ eventType ไม่ตรง exitRules ไม่ทำให้ terminal', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now,
    enrolledAt,
    signals: {
      exitEventAt: new Date('2026-09-01T00:00:00.500Z'),
      exitEventType: 'ไม่ตรง.eventType',
    },
  });
  assert.deepEqual(outcome, {
    kind: 'SUBMIT',
    stepId: 'send-line',
    step: definition().graph.steps[0],
  });
});

test('now เกิน enrolledAt + maxDurationDays เป็น MAX_AGE_EXCEEDED', () => {
  const outcome = walkExecution({
    definition: definition({ maxDurationDays: 1 }),
    startStepId: 'send-line',
    context: {},
    evaluator,
    now: new Date('2026-09-03T00:00:00.000Z'),
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, { kind: 'TERMINAL', reason: 'MAX_AGE_EXCEEDED', stepId: 'send-line' });
});

test('step id ที่ไม่มีใน graph คืน FAILED แบบ STEP_NOT_FOUND', () => {
  const outcome = walkExecution({
    definition: definition(),
    startStepId: 'ไม่มีจริง',
    context: {},
    evaluator,
    now,
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, { kind: 'FAILED', reasonCode: 'STEP_NOT_FOUND' });
});

test('BRANCH loop ที่ไม่จบใน MAX_HOPS คืน FAILED แบบ HOP_LIMIT_EXCEEDED', () => {
  const loopingDefinition = definition({
    graph: {
      entryStepId: 'flip',
      steps: [
        {
          id: 'flip',
          type: 'BRANCH',
          expression: {
            language: 'DC_EXPR',
            version: 1,
            expression: { type: 'literal', value: true },
          },
          whenTrue: 'flip-back',
          whenFalse: 'flip-back',
        },
        {
          id: 'flip-back',
          type: 'BRANCH',
          expression: {
            language: 'DC_EXPR',
            version: 1,
            expression: { type: 'literal', value: true },
          },
          whenTrue: 'flip',
          whenFalse: 'flip',
        },
      ],
    },
  });
  const outcome = walkExecution({
    definition: loopingDefinition,
    startStepId: 'flip',
    context: {},
    evaluator,
    now,
    enrolledAt,
    signals: {},
  });
  assert.deepEqual(outcome, { kind: 'FAILED', reasonCode: 'HOP_LIMIT_EXCEEDED' });
});
