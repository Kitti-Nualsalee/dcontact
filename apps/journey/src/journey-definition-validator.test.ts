import assert from 'node:assert/strict';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import type { JourneyDefinitionContent, JourneyGraph } from './journey-definition.js';
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

/** entry step ต้องเป็น action-intent step เมื่อ trigger เป็น INTERACTION_OUTCOME (#135) */
function outcomeTriggerGraph(): JourneyGraph {
  return {
    entryStepId: 'admit',
    steps: [
      {
        id: 'admit',
        type: 'ADMIT_CAMPAIGN_TARGET',
        campaignId: 'campaign-1',
        targetOwnerTeamId: 'team-dialer',
        next: 'exit-goal',
        onReject: 'exit-rejected',
      },
      { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
      { id: 'exit-rejected', type: 'EXIT', reason: 'REJECTED' },
    ],
  };
}

test('trigger INTERACTION_OUTCOME ที่ outcomeType อยู่ใน allowlist ผ่านการตรวจ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeCode: 'CALLBACK_REQUESTED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
      graph: outcomeTriggerGraph(),
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
      graph: outcomeTriggerGraph(),
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
      graph: outcomeTriggerGraph(),
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
      graph: outcomeTriggerGraph(),
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('trigger INTERACTION_OUTCOME ที่ entry step ไม่ใช่ action-intent step ถูกปฏิเสธเป็น ENTRY_STEP_ACTION_INTENT_REQUIRED', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_ABANDONED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['ENTRY_STEP_ACTION_INTENT_REQUIRED']);
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
            targetOwnerTeamId: 'team-cases',
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
            targetOwnerTeamId: 'team-dialer',
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
            queueId: 'queue-collections',
            targetOwnerTeamId: 'team-dialer',
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
            targetOwnerTeamId: 'team-dialer',
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
            targetOwnerTeamId: 'team-dialer',
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

test('trigger SEGMENT_ENTRY ที่ครบตามสัญญาผ่านการตรวจ', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'SEGMENT_ENTRY',
        segmentId: 'segment-gold',
        coalescingPolicy: 'PER_SEGMENT_ENTRY',
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, []);
});

test('trigger SEGMENT_ENTRY ที่ coalescingPolicy ไม่ใช่ PER_SEGMENT_ENTRY ถูกปฏิเสธ', () => {
  for (const coalescingPolicy of ['PER_LOGICAL_OUTCOME', 'PER_MEMBERSHIP_REVISION', '']) {
    const codes = validateJourneyDefinitionStructure(
      validDefinition({
        trigger: {
          kind: 'SEGMENT_ENTRY',
          segmentId: 'segment-gold',
          coalescingPolicy,
        } as unknown as JourneyDefinitionContent['trigger'],
      }),
      evaluator,
    );
    assert.deepEqual(codes, ['TRIGGER_INVALID'], `policy ${coalescingPolicy} ต้องไม่ผ่าน`);
  }
});

test('trigger SEGMENT_ENTRY ที่ segmentId ไม่ใช่ opaque id ถูกปฏิเสธ', () => {
  /**
   * ค่าเหล่านี้คือรูปแบบที่ free text, ช่องว่าง, อีเมล และ path traversal จะเล็ดลอดเข้ามา
   *
   * หมายเหตุ: OPAQUE_ID_PATTERN อนุญาตตัวเลขกับขีดกลาง สตริงที่หน้าตาเหมือนเบอร์โทรจึงผ่าน
   * รูปแบบนี้ได้ — การกัน PII ไม่ได้พึ่ง pattern ตัวนี้ แต่พึ่ง closed shape ของ trigger ที่
   * ไม่ยอมให้แนบ field ใดนอกจาก segmentId เข้ามาตั้งแต่แรก
   */
  for (const segmentId of [
    '',
    '   ',
    'ลูกค้า Gold',
    'a@b.com',
    '../other-tenant',
    'x'.repeat(129),
  ]) {
    const codes = validateJourneyDefinitionStructure(
      validDefinition({
        trigger: { kind: 'SEGMENT_ENTRY', segmentId, coalescingPolicy: 'PER_SEGMENT_ENTRY' },
      }),
      evaluator,
    );
    assert.deepEqual(
      codes,
      ['TRIGGER_INVALID'],
      `segmentId ${JSON.stringify(segmentId)} ต้องไม่ผ่าน`,
    );
  }
});

test('trigger SEGMENT_ENTRY ที่แนบนิยาม segment, member list หรือ attribute ดิบมาด้วยถูกปฏิเสธ', () => {
  // Journey ไม่ใช่เจ้าของนิยาม segment — ของพวกนี้ห้าม persist ลง definition เด็ดขาด
  const smuggled: Array<Record<string, unknown>> = [
    {
      expression: { language: 'DC_EXPR', version: 1, expression: { type: 'literal', value: true } },
    },
    { memberContactIds: ['contact-1', 'contact-2'] },
    { attributes: { tier: 'GOLD', phone: '081-234-5678' } },
    { membershipSnapshot: { revision: 7, state: 'IN' } },
    { segmentDefinitionVersion: 3 },
  ];
  for (const extra of smuggled) {
    const codes = validateJourneyDefinitionStructure(
      validDefinition({
        trigger: {
          kind: 'SEGMENT_ENTRY',
          segmentId: 'segment-gold',
          coalescingPolicy: 'PER_SEGMENT_ENTRY',
          ...extra,
        } as unknown as JourneyDefinitionContent['trigger'],
      }),
      evaluator,
    );
    assert.deepEqual(
      codes,
      ['TRIGGER_INVALID'],
      `field ${Object.keys(extra)[0]} ต้องไม่ถูกปล่อยผ่าน`,
    );
  }
});

test('trigger INTERACTION_OUTCOME ที่แนบ field แปลกปลอมก็ถูกปฏิเสธเช่นกัน', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_ABANDONED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
        callerSnapshot: { contactId: 'contact-1' },
      } as unknown as JourneyDefinitionContent['trigger'],
      graph: outcomeTriggerGraph(),
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('SEGMENT_ENTRY ไม่ต้องบังคับให้ entry step เป็น action intent เหมือน INTERACTION_OUTCOME', () => {
  // ข้อบังคับนั้นผูกกับ receipt transition ของ J2.7 โดยเฉพาะ ไม่ใช่กติกาของ trigger ทุกชนิด
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'SEGMENT_ENTRY',
        segmentId: 'segment-gold',
        coalescingPolicy: 'PER_SEGMENT_ENTRY',
      },
    }),
    evaluator,
  );
  assert.ok(!codes.includes('ENTRY_STEP_ACTION_INTENT_REQUIRED'));
});
