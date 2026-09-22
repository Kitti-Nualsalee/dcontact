/**
 * J5.6 (#344): model ฝั่ง Console ของ Journey authoring (Phase Spec #337 §8)
 *
 * - document ที่แก้อยู่ไม่ใช่ความจริงของระบบ: เป็น `server snapshot + command log` เสมอ canvas และ
 *   outline ส่ง command ชุดเดียวกันเข้า reducer เดียว จึงไม่มี hidden state ระหว่างสองมุมมอง
 * - ค่าคงที่ของ node/port เป็นกระจกของ `@d-contact/cxa-contracts` (index ของ contracts ดึง node:crypto
 *   เข้ามา bundle ใน browser ไม่ได้) — unit test ตรึงให้ตรงกับ contracts ทุกตัว
 * - ตรวจแบบ local เป็นแค่คำใบ้ให้ผู้ใช้; validate/compile/publish ตัดสินที่ server เท่านั้น
 */
import type {
  AuthoringDocumentV1,
  AuthoringEdgeV1,
  AuthoringStepNodeV1,
  AuthoringUnsupportedNodeV1,
  JourneyPortId,
} from '@d-contact/cxa-contracts';

export type StepNodeType = AuthoringStepNodeV1['type'];
export type TriggerNodeType = AuthoringDocumentV1['trigger']['type'];
export type AnyNodeType = StepNodeType | TriggerNodeType;
export type DocumentNode = AuthoringStepNodeV1 | AuthoringUnsupportedNodeV1;

export const TRIGGER_NODE_TYPES = [
  'EVENT_TRIGGER',
  'SCHEDULE_TRIGGER',
  'INTERACTION_OUTCOME_TRIGGER',
  'SEGMENT_ENTRY_TRIGGER',
] as const satisfies readonly TriggerNodeType[];
export const RUNTIME_NODE_TYPES = ['SEND', 'WAIT', 'BRANCH', 'EXIT'] as const;
export const RESTRICTED_NODE_TYPES = [
  'ENSURE_CASE',
  'ADMIT_CAMPAIGN_TARGET',
  'SCHEDULE_CALLBACK',
] as const;
export const STEP_NODE_TYPES = [
  ...RUNTIME_NODE_TYPES,
  ...RESTRICTED_NODE_TYPES,
] as const satisfies readonly StepNodeType[];

/** output port ตามลำดับที่แสดง; ทุก port ต่อได้ target เดียว (runtime field เป็น scalar) */
export const NODE_OUTPUT_PORTS: Readonly<Record<AnyNodeType, readonly JourneyPortId[]>> = {
  EVENT_TRIGGER: ['start'],
  SCHEDULE_TRIGGER: ['start'],
  INTERACTION_OUTCOME_TRIGGER: ['start'],
  SEGMENT_ENTRY_TRIGGER: ['start'],
  SEND: ['next'],
  WAIT: ['next'],
  BRANCH: ['true', 'false_or_error'],
  EXIT: [],
  ENSURE_CASE: ['accepted', 'rejected'],
  ADMIT_CAMPAIGN_TARGET: ['accepted', 'rejected'],
  SCHEDULE_CALLBACK: ['accepted', 'rejected'],
};

export const CONTACT_CHANNELS = ['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL'];
export const INTERACTION_OUTCOME_TYPES = [
  'INTERACTION_ABANDONED',
  'INTERACTION_DISPOSITION_RECORDED',
  'FEEDBACK_DETRACTOR_RECORDED',
];

export const NODE_LABELS: Readonly<Record<AnyNodeType | 'UNSUPPORTED', string>> = {
  EVENT_TRIGGER: 'เริ่มเมื่อเกิด event',
  SCHEDULE_TRIGGER: 'เริ่มตามตารางเวลา',
  INTERACTION_OUTCOME_TRIGGER: 'เริ่มจากผลการติดต่อ',
  SEGMENT_ENTRY_TRIGGER: 'เริ่มเมื่อเข้า segment',
  SEND: 'ส่งข้อความ',
  WAIT: 'รอ',
  BRANCH: 'แยกตามเงื่อนไข',
  EXIT: 'จบ Journey',
  ENSURE_CASE: 'สร้างหรือผูก Case',
  ADMIT_CAMPAIGN_TARGET: 'เพิ่มเข้า Campaign',
  SCHEDULE_CALLBACK: 'นัดโทรกลับ',
  UNSUPPORTED: 'ขั้นตอนที่ Console รุ่นนี้ไม่รู้จัก',
};

export const PORT_LABELS: Readonly<Record<JourneyPortId, string>> = {
  start: 'เริ่ม',
  in: 'ขาเข้า',
  next: 'ถัดไป',
  true: 'เงื่อนไขเป็นจริง',
  false_or_error: 'เป็นเท็จหรือประเมินไม่ได้',
  accepted: 'สำเร็จ',
  rejected: 'ถูกปฏิเสธ',
};

export type ConfigFieldKind =
  'text' | 'opaque' | 'positive' | 'nonNegative' | 'select' | 'expression' | 'fixed';

export interface ConfigFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: ConfigFieldKind;
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly description?: string;
}

const field = (
  key: string,
  label: string,
  kind: ConfigFieldKind,
  extra: Partial<ConfigFieldSpec> = {},
): ConfigFieldSpec => ({ key, label, kind, required: true, ...extra });

/** field ของ config ตาม registry (#328) — ชื่อ key ตรงกับ validator ฝั่ง server */
export const CONFIG_FIELDS: Readonly<Record<AnyNodeType, readonly ConfigFieldSpec[]>> = {
  EVENT_TRIGGER: [field('eventType', 'ชนิด event', 'text')],
  SCHEDULE_TRIGGER: [
    field('cron', 'Cron expression', 'text'),
    field('timezone', 'Timezone', 'text', { description: 'เช่น Asia/Bangkok' }),
  ],
  INTERACTION_OUTCOME_TRIGGER: [
    field('outcomeType', 'ชนิดผลการติดต่อ', 'select', { options: INTERACTION_OUTCOME_TYPES }),
    field('outcomeCode', 'รหัสผล (ไม่บังคับ)', 'opaque', { required: false }),
    field('coalescingPolicy', 'การรวม event', 'fixed', { options: ['PER_LOGICAL_OUTCOME'] }),
  ],
  SEGMENT_ENTRY_TRIGGER: [
    field('segmentId', 'Segment ID', 'opaque'),
    field('coalescingPolicy', 'การรวม event', 'fixed', { options: ['PER_SEGMENT_ENTRY'] }),
  ],
  SEND: [
    field('channel', 'ช่องทาง', 'select', { options: CONTACT_CHANNELS }),
    field('contentRef', 'Content reference', 'text'),
  ],
  WAIT: [field('waitSeconds', 'ระยะเวลารอ (วินาที)', 'positive')],
  BRANCH: [
    field('expression', 'เงื่อนไข (DC_EXPR JSON)', 'expression', {
      description: 'server ตรวจ expression ตอน validate/compile',
    }),
  ],
  EXIT: [field('reason', 'เหตุผลที่จบ', 'text')],
  ENSURE_CASE: [
    field('caseTypeId', 'Case type', 'opaque'),
    field('routingIntentRef', 'Routing intent', 'opaque'),
    field('targetOwnerTeamId', 'ทีมที่รับผิดชอบ', 'opaque'),
  ],
  ADMIT_CAMPAIGN_TARGET: [
    field('campaignId', 'Campaign ID', 'opaque'),
    field('targetOwnerTeamId', 'ทีมที่รับผิดชอบ', 'opaque'),
  ],
  SCHEDULE_CALLBACK: [
    field('requestedInSeconds', 'โทรกลับในอีก (วินาที)', 'nonNegative'),
    field('queueId', 'Queue ID', 'opaque'),
    field('agentId', 'Agent ID (ไม่บังคับ)', 'opaque', { required: false }),
    field('targetOwnerTeamId', 'ทีมที่รับผิดชอบ', 'opaque'),
  ],
};

export function defaultConfig(type: StepNodeType): Record<string, unknown> {
  switch (type) {
    case 'SEND':
      return { channel: 'LINE', contentRef: '' };
    case 'WAIT':
      return { waitSeconds: 3600 };
    case 'BRANCH':
      return {
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: { type: 'literal', value: true },
        },
      };
    case 'EXIT':
      return { reason: 'COMPLETED' };
    case 'ENSURE_CASE':
      return { caseTypeId: '', routingIntentRef: '', targetOwnerTeamId: '' };
    case 'ADMIT_CAMPAIGN_TARGET':
      return { campaignId: '', targetOwnerTeamId: '' };
    case 'SCHEDULE_CALLBACK':
      return { requestedInSeconds: 0, queueId: '', targetOwnerTeamId: '' };
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

export type SettingKey =
  'name' | 'purpose' | 'senderIdentityId' | 'maxDurationDays' | 'goalEventType';

/**
 * ทุกการแก้เป็น command ที่ replay ได้แบบ deterministic — id ของ node/edge ถูกสร้างก่อนเข้า reducer
 * เพื่อให้ undo/redo และ session recovery ได้ผลเดิมทุกครั้ง
 */
export type AuthoringCommand =
  | {
      readonly kind: 'ADD_NODE';
      readonly nodeId: string;
      readonly nodeType: StepNodeType;
      readonly edgeIds: readonly [string, string];
      /** แทรกต่อจาก port นี้: ถ้า port เคยชี้ไปที่ไหน node ใหม่จะชี้ต่อไปที่นั่น */
      readonly after?: { readonly nodeId: string; readonly portId: JourneyPortId };
    }
  | {
      readonly kind: 'CONNECT';
      readonly edgeId: string;
      readonly source: { readonly nodeId: string; readonly portId: JourneyPortId };
      readonly targetNodeId: string;
    }
  | { readonly kind: 'DISCONNECT'; readonly nodeId: string; readonly portId: JourneyPortId }
  | { readonly kind: 'DELETE_NODE'; readonly nodeId: string }
  | {
      readonly kind: 'SET_CONFIG';
      readonly nodeId: string;
      readonly key: string;
      readonly value: unknown;
    }
  | { readonly kind: 'SET_LABEL'; readonly nodeId: string; readonly label: string }
  | { readonly kind: 'MOVE_NODE'; readonly nodeId: string; readonly x: number; readonly y: number }
  | { readonly kind: 'REORDER'; readonly nodeId: string; readonly direction: 'up' | 'down' }
  | { readonly kind: 'SET_SETTING'; readonly key: SettingKey; readonly value: string | number };

export class AuthoringCommandRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AuthoringCommandRejected';
  }
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function newId(prefix: 'step' | 'edge'): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function isUnsupported(node: DocumentNode): node is AuthoringUnsupportedNodeV1 {
  return node.type === 'UNSUPPORTED';
}

export function nodeTypeOf(
  document: AuthoringDocumentV1,
  nodeId: string,
): AnyNodeType | 'UNSUPPORTED' | undefined {
  if (document.trigger.nodeId === nodeId) return document.trigger.type;
  return document.nodes.find((node) => node.nodeId === nodeId)?.type;
}

export function outputPorts(
  document: AuthoringDocumentV1,
  nodeId: string,
): readonly JourneyPortId[] {
  const type = nodeTypeOf(document, nodeId);
  return !type || type === 'UNSUPPORTED' ? [] : NODE_OUTPUT_PORTS[type];
}

export function edgeFrom(
  document: AuthoringDocumentV1,
  nodeId: string,
  portId: JourneyPortId,
): AuthoringEdgeV1 | undefined {
  return document.edges.find(
    (edge) => edge.source.nodeId === nodeId && edge.source.portId === portId,
  );
}

function withEdges(document: AuthoringDocumentV1, edges: readonly AuthoringEdgeV1[]) {
  return { ...document, edges };
}

function requireEditable(document: AuthoringDocumentV1, nodeId: string) {
  const type = nodeTypeOf(document, nodeId);
  if (!type) throw new AuthoringCommandRejected('NODE_NOT_FOUND');
  if (type === 'UNSUPPORTED') throw new AuthoringCommandRejected('NODE_READ_ONLY');
  return type;
}

function connect(
  document: AuthoringDocumentV1,
  edgeId: string,
  source: { nodeId: string; portId: JourneyPortId },
  targetNodeId: string,
): AuthoringDocumentV1 {
  requireEditable(document, source.nodeId);
  if (!outputPorts(document, source.nodeId).includes(source.portId))
    throw new AuthoringCommandRejected('PORT_INVALID');
  const targetType = nodeTypeOf(document, targetNodeId);
  if (!targetType || targetType === 'UNSUPPORTED' || targetNodeId === document.trigger.nodeId)
    throw new AuthoringCommandRejected('TARGET_INVALID');
  if (targetNodeId === source.nodeId) throw new AuthoringCommandRejected('TARGET_INVALID');
  const kept = document.edges.filter(
    (edge) => !(edge.source.nodeId === source.nodeId && edge.source.portId === source.portId),
  );
  return withEdges(document, [
    ...kept,
    {
      edgeId,
      source: { nodeId: source.nodeId, portId: source.portId },
      target: { nodeId: targetNodeId },
    },
  ]);
}

export function applyCommand(
  document: AuthoringDocumentV1,
  command: AuthoringCommand,
): AuthoringDocumentV1 {
  switch (command.kind) {
    case 'ADD_NODE': {
      if (!OPAQUE_ID.test(command.nodeId) || nodeTypeOf(document, command.nodeId))
        throw new AuthoringCommandRejected('NODE_ID_INVALID');
      const node = {
        nodeId: command.nodeId,
        type: command.nodeType,
        config: defaultConfig(command.nodeType),
      } as AuthoringStepNodeV1;
      const anchor = command.after ? document.layout.nodes[command.after.nodeId] : undefined;
      const lowest = Object.values(document.layout.nodes).reduce(
        (max, point) => Math.max(max, point.y),
        0,
      );
      const position = anchor ? { x: anchor.x, y: anchor.y + 140 } : { x: 80, y: lowest + 140 };
      let next: AuthoringDocumentV1 = {
        ...document,
        nodes: [...document.nodes, node],
        layout: {
          ...document.layout,
          nodes: { ...document.layout.nodes, [command.nodeId]: position },
        },
      };
      if (command.after) {
        const previous = edgeFrom(document, command.after.nodeId, command.after.portId);
        next = connect(next, command.edgeIds[0], command.after, command.nodeId);
        const firstPort = NODE_OUTPUT_PORTS[command.nodeType][0];
        if (previous && firstPort) {
          next = connect(
            next,
            command.edgeIds[1],
            { nodeId: command.nodeId, portId: firstPort },
            previous.target.nodeId,
          );
        }
      }
      return next;
    }
    case 'CONNECT':
      return connect(document, command.edgeId, command.source, command.targetNodeId);
    case 'DISCONNECT':
      requireEditable(document, command.nodeId);
      return withEdges(
        document,
        document.edges.filter(
          (edge) =>
            !(edge.source.nodeId === command.nodeId && edge.source.portId === command.portId),
        ),
      );
    case 'DELETE_NODE': {
      if (command.nodeId === document.trigger.nodeId)
        throw new AuthoringCommandRejected('TRIGGER_REQUIRED');
      // node ที่ไม่รู้จักต้องเก็บ source เดิมไว้ครบ (#328 §10) จึงลบจาก Console ไม่ได้
      requireEditable(document, command.nodeId);
      const { [command.nodeId]: _removed, ...layout } = document.layout.nodes;
      return {
        ...document,
        nodes: document.nodes.filter((node) => node.nodeId !== command.nodeId),
        edges: document.edges.filter(
          (edge) => edge.source.nodeId !== command.nodeId && edge.target.nodeId !== command.nodeId,
        ),
        layout: { ...document.layout, nodes: layout },
      };
    }
    case 'SET_CONFIG': {
      const type = requireEditable(document, command.nodeId);
      const spec = CONFIG_FIELDS[type].find((entry) => entry.key === command.key);
      if (!spec || spec.kind === 'fixed') throw new AuthoringCommandRejected('FIELD_INVALID');
      const update = (config: Record<string, unknown>) => {
        const { [command.key]: _old, ...rest } = config;
        return command.value === undefined ? rest : { ...rest, [command.key]: command.value };
      };
      if (document.trigger.nodeId === command.nodeId) {
        return {
          ...document,
          trigger: {
            ...document.trigger,
            config: update(document.trigger.config as Record<string, unknown>),
          } as AuthoringDocumentV1['trigger'],
        };
      }
      return {
        ...document,
        nodes: document.nodes.map((node) =>
          node.nodeId === command.nodeId && !isUnsupported(node)
            ? ({ ...node, config: update(node.config as Record<string, unknown>) } as DocumentNode)
            : node,
        ),
      };
    }
    case 'SET_LABEL': {
      requireEditable(document, command.nodeId);
      const label = command.label.trim();
      const relabel = <T extends { label?: string }>(node: T): T => {
        const { label: _old, ...rest } = node;
        return (label ? { ...rest, label } : rest) as T;
      };
      if (document.trigger.nodeId === command.nodeId)
        return { ...document, trigger: relabel(document.trigger) };
      return {
        ...document,
        nodes: document.nodes.map((node) =>
          node.nodeId === command.nodeId && !isUnsupported(node) ? relabel(node) : node,
        ),
      };
    }
    case 'MOVE_NODE':
      if (!nodeTypeOf(document, command.nodeId))
        throw new AuthoringCommandRejected('NODE_NOT_FOUND');
      return {
        ...document,
        layout: {
          ...document.layout,
          nodes: {
            ...document.layout.nodes,
            [command.nodeId]: {
              x: Math.max(0, Math.round(command.x)),
              y: Math.max(0, Math.round(command.y)),
            },
          },
        },
      };
    case 'REORDER': {
      const index = document.nodes.findIndex((node) => node.nodeId === command.nodeId);
      const target = command.direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= document.nodes.length) return document;
      const nodes = [...document.nodes];
      [nodes[index], nodes[target]] = [nodes[target]!, nodes[index]!];
      return { ...document, nodes };
    }
    case 'SET_SETTING': {
      const settings = document.settings;
      if (command.key === 'goalEventType')
        return {
          ...document,
          settings: { ...settings, goal: { kind: 'EVENT', eventType: String(command.value) } },
        };
      if (command.key === 'maxDurationDays')
        return { ...document, settings: { ...settings, maxDurationDays: Number(command.value) } };
      return { ...document, settings: { ...settings, [command.key]: String(command.value) } };
    }
  }
}

export function replay(
  base: AuthoringDocumentV1,
  commands: readonly AuthoringCommand[],
): AuthoringDocumentV1 {
  return commands.reduce(applyCommand, base);
}

// ── Projection ──────────────────────────────────────────────────────────────

/**
 * ลำดับเดียวที่ทั้ง canvas (focus ด้วยลูกศร) และ outline ใช้: เดินจาก trigger ตามลำดับ port แล้วต่อด้วย
 * node ที่ยังไม่ถูกเชื่อมตามลำดับใน document — จึงคงที่เมื่อ graph เดิม
 */
export function outlineOrder(document: AuthoringDocumentV1): string[] {
  const order: string[] = [document.trigger.nodeId];
  const seen = new Set(order);
  const queue = [document.trigger.nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const portId of outputPorts(document, current)) {
      const target = edgeFrom(document, current, portId)?.target.nodeId;
      if (target && !seen.has(target) && nodeTypeOf(document, target)) {
        seen.add(target);
        order.push(target);
        queue.push(target);
      }
    }
  }
  for (const node of document.nodes) {
    if (!seen.has(node.nodeId)) order.push(node.nodeId);
  }
  return order;
}

export function nodeTitle(document: AuthoringDocumentV1, nodeId: string): string {
  const node =
    document.trigger.nodeId === nodeId
      ? document.trigger
      : document.nodes.find((entry) => entry.nodeId === nodeId);
  if (!node) return nodeId;
  if (isUnsupported(node as DocumentNode))
    return `${NODE_LABELS.UNSUPPORTED} (${(node as AuthoringUnsupportedNodeV1).sourceType})`;
  const label = (node as { label?: string }).label;
  return label ? label : NODE_LABELS[node.type as AnyNodeType];
}

/** คำใบ้แบบ local เท่านั้น — ไม่ใช้ตัดสิน publish (server เป็นผู้ตัดสิน) */
export function openPorts(
  document: AuthoringDocumentV1,
): Array<{ nodeId: string; portId: JourneyPortId }> {
  const open: Array<{ nodeId: string; portId: JourneyPortId }> = [];
  for (const nodeId of outlineOrder(document)) {
    for (const portId of outputPorts(document, nodeId)) {
      if (!edgeFrom(document, nodeId, portId)) open.push({ nodeId, portId });
    }
  }
  return open;
}

export function changedNodeIds(before: AuthoringDocumentV1, after: AuthoringDocumentV1): string[] {
  const serialize = (document: AuthoringDocumentV1, nodeId: string) =>
    JSON.stringify([
      document.trigger.nodeId === nodeId
        ? document.trigger
        : document.nodes.find((node) => node.nodeId === nodeId),
      document.edges.filter((edge) => edge.source.nodeId === nodeId),
    ]);
  const ids = new Set([...outlineOrder(before), ...outlineOrder(after)]);
  return [...ids].filter((nodeId) => serialize(before, nodeId) !== serialize(after, nodeId));
}

// ── Error presentation ──────────────────────────────────────────────────────

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  JOURNEY_NOT_FOUND: 'ไม่พบ Journey นี้ หรือคุณไม่มีสิทธิ์เห็น',
  TEMPLATE_NOT_FOUND: 'ไม่พบ template นี้ หรือคุณไม่มีสิทธิ์เห็น',
  CAPABILITY_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ทำคำสั่งนี้',
  DRAFT_VERSION_CONFLICT: 'ฉบับร่างถูกแก้โดยผู้อื่นแล้ว',
  PUBLISHED_HEAD_CONFLICT: 'Journey ถูกเปลี่ยนสถานะหรือแก้ไขไปแล้ว',
  IDEMPOTENCY_CONFLICT: 'คำสั่งนี้เคยถูกส่งด้วยข้อมูลอื่นแล้ว',
  REVIEW_CANDIDATE_STALE: 'ชุดที่ส่งตรวจไม่ตรงกับฉบับร่างล่าสุดแล้ว',
  APPROVAL_REQUIRED: 'ยังไม่มีผู้อนุมัติอิสระ',
  APPROVAL_SELF_FORBIDDEN: 'ผู้ส่งตรวจอนุมัติงานของตัวเองไม่ได้',
  APPROVAL_STALE: 'สิทธิ์ของผู้อนุมัติเปลี่ยนไปแล้ว ต้องขออนุมัติใหม่',
  COMPILE_ARTIFACT_STALE: 'ผล compile เก่าแล้ว ให้ compile ใหม่',
  DEFINITION_INVALID: 'ฉบับร่างยังมีข้อผิดพลาดที่ต้องแก้ก่อน',
  AUTHORING_SCHEMA_INVALID: 'โครงสร้างฉบับร่างไม่ถูกต้อง',
  JOURNEY_LIFECYCLE_CONFLICT: 'สถานะของ Journey ไม่อนุญาตคำสั่งนี้',
  DEPENDENCY_UNAVAILABLE: 'ฟีเจอร์นี้ยังไม่เปิดสำหรับ tenant หรือระบบปลายทางไม่พร้อม',
  REQUEST_MALFORMED: 'ข้อมูลที่ส่งไม่ครบหรือรูปแบบไม่ถูกต้อง',
  TEMPLATE_DIGEST_MISMATCH: 'template ถูกเปลี่ยนไปแล้ว ให้เปิดใหม่',
  TEMPLATE_PARAMETER_REQUIRED: 'ยังกรอก parameter ที่จำเป็นไม่ครบ',
  TEMPLATE_PARAMETER_INVALID: 'ค่าของ parameter ไม่ถูกต้อง',
  TEMPLATE_REFERENCE_UNTRUSTED: 'reference ที่ระบุไม่มีอยู่ใน tenant นี้',
  TEMPLATE_DEPRECATED: 'template นี้เลิกใช้แล้ว',
  TEMPLATE_UPGRADE_STALE: 'ฉบับร่างเปลี่ยนไปหลังตรวจ upgrade ให้ตรวจใหม่',
  TEMPLATE_UPGRADE_CONFLICT: 'ยังมี conflict ที่ต้องเลือกวิธีแก้',
  PUBLISH_OUTCOME_UNKNOWN: 'ยังไม่ทราบผล publish ให้ตรวจผลด้วยคำสั่งเดิม',
};

export function errorMessage(code: string | undefined): string {
  return (code && ERROR_MESSAGES[code]) ?? 'คำสั่งไม่สำเร็จ ลองอีกครั้งหรือติดต่อผู้ดูแล';
}

/** ฉบับร่างเริ่มต้นที่ server บันทึกได้: trigger แบบ event ต่อไปที่ EXIT — รายละเอียดที่เหลือแก้ต่อใน editor */
export function blankDocument(input: {
  name: string;
  eventType: string;
  senderIdentityId: string;
  purpose: string;
}): AuthoringDocumentV1 {
  return {
    schemaVersion: 'J5_AUTHORING_V1',
    registryVersion: 'J5_PALETTE_V1',
    trigger: { nodeId: 'trigger', type: 'EVENT_TRIGGER', config: { eventType: input.eventType } },
    nodes: [{ nodeId: 'done', type: 'EXIT', config: { reason: 'COMPLETED' } }],
    edges: [
      {
        edgeId: 'edge-start',
        source: { nodeId: 'trigger', portId: 'start' },
        target: { nodeId: 'done' },
      },
    ],
    settings: {
      name: input.name,
      purpose: input.purpose,
      senderIdentityId: input.senderIdentityId,
      goal: { kind: 'EVENT', eventType: input.eventType },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 30,
    },
    layout: { nodes: { trigger: { x: 80, y: 40 }, done: { x: 80, y: 180 } } },
  };
}
