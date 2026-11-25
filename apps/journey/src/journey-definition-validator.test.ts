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
    name: 'Overdue debt collection',
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

test('a definition that meets the contract has no validation code', () => {
  const codes = validateJourneyDefinitionStructure(validDefinition(), evaluator);
  assert.deepEqual(codes, []);
});

test('a trigger with an unknown kind or a missing field is rejected', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({ trigger: { kind: 'EVENT', eventType: '' } }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('a goal that is not EVENT or lacks eventType is rejected', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({ goal: { kind: 'EVENT', eventType: '   ' } }),
    evaluator,
  );
  assert.deepEqual(codes, ['GOAL_INVALID']);
});

test('an empty purpose or senderIdentityId is rejected as DELIVERY_DEFAULTS_INVALID', () => {
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ purpose: '' }), evaluator),
    ['DELIVERY_DEFAULTS_INVALID'],
  );
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ senderIdentityId: '  ' }), evaluator),
    ['DELIVERY_DEFAULTS_INVALID'],
  );
});

test('empty exitRules are rejected', () => {
  const codes = validateJourneyDefinitionStructure(validDefinition({ exitRules: [] }), evaluator);
  assert.deepEqual(codes, ['EXIT_RULE_INVALID']);
});

test('a maxDurationDays that is not positive or exceeds the ceiling is rejected', () => {
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ maxDurationDays: 0 }), evaluator),
    ['MAX_DURATION_INVALID'],
  );
  assert.deepEqual(
    validateJourneyDefinitionStructure(validDefinition({ maxDurationDays: 999999 }), evaluator),
    ['MAX_DURATION_INVALID'],
  );
});

test('an entryStepId that is not in steps is rejected as GRAPH_ENTRY_MISSING', () => {
  const definition = validDefinition();
  const codes = validateJourneyDefinitionStructure(
    { ...definition, graph: { ...definition.graph, entryStepId: 'does-not-exist' } },
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_ENTRY_MISSING']);
});

test('a duplicate step id is rejected as GRAPH_STEP_ID_DUPLICATE', () => {
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

test('a step whose next references a non-existent id is rejected as GRAPH_STEP_REFERENCE_MISSING', () => {
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
            next: 'does-not-exist',
          },
        ],
      },
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['GRAPH_STEP_REFERENCE_MISSING']);
});

test('a step the entry cannot reach is rejected as GRAPH_STEP_UNREACHABLE', () => {
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

test('a graph with no terminal reachable from the entry is rejected as GRAPH_NO_TERMINAL_REACHABLE', () => {
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

test('a SEND step missing contentRef is rejected as GRAPH_STEP_SHAPE_INVALID', () => {
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

test('a BRANCH using a different DC_EXPR version is rejected as BRANCH_EXPRESSION_INVALID', () => {
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

test('a BRANCH that references a forbidden segment reference is rejected as BRANCH_EXPRESSION_INVALID', () => {
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

/** the entry step must be an action-intent step when the trigger is INTERACTION_OUTCOME (#135) */
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

test('an INTERACTION_OUTCOME trigger whose outcomeType is in the allowlist passes validation', () => {
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

test('an INTERACTION_OUTCOME trigger whose outcomeType is not in the allowlist is rejected', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        // @ts-expect-error -- deliberately testing a type that is not in the allowlist
        outcomeType: 'INTERACTION_QUEUED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
      graph: outcomeTriggerGraph(),
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('an INTERACTION_OUTCOME trigger whose coalescingPolicy is not PER_LOGICAL_OUTCOME is rejected', () => {
  const codes = validateJourneyDefinitionStructure(
    validDefinition({
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_ABANDONED',
        // @ts-expect-error -- V1 supports only PER_LOGICAL_OUTCOME
        coalescingPolicy: 'PER_INTERACTION',
      },
      graph: outcomeTriggerGraph(),
    }),
    evaluator,
  );
  assert.deepEqual(codes, ['TRIGGER_INVALID']);
});

test('an INTERACTION_OUTCOME trigger whose outcomeCode is free text is rejected', () => {
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

test('an INTERACTION_OUTCOME trigger whose entry step is not an action-intent step is rejected as ENTRY_STEP_ACTION_INTENT_REQUIRED', () => {
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

test('an ENSURE_CASE step with all fields passes validation and the reject path meets the reachability condition', () => {
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

test('an ADMIT_CAMPAIGN_TARGET missing onReject is rejected as GRAPH_STEP_SHAPE_INVALID', () => {
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

test('a SCHEDULE_CALLBACK with a negative requestedInSeconds is rejected as GRAPH_STEP_SHAPE_INVALID', () => {
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

test('an action intent step whose target reference is free text/PII is rejected as ACTION_INTENT_REFERENCE_INVALID', () => {
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

test('a SCHEDULE_CALLBACK whose queueId is an opaque id passes but an agentId with whitespace is rejected', () => {
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

test('several wrong fields at once return all codes without duplicates', () => {
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

test('a SEGMENT_ENTRY trigger that meets the contract passes validation', () => {
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

test('a SEGMENT_ENTRY trigger whose coalescingPolicy is not PER_SEGMENT_ENTRY is rejected', () => {
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
    assert.deepEqual(codes, ['TRIGGER_INVALID'], `policy ${coalescingPolicy} must not pass`);
  }
});

test('a SEGMENT_ENTRY trigger whose segmentId is not an opaque id is rejected', () => {
  /**
   * These values are the shapes through which free text, whitespace, email and path traversal would slip in
   *
   * Note: OPAQUE_ID_PATTERN allows digits and hyphens, so a string that looks like a phone number can pass
   * this pattern — PII protection does not rely on this pattern but on the closed shape of the trigger, which
   * does not allow any field other than segmentId to be attached in the first place
   */
  for (const segmentId of [
    '',
    '   ',
    'Gold customer',
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
      `segmentId ${JSON.stringify(segmentId)} must not pass`,
    );
  }
});

test('a SEGMENT_ENTRY trigger that attaches a segment definition, member list or raw attributes is rejected', () => {
  // Journey does not own the segment definition — these must never be persisted into a definition
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
      `field ${Object.keys(extra)[0]} must not be let through`,
    );
  }
});

test('an INTERACTION_OUTCOME trigger that attaches a foreign field is also rejected', () => {
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

test('SEGMENT_ENTRY does not require the entry step to be an action intent like INTERACTION_OUTCOME', () => {
  // that requirement is bound specifically to the receipt transition of J2.7, not a rule for every trigger type
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
