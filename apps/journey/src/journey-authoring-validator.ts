import {
  JOURNEY_AUTHORING_LIMITS,
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  JOURNEY_INTERACTION_OUTCOME_TYPES,
  JOURNEY_NODE_PORTS,
  JOURNEY_RESTRICTED_NODE_TYPES,
  sortJourneyDiagnostics,
  type JourneyAuthoringErrorCode,
  type JourneyDiagnosticPathV1,
  type JourneyDiagnosticStage,
  type JourneyDiagnosticV1,
  type JourneySafeParams,
} from '@d-contact/cxa-contracts';
import {
  RESTRICTED_NODE_CAPABILITY,
  capabilityAvailable,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';

/**
 * J5.2 (#340): server validation ของ authoring document (Phase Spec #337 §4)
 *
 * ลำดับ pass คงที่: schema → registry/node fields → ports/cardinality → graph (cycle/placement)
 * → capability → limit. reachability, EXIT ที่เข้าถึงได้, expression และ reference shape เป็นของ
 * runtime validator เดิม (`validateJourneyDefinitionStructure`) ที่ compiler เรียกต่อ — ที่นี่ไม่ตรวจซ้ำ
 *
 * validator รับ `unknown` เพราะ document มาจาก client: ทุก field ต้องปิดชุด ไม่งั้น caller จะแนบของ
 * ที่ระบบไม่เคยอ่าน (PII, snapshot, DSL) ติดไปกับ draft ได้
 */

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'registryVersion',
  'trigger',
  'nodes',
  'edges',
  'settings',
  'layout',
]);
const SETTINGS_FIELDS = new Set([
  'name',
  'purpose',
  'senderIdentityId',
  'goal',
  'exitRules',
  'maxDurationDays',
]);
const NODE_FIELDS = new Set(['nodeId', 'type', 'label', 'config', 'templateNodeKey']);
const TRIGGER_FIELDS = new Set(['nodeId', 'type', 'label', 'config']);
const UNSUPPORTED_FIELDS = new Set(['nodeId', 'type', 'sourceType', 'source']);
const EDGE_FIELDS = new Set(['edgeId', 'source', 'target']);

type FieldKind = 'string' | 'opaque' | 'positive' | 'nonNegative' | 'object';

/** field ที่ config ของแต่ละ node มีได้ — required เว้นแต่ขึ้นต้นด้วย `?` */
const CONFIG_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldKind>>>> = {
  EVENT_TRIGGER: { eventType: 'string' },
  SCHEDULE_TRIGGER: { cron: 'string', timezone: 'string' },
  INTERACTION_OUTCOME_TRIGGER: {
    outcomeType: 'string',
    '?outcomeCode': 'opaque',
    coalescingPolicy: 'string',
  },
  SEGMENT_ENTRY_TRIGGER: { segmentId: 'opaque', coalescingPolicy: 'string' },
  SEND: { channel: 'string', contentRef: 'string' },
  WAIT: { waitSeconds: 'positive' },
  BRANCH: { expression: 'object' },
  EXIT: { reason: 'string' },
  ENSURE_CASE: { caseTypeId: 'opaque', routingIntentRef: 'opaque', targetOwnerTeamId: 'opaque' },
  ADMIT_CAMPAIGN_TARGET: { campaignId: 'opaque', targetOwnerTeamId: 'opaque' },
  SCHEDULE_CALLBACK: {
    requestedInSeconds: 'nonNegative',
    queueId: 'opaque',
    '?agentId': 'opaque',
    targetOwnerTeamId: 'opaque',
  },
};

const RESTRICTED: ReadonlySet<string> = new Set(JOURNEY_RESTRICTED_NODE_TYPES);
const OUTCOME_TYPES: ReadonlySet<string> = new Set(JOURNEY_INTERACTION_OUTCOME_TYPES);

export interface ValidateAuthoringOptions {
  readonly capabilities: readonly JourneyRuntimeCapability[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

class Diagnostics {
  readonly items: JourneyDiagnosticV1[] = [];

  add(
    code: JourneyAuthoringErrorCode,
    stage: JourneyDiagnosticStage,
    path?: JourneyDiagnosticPathV1,
    safeParams?: JourneySafeParams,
    severity: 'ERROR' | 'WARNING' = 'ERROR',
  ) {
    this.items.push({
      code,
      severity,
      stage,
      messageKey: `journey.authoring.${code}`,
      ...(path ? { path } : {}),
      ...(safeParams ? { safeParams } : {}),
    });
  }

  get hasErrors() {
    return this.items.some((item) => item.severity === 'ERROR');
  }
}

function fieldValid(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return isText(value);
    case 'opaque':
      return typeof value === 'string' && OPAQUE_ID.test(value);
    case 'positive':
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    case 'nonNegative':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'object':
      return isObject(value);
  }
}

function validateConfig(type: string, node: Json, nodeId: string, diagnostics: Diagnostics) {
  const spec = CONFIG_FIELDS[type]!;
  const config = node.config;
  if (!isObject(config)) {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { nodeId, field: 'config' });
    return;
  }
  const allowed = new Map(
    Object.entries(spec).map(([key, kind]) => [
      key.replace(/^\?/, ''),
      { kind, optional: key.startsWith('?') },
    ]),
  );
  for (const key of Object.keys(config)) {
    if (!allowed.has(key))
      diagnostics.add('NODE_FIELD_UNKNOWN', 'AUTHORING', { nodeId, field: `config.${key}` });
  }
  for (const [key, { kind, optional }] of allowed) {
    const value = config[key];
    if (value === undefined && optional) continue;
    if (!fieldValid(kind, value)) {
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { nodeId, field: `config.${key}` });
    }
  }
  if (type === 'INTERACTION_OUTCOME_TRIGGER') {
    if (
      !OUTCOME_TYPES.has(String(config.outcomeType)) ||
      config.coalescingPolicy !== 'PER_LOGICAL_OUTCOME'
    ) {
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', {
        nodeId,
        field: 'config.outcomeType',
      });
    }
  }
  if (type === 'SEGMENT_ENTRY_TRIGGER' && config.coalescingPolicy !== 'PER_SEGMENT_ENTRY') {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', {
      nodeId,
      field: 'config.coalescingPolicy',
    });
  }
}

function closedKeys(
  value: Json,
  allowed: ReadonlySet<string>,
  path: JourneyDiagnosticPathV1,
  diagnostics: Diagnostics,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      diagnostics.add('NODE_FIELD_UNKNOWN', 'AUTHORING', { ...path, field: key });
  }
}

/** คืน diagnostics ที่เรียงแล้ว; document ที่ schema พังคืนเฉพาะ diagnostic ของ schema */
export function validateAuthoringDocument(
  document: unknown,
  options: ValidateAuthoringOptions,
): JourneyDiagnosticV1[] {
  const diagnostics = new Diagnostics();

  // ── schema ──
  if (!isObject(document)) {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING');
    return diagnostics.items;
  }
  for (const key of Object.keys(document)) {
    if (!TOP_LEVEL_FIELDS.has(key))
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: key });
  }
  if (document.schemaVersion !== JOURNEY_AUTHORING_SCHEMA_VERSION) {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'schemaVersion' });
  }
  if (document.registryVersion !== JOURNEY_AUTHORING_REGISTRY_VERSION) {
    diagnostics.add('COMPILER_VERSION_UNSUPPORTED', 'AUTHORING', { field: 'registryVersion' });
  }
  const { trigger, nodes, edges, settings, layout } = document;
  if (!isObject(trigger))
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'trigger' });
  if (!Array.isArray(nodes))
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'nodes' });
  if (!Array.isArray(edges))
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'edges' });
  if (!isObject(settings))
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'settings' });
  if (!isObject(layout) || !isObject(layout.nodes)) {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'layout' });
  }
  if (diagnostics.hasErrors) return sortJourneyDiagnostics(diagnostics.items);
  const triggerNode = trigger as Json;
  const nodeList = nodes as unknown[];
  const edgeList = edges as unknown[];
  closedKeys(settings as Json, SETTINGS_FIELDS, {}, diagnostics);

  // ── registry / node fields ──
  const types = new Map<string, string>();
  const triggerId = triggerNode.nodeId;
  if (typeof triggerId !== 'string' || !OPAQUE_ID.test(triggerId)) {
    diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: 'trigger.nodeId' });
  } else if (
    typeof triggerNode.type !== 'string' ||
    !(triggerNode.type in CONFIG_FIELDS) ||
    !triggerNode.type.endsWith('_TRIGGER')
  ) {
    diagnostics.add('NODE_TYPE_UNSUPPORTED', 'AUTHORING', { nodeId: triggerId });
  } else {
    closedKeys(triggerNode, TRIGGER_FIELDS, { nodeId: triggerId }, diagnostics);
    validateConfig(triggerNode.type, triggerNode, triggerId, diagnostics);
    types.set(triggerId, triggerNode.type);
  }

  for (const [index, raw] of nodeList.entries()) {
    if (!isObject(raw) || typeof raw.nodeId !== 'string' || !OPAQUE_ID.test(raw.nodeId)) {
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: `nodes.${index}` });
      continue;
    }
    const nodeId = raw.nodeId;
    if (types.has(nodeId)) {
      diagnostics.add(
        'AUTHORING_SCHEMA_INVALID',
        'AUTHORING',
        { nodeId, field: 'nodeId' },
        { reason: 'DUPLICATE' },
      );
      continue;
    }
    if (raw.type === 'UNSUPPORTED') {
      // เก็บ source เดิมไว้แบบ read-only แต่ publish ไม่ได้ (#328 §10)
      closedKeys(raw, UNSUPPORTED_FIELDS, { nodeId }, diagnostics);
      diagnostics.add('NODE_TYPE_UNSUPPORTED', 'AUTHORING', { nodeId }, { readOnly: true });
      types.set(nodeId, 'UNSUPPORTED');
      continue;
    }
    if (
      typeof raw.type !== 'string' ||
      !(raw.type in CONFIG_FIELDS) ||
      raw.type.endsWith('_TRIGGER')
    ) {
      diagnostics.add('NODE_TYPE_UNSUPPORTED', 'AUTHORING', { nodeId });
      types.set(nodeId, 'UNSUPPORTED');
      continue;
    }
    closedKeys(raw, NODE_FIELDS, { nodeId }, diagnostics);
    if (
      raw.templateNodeKey !== undefined &&
      (typeof raw.templateNodeKey !== 'string' || !OPAQUE_ID.test(raw.templateNodeKey))
    ) {
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', {
        nodeId,
        field: 'templateNodeKey',
      });
    }
    validateConfig(raw.type, raw, nodeId, diagnostics);
    types.set(nodeId, raw.type);
  }

  // ── ports / cardinality ──
  const used = new Set<string>();
  const successors = new Map<string, string[]>();
  const edgeIds = new Set<string>();
  const entryTargets: string[] = [];
  for (const [index, raw] of edgeList.entries()) {
    if (!isObject(raw) || !isText(raw.edgeId) || !isObject(raw.source) || !isObject(raw.target)) {
      diagnostics.add('AUTHORING_SCHEMA_INVALID', 'AUTHORING', { field: `edges.${index}` });
      continue;
    }
    const edgeId = raw.edgeId;
    closedKeys(raw, EDGE_FIELDS, { edgeId }, diagnostics);
    if (edgeIds.has(edgeId)) {
      diagnostics.add(
        'AUTHORING_SCHEMA_INVALID',
        'AUTHORING',
        { edgeId, field: 'edgeId' },
        { reason: 'DUPLICATE' },
      );
      continue;
    }
    edgeIds.add(edgeId);
    const from = String(raw.source.nodeId ?? '');
    const portId = String(raw.source.portId ?? '');
    const to = String(raw.target.nodeId ?? '');
    const fromType = types.get(from);
    const toType = types.get(to);
    if (!fromType || !toType) {
      diagnostics.add('EDGE_REFERENCE_INVALID', 'AUTHORING', {
        edgeId,
        nodeId: fromType ? to : from,
      });
      continue;
    }
    if (fromType === 'UNSUPPORTED' || toType === 'UNSUPPORTED') continue;
    const outputs = JOURNEY_NODE_PORTS[fromType as keyof typeof JOURNEY_NODE_PORTS]
      .outputs as Record<string, string>;
    if (!(portId in outputs)) {
      diagnostics.add('PORT_INVALID', 'AUTHORING', { edgeId, nodeId: from, portId });
      continue;
    }
    if (toType.endsWith('_TRIGGER')) {
      diagnostics.add('PORT_INVALID', 'AUTHORING', { edgeId, nodeId: to, portId: 'in' });
      continue;
    }
    const slot = `${from}|${portId}`;
    if (used.has(slot)) {
      diagnostics.add('PORT_CARDINALITY_INVALID', 'AUTHORING', { edgeId, nodeId: from, portId });
      continue;
    }
    used.add(slot);
    successors.set(from, [...(successors.get(from) ?? []), to]);
    if (from === triggerId) entryTargets.push(to);
  }
  // output port ทุกตัวต้องต่อ target เดียวพอดี เพราะ runtime field เป็น scalar
  for (const [nodeId, type] of types) {
    if (type === 'UNSUPPORTED') continue;
    const outputs = JOURNEY_NODE_PORTS[type as keyof typeof JOURNEY_NODE_PORTS].outputs;
    for (const portId of Object.keys(outputs)) {
      if (!used.has(`${nodeId}|${portId}`)) {
        diagnostics.add('PORT_CARDINALITY_INVALID', 'AUTHORING', { nodeId, portId });
      }
    }
  }

  // ── graph: cycle และตำแหน่งของ restricted action ──
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (nodeId: string) => {
    if (done.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      cyclic.add(nodeId);
      return;
    }
    visiting.add(nodeId);
    for (const next of successors.get(nodeId) ?? []) visit(next);
    visiting.delete(nodeId);
    done.add(nodeId);
  };
  for (const nodeId of [...types.keys()].sort()) visit(nodeId);
  for (const nodeId of [...cyclic].sort()) {
    diagnostics.add('GRAPH_CYCLE_UNSUPPORTED', 'AUTHORING', { nodeId });
  }

  const triggerType = typeof triggerId === 'string' ? types.get(triggerId) : undefined;
  let restrictedUsed = false;
  for (const [nodeId, type] of types) {
    if (!RESTRICTED.has(type)) continue;
    restrictedUsed = true;
    // วางได้เฉพาะ entry step หลัง INTERACTION_OUTCOME_TRIGGER — ห้าม mid-graph (#328 §4)
    if (triggerType !== 'INTERACTION_OUTCOME_TRIGGER' || !entryTargets.includes(nodeId)) {
      diagnostics.add(
        'NODE_TYPE_UNSUPPORTED',
        'AUTHORING',
        { nodeId },
        { reason: 'RESTRICTED_PLACEMENT' },
      );
    }
  }

  // ── capability ──
  if (restrictedUsed && !capabilityAvailable(options.capabilities, RESTRICTED_NODE_CAPABILITY)) {
    diagnostics.add('RUNTIME_CAPABILITY_UNAVAILABLE', 'COMPILE', undefined, {
      capability: RESTRICTED_NODE_CAPABILITY,
    });
  }

  // ── limit ──
  if (nodeList.length > JOURNEY_AUTHORING_LIMITS.runtimeSteps) {
    diagnostics.add(
      'GRAPH_LIMIT_EXCEEDED',
      'AUTHORING',
      { field: 'nodes' },
      { limit: JOURNEY_AUTHORING_LIMITS.runtimeSteps },
    );
  }
  if (edgeList.length > JOURNEY_AUTHORING_LIMITS.controlEdges) {
    diagnostics.add(
      'GRAPH_LIMIT_EXCEEDED',
      'AUTHORING',
      { field: 'edges' },
      { limit: JOURNEY_AUTHORING_LIMITS.controlEdges },
    );
  }

  return sortJourneyDiagnostics(diagnostics.items);
}
