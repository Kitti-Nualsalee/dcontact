import assert from 'node:assert/strict';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import type { JourneyDefinitionContent } from './journey-definition.js';
import { validateJourneyDefinitionStructure } from './journey-definition-validator.js';

const evaluator = new DcExprEvaluator();

function validDefinition(
  overrides: Partial<JourneyDefinitionContent> = {},
): JourneyDefinitionContent {
  return {
    name: 'ทวงหนี้ค้างชำระ',
    ownerTeamId: 'team-1',
    purpose: 'MARKETING',
    senderIdentityId: 'sender-1',
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
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    ...overrides,
  };
}

test('definition ที่ครบตามสัญญาไม่มี validation code', () => {
  const codes = validateJourneyDefinitionStructure(validDefinition(), evaluator);
  assert.deepEqual(codes, []);
});

test('trigger ที่ไม่รู้จัก kind หรือขาด field ถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({ trigger: { kind: 'EVENT', eventType: '' } }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('goal ที่ไม่ใช่ EVENT หรือขาด eventType ถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({ goal: { kind: 'EVENT', eventType: '   ' } }),
    evaluator,
  );
  assert.deepEqual(codes, ['GOAL_INVALID']);
});

test('purpose หรือ senderIdentityId ว่างเปล่าถูกปฏิเสธเป็น DELIVERY_DEFAULTS_INVALID', () => {
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ purpose: '' }), evaluator),
    ['DELIVERY_DEFAULTS_INVALID'],
  );
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ senderIdentityId: '  ' }), evaluator),
    ['DELIVERY_DEFAULTS_INVALID'],
  );
});

test('exitRules ว่างเปล่าถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(validDefinition({ exitRules: [] }), evaluator);
  assert.deepEqual(codes, ['EXIT_RULE_INVALID']);
});

test('maxDurationDays ที่ไม่เป็นบวกหรือเกินเพดานถูกปฏิเสธ', () => {
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ maxDurationDays: 0 }), evaluator),
    ['MAX_DURATION_INVALID'],
  );
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ maxDurationDays: 999999 }), evaluator),
    ['MAX_DURATION_INVALID'],
  );
});

test('entryStepId ที่ไม่มีใน steps ถูกปฏิเสธเป็น GRAPH_ENTRY_MISSING', () => {
  const definition = validDefinition();
  const codes = validateJourneyDefinitionStructure(
    { ...definition, graph: { ...definition.graph, entryStepId: 'ไม่มีจริง' } },
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_ENTRY_MISSING']);
});

test('step id ซ้ำถูกปฏิเสธเป็น GRAPH_STEP_ID_DUPLICATE', () => {
  const definition = validDefinition();
  const codes = validateJourneyDefinitionStructure(
    {
      ...definition,
      graph: {
        ...definition.graph,
        steps: [...definition.graph.steps, { id: 'exit-goal', type: 'EXIT', reason: 'DUP' }],
      },
    },
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_ID_DUPLICATE']);
});

test('step ที่อ้าง next ไปยัง id ที่ไม่มีถูกปฏิเสธเป็น GRAPH_STEP_REFERENCE_MISSING', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'send-line',
        steps: [
          {
            id: 'send-line',
            type: 'SEND',
            channel: 'LINE',
            contentRef: 'tmpl-1',
            next: 'ไม่มีจริง',
          },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_REFERENCE_MISSING']);
});

test('step ที่ entry เข้าไม่ถึงถูกปฏิเสธเป็น GRAPH_STEP_UNREACHABLE', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'exit-goal',
        steps: [
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-orphan', type: 'EXIT', reason: 'ORPHAN' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_UNREACHABLE']);
});

test('graph ที่ไม่มี terminal ที่ entry ไปถึงได้ถูกปฏิเสธเป็น GRAPH_NO_TERMINAL_REACHABLE', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'wait-loop',
        steps: [{ id: 'wait-loop', type: 'WAIT', waitSeconds: 60, next: 'wait-loop' }],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_NO_TERMINAL_REACHABLE']);
});

test('SEND step ที่ขาด contentRef ถูกปฏิเสธเป็น GRAPH_STEP_SHAPE_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'send-line',
        steps: [
          { id: 'send-line', type: 'SEND', channel: 'LINE', contentRef: '', next: 'exit-goal' },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_SHAPE_INVALID']);
});

test('BRANCH ที่ใช้ DC_EXPR version อื่นถูกปฏิเสธเป็น BRANCH_EXPRESSION_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'branch-paid',
        steps: [
          {
            id: 'branch-paid',
            type: 'BRANCH',
            expression: {
              language: 'DC_EXPR',
              version: 2 as unknown as 1,
              expression: { type: 'literal', value: true },
            },
            whenTrue: 'exit-goal',
            whenFalse: 'exit-goal',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['BRANCH_EXPRESSION_INVALID']);
});

test('BRANCH ที่อ้าง forbidden reference segment ถูกปฏิเสธเป็น BRANCH_EXPRESSION_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'branch-paid',
        steps: [
          {
            id: 'branch-paid',
            type: 'BRANCH',
            expression: {
              language: 'DC_EXPR',
              version: 1,
              expression: { type: 'ref', path: ['vars', '__proto__'] },
            },
            whenTrue: 'exit-goal',
            whenFalse: 'exit-goal',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['BRANCH_EXPRESSION_INVALID']);
});

test('trigger INTERACTION_OUTCOME ที่ outcomeType อยู่ใน allowlist ผ่านการตรวจ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeCode: 'CALLBACK_REQUESTED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, []);
});

test('trigger INTERACTION_OUTCOME ที่ outcomeType ไม่อยู่ใน allowlist ถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        // @ts-expect-error -- ทดสอบ type ที่ไม่อยู่ใน allowlist โดยตั้งใจ
        outcomeType: 'INTERACTION_QUEUED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('trigger INTERACTION_OUTCOME ที่ coalescingPolicy ไม่ใช่ PER_LOGICAL_OUTCOME ถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_ABANDONED',
        // @ts-expect-error -- V1 รองรับ PER_LOGICAL_OUTCOME เท่านั้น
        coalescingPolicy: 'PER_INTERACTION',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('trigger INTERACTION_OUTCOME ที่ outcomeCode เป็น free text ถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeCode: 'call the customer back please',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('ENSURE_CASE step ที่ครบ field ผ่านการตรวจและ reject path เข้าเงื่อนไข reachability', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'ensure-case',
        steps: [
          {
            id: 'ensure-case',
            type: 'ENSURE_CASE',
            caseTypeId: 'case-type-collections',
            routingIntentRef: 'routing-collections-default',
            next: 'exit-linked',
            onReject: 'exit-rejected',
          },
          { id: 'exit-linked', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'CASE_REJECTED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, []);
});

test('ADMIT_CAMPAIGN_TARGET ที่ขาด onReject ถูกปฏิเสธเป็น GRAPH_STEP_SHAPE_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'admit',
        steps: [
          {
            id: 'admit',
            type: 'ADMIT_CAMPAIGN_TARGET',
            campaignId: 'campaign-1',
            next: 'exit-goal',
            onReject: '',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_SHAPE_INVALID']);
});

test('SCHEDULE_CALLBACK ที่ requestedInSeconds ติดลบถูกปฏิเสธเป็น GRAPH_STEP_SHAPE_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'callback',
        steps: [
          {
            id: 'callback',
            type: 'SCHEDULE_CALLBACK',
            requestedInSeconds: -60,
            next: 'exit-goal',
            onReject: 'exit-rejected',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'REJECTED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_SHAPE_INVALID']);
});

test('action intent step ที่ target reference เป็น free text/PII ถูกปฏิเสธเป็น ACTION_INTENT_REFERENCE_INVALID', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'admit',
        steps: [
          {
            id: 'admit',
            type: 'ADMIT_CAMPAIGN_TARGET',
            campaignId: 'somebody@example.com',
            next: 'exit-goal',
            onReject: 'exit-rejected',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'REJECTED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['ACTION_INTENT_REFERENCE_INVALID']);
});

test('SCHEDULE_CALLBACK ที่ queueId เป็น opaque id ผ่าน แต่ agentId มีช่องว่างถูกปฏิเสธ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      graph: {
        entryStepId: 'callback',
        steps: [
          {
            id: 'callback',
            type: 'SCHEDULE_CALLBACK',
            requestedInSeconds: 3600,
            queueId: 'queue-collections',
            agentId: 'agent 42',
            next: 'exit-goal',
            onReject: 'exit-rejected',
          },
          { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'REJECTED' },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['ACTION_INTENT_REFERENCE_INVALID']);
});

test('หลาย field ผิดพร้อมกันคืน code ครบโดยไม่ซ้ำ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: { kind: 'EVENT', eventType: '' },
      goal: { kind: 'EVENT', eventType: '' },
      maxDurationDays: -1,
    }),
    evaluator,
  );
  assert.deepEqual(
    [...codes].sort(),
    ['GOAL_INVALID', 'MAX_DURATION_INVALID', 'TRIGGER_INVALID'].sort(),
  );
});
