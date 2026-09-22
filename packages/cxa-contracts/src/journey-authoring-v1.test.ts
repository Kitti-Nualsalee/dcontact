import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNEY_AUTHORING_CAPABILITIES,
  JOURNEY_AUTHORING_COMMANDS,
  JOURNEY_AUTHORING_ERROR_CODES,
  JOURNEY_AUTHORING_HTTP_STATUS,
  JOURNEY_AUTHORING_ROLLOUT_STAGES,
  JOURNEY_DELEGABLE_CAPABILITIES,
  JOURNEY_DELEGATION_MAX_SECONDS,
  JOURNEY_LEGACY_ERROR_CODES,
  JOURNEY_LIFECYCLE_TRANSITIONS,
  JOURNEY_NODE_PORTS,
  JOURNEY_PORT_IDS,
  JOURNEY_RESTRICTED_NODE_TYPES,
  JOURNEY_TEMPLATE_BLOCKING_CONFLICT_KINDS,
  JOURNEY_TEMPLATE_COMMANDS,
  JOURNEY_TEMPLATE_LIFECYCLE_TRANSITIONS,
  JOURNEY_TEMPLATE_PARAMETER_TYPES,
  isJourneyAuthoringCapability,
  isJourneyAuthoringErrorCode,
  isJourneyTemplateBindPointer,
  isJourneyTemplateParameterType,
  journeyDiagnosticsBlockPublish,
  sortJourneyDiagnostics,
  type AuthoringDocumentV1,
  type CompileArtifactV1,
  type CreateJourneyDraftRequestV1,
  type JourneyDiagnosticV1,
} from './index.js';

test('error registry ไม่ซ้ำ, คง code เดิมของ J1–J3 และทุก code มี HTTP status', () => {
  assert.equal(new Set(JOURNEY_AUTHORING_ERROR_CODES).size, JOURNEY_AUTHORING_ERROR_CODES.length);
  for (const code of JOURNEY_LEGACY_ERROR_CODES) assert.ok(isJourneyAuthoringErrorCode(code));
  assert.deepEqual(
    Object.keys(JOURNEY_AUTHORING_HTTP_STATUS).sort(),
    [...JOURNEY_AUTHORING_ERROR_CODES].sort(),
  );
  assert.equal(JOURNEY_AUTHORING_HTTP_STATUS.JOURNEY_NOT_FOUND, 404);
  assert.equal(JOURNEY_AUTHORING_HTTP_STATUS.TEMPLATE_NOT_FOUND, 404);
  assert.equal(JOURNEY_AUTHORING_HTTP_STATUS.PUBLISH_OUTCOME_UNKNOWN, 202);
  assert.equal(JOURNEY_AUTHORING_HTTP_STATUS.COMPILE_DIGEST_MISMATCH, 409);
  assert.equal(isJourneyAuthoringErrorCode('SOMETHING_NEW'), false);
});

test('diagnostic เรียง severity → stage → node → edge → port → field → code และ block เฉพาะ ERROR', () => {
  const diagnostic = (
    code: JourneyDiagnosticV1['code'],
    severity: JourneyDiagnosticV1['severity'],
    stage: JourneyDiagnosticV1['stage'],
    nodeId?: string,
  ): JourneyDiagnosticV1 => ({
    code,
    severity,
    stage,
    messageKey: `journey.${code}`,
    ...(nodeId ? { path: { nodeId } } : {}),
  });
  const input = [
    diagnostic('PORT_INVALID', 'WARNING', 'AUTHORING', 'b'),
    diagnostic('COMPILE_ARTIFACT_STALE', 'ERROR', 'COMPILE'),
    diagnostic('PORT_INVALID', 'ERROR', 'AUTHORING', 'b'),
    diagnostic('EDGE_REFERENCE_INVALID', 'ERROR', 'AUTHORING', 'a'),
    diagnostic('AUTHORING_SCHEMA_INVALID', 'ERROR', 'AUTHORING'),
  ];
  assert.deepEqual(
    sortJourneyDiagnostics(input).map(({ code, severity }) => `${severity}:${code}`),
    [
      'ERROR:AUTHORING_SCHEMA_INVALID',
      'ERROR:EDGE_REFERENCE_INVALID',
      'ERROR:PORT_INVALID',
      'ERROR:COMPILE_ARTIFACT_STALE',
      'WARNING:PORT_INVALID',
    ],
  );
  assert.deepEqual(sortJourneyDiagnostics([...input].reverse()), sortJourneyDiagnostics(input));
  assert.equal(journeyDiagnosticsBlockPublish(input), true);
  assert.equal(journeyDiagnosticsBlockPublish([input[0]!]), false);
});

test('port catalog ปิดชุด: ทุก port อยู่ใน catalog, trigger ไม่มี input และ EXIT ไม่มี output', () => {
  const ports = new Set<string>(JOURNEY_PORT_IDS);
  for (const [type, spec] of Object.entries(JOURNEY_NODE_PORTS)) {
    if (spec.input) assert.ok(ports.has(spec.input), type);
    for (const port of Object.keys(spec.outputs)) assert.ok(ports.has(port), `${type}.${port}`);
  }
  assert.equal(JOURNEY_NODE_PORTS.EVENT_TRIGGER.input, null);
  assert.deepEqual(JOURNEY_NODE_PORTS.EXIT.outputs, {});
  assert.deepEqual(JOURNEY_NODE_PORTS.BRANCH.outputs, {
    true: 'whenTrue',
    false_or_error: 'whenFalse',
  });
  // restricted action compile ลง runtime field เดิม next/onReject ไม่สร้าง field ใหม่
  for (const type of JOURNEY_RESTRICTED_NODE_TYPES) {
    assert.deepEqual(JOURNEY_NODE_PORTS[type].outputs, { accepted: 'next', rejected: 'onReject' });
  }
});

test('lifecycle เดินตาม state machine ที่ตรึงไว้ และ DEPRECATED เป็น terminal', () => {
  assert.deepEqual(JOURNEY_LIFECYCLE_TRANSITIONS.DEPRECATED, []);
  assert.ok(!(JOURNEY_LIFECYCLE_TRANSITIONS.ACTIVE as readonly string[]).includes('DRAFT_ONLY'));
  assert.deepEqual(JOURNEY_TEMPLATE_LIFECYCLE_TRANSITIONS.DRAFT_ONLY, ['ACTIVE']);
  assert.deepEqual(JOURNEY_AUTHORING_ROLLOUT_STAGES[0], 'DISABLED');
});

test('capability ปิดชุดและ delegation ใช้ได้แค่ read/edit ไม่เกิน 8 ชั่วโมง', () => {
  assert.equal(JOURNEY_AUTHORING_CAPABILITIES.length, 13);
  for (const capability of JOURNEY_DELEGABLE_CAPABILITIES) {
    assert.ok(isJourneyAuthoringCapability(capability));
    assert.match(capability, /\.(read|edit)$/);
  }
  assert.equal(isJourneyAuthoringCapability('journey.admin'), false);
  assert.equal(JOURNEY_DELEGATION_MAX_SECONDS, 28_800);
});

test('template parameter ไม่มีชนิด secret/credential/json และ bind pointer แตะได้แค่ scalar ใน config', () => {
  for (const forbidden of ['SECRET', 'CREDENTIAL', 'JSON', 'HTML', 'SCRIPT']) {
    assert.equal(isJourneyTemplateParameterType(forbidden), false, forbidden);
  }
  assert.equal(JOURNEY_TEMPLATE_PARAMETER_TYPES.length, 9);
  assert.equal(isJourneyTemplateBindPointer('/config/waitSeconds'), true);
  for (const pointer of ['/nodeId', '/type', '/config', '/config/expression/root', '/edges/0']) {
    assert.equal(isJourneyTemplateBindPointer(pointer), false, pointer);
  }
  assert.ok(JOURNEY_TEMPLATE_BLOCKING_CONFLICT_KINDS.includes('PARAMETER_REQUIRED_UNBOUND'));
});

test('command ของ Journey และ template ไม่ชนกัน และ request DTO ไม่มี tenantId', () => {
  const commands = [...JOURNEY_AUTHORING_COMMANDS, ...JOURNEY_TEMPLATE_COMMANDS];
  assert.equal(new Set(commands).size, commands.length);

  const document: AuthoringDocumentV1 = {
    schemaVersion: 'J5_AUTHORING_V1',
    registryVersion: 'J5_PALETTE_V1',
    trigger: { nodeId: 'trigger', type: 'EVENT_TRIGGER', config: { eventType: 'order.created' } },
    nodes: [{ nodeId: 'exit', type: 'EXIT', config: { reason: 'DONE' } }],
    edges: [
      { edgeId: 'e1', source: { nodeId: 'trigger', portId: 'start' }, target: { nodeId: 'exit' } },
    ],
    settings: {
      name: 'synthetic',
      purpose: 'SERVICE',
      senderIdentityId: 'sender-test',
      goal: { kind: 'EVENT', eventType: 'order.completed' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 7,
    },
    layout: { nodes: { trigger: { x: 0, y: 0 }, exit: { x: 200, y: 0 } } },
  };
  const request: CreateJourneyDraftRequestV1 = { ownerTeamId: 'team-1', document };
  assert.ok(!('tenantId' in request));

  // runtime definition เป็น generic: contract ไม่ duplicate JourneyDefinitionContent
  const artifact: Pick<CompileArtifactV1<{ name: string }>, 'runtimeDefinition'> = {
    runtimeDefinition: { name: 'synthetic' },
  };
  assert.equal(artifact.runtimeDefinition.name, 'synthetic');
});
