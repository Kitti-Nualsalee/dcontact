/**
 * J5.6 (#344): Console-side model of Journey authoring (Phase Spec #337 §8)
 *
 * - the document being edited is not the system's truth: it is always `server snapshot + command log`; the canvas and
 *   outline send the same commands into one reducer, so there is no hidden state between the two views
 * - node/port constants mirror `@d-contact/cxa-contracts` (the contracts index pulls in node:crypto,
 *   which cannot be bundled for the browser) — a unit test pins them to match the contracts exactly
 * - local checks are only hints for the user; validate/compile/publish are decided at the server only
 */
import { appI18n } from '../i18n/index.js';
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

/** output ports in display order; every port can connect to a single target (runtime field is a scalar) */
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

/**
 * D1.14 (#453): model text comes from the `journeys` catalog — read through a getter every time, so the current language is used
 * when a component re-renders after a language switch, while callers keep using `NODE_LABELS[type]` as before
 */
export function journeyText(key: string, options?: Record<string, unknown>): string {
  return (appI18n.t as unknown as (key: string, options?: Record<string, unknown>) => string)(
    `journeys:${key}`,
    options,
  );
}

function localizedLabels<K extends string>(
  prefix: string,
  keys: readonly K[],
): Readonly<Record<K, string>> {
  const labels = {} as Record<K, string>;
  for (const key of keys) {
    Object.defineProperty(labels, key, {
      enumerable: true,
      get: () => journeyText(`${prefix}.${key}`),
    });
  }
  return Object.freeze(labels);
}

export const NODE_LABELS: Readonly<Record<AnyNodeType | 'UNSUPPORTED', string>> = localizedLabels(
  'node',
  [
    'EVENT_TRIGGER',
    'SCHEDULE_TRIGGER',
    'INTERACTION_OUTCOME_TRIGGER',
    'SEGMENT_ENTRY_TRIGGER',
    'SEND',
    'WAIT',
    'BRANCH',
    'EXIT',
    'ENSURE_CASE',
    'ADMIT_CAMPAIGN_TARGET',
    'SCHEDULE_CALLBACK',
    'UNSUPPORTED',
  ] as const,
);

export const PORT_LABELS: Readonly<Record<JourneyPortId, string>> = localizedLabels('port', [
  'start',
  'in',
  'next',
  'true',
  'false_or_error',
  'accepted',
  'rejected',
] as const);

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

/** label/description come from the catalog (`field.<key>`, `field.<key>Hint`) through getters — language follows the user */
const field = (
  key: string,
  kind: ConfigFieldKind,
  extra: Partial<Pick<ConfigFieldSpec, 'required' | 'options'>> & { hint?: boolean } = {},
): ConfigFieldSpec => {
  const spec = {
    key,
    kind,
    required: extra.required ?? true,
    options: extra.options,
  } as ConfigFieldSpec;
  Object.defineProperty(spec, 'label', {
    enumerable: true,
    get: () => journeyText(`field.${key}`),
  });
  if (extra.hint) {
    Object.defineProperty(spec, 'description', {
      enumerable: true,
      get: () => journeyText(`field.${key}Hint`),
    });
  }
  return Object.freeze(spec);
};

/** config fields per the registry (#328) — key names match the server-side validator */
export const CONFIG_FIELDS: Readonly<Record<AnyNodeType, readonly ConfigFieldSpec[]>> = {
  EVENT_TRIGGER: [field('eventType', 'text')],
  SCHEDULE_TRIGGER: [field('cron', 'text'), field('timezone', 'text', { hint: true })],
  INTERACTION_OUTCOME_TRIGGER: [
    field('outcomeType', 'select', { options: INTERACTION_OUTCOME_TYPES }),
    field('outcomeCode', 'opaque', { required: false }),
    field('coalescingPolicy', 'fixed', { options: ['PER_LOGICAL_OUTCOME'] }),
  ],
  SEGMENT_ENTRY_TRIGGER: [
    field('segmentId', 'opaque'),
    field('coalescingPolicy', 'fixed', { options: ['PER_SEGMENT_ENTRY'] }),
  ],
  SEND: [field('channel', 'select', { options: CONTACT_CHANNELS }), field('contentRef', 'text')],
  WAIT: [field('waitSeconds', 'positive')],
  BRANCH: [field('expression', 'expression', { hint: true })],
  EXIT: [field('reason', 'text')],
  ENSURE_CASE: [
    field('caseTypeId', 'opaque'),
    field('routingIntentRef', 'opaque'),
    field('targetOwnerTeamId', 'opaque'),
  ],
  ADMIT_CAMPAIGN_TARGET: [field('campaignId', 'opaque'), field('targetOwnerTeamId', 'opaque')],
  SCHEDULE_CALLBACK: [
    field('requestedInSeconds', 'nonNegative'),
    field('queueId', 'opaque'),
    field('agentId', 'opaque', { required: false }),
    field('targetOwnerTeamId', 'opaque'),
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
 * Every edit is a command that replays deterministically — node/edge ids are generated before entering the reducer
 * so undo/redo and session recovery always produce the same result
 */
export type AuthoringCommand =
  | {
      readonly kind: 'ADD_NODE';
      readonly nodeId: string;
      readonly nodeType: StepNodeType;
      readonly edgeIds: readonly [string, string];
      /** insert after this port: if the port pointed somewhere, the new node then points there */
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
      // an unknown node must keep its original source intact (#328 §10), so it cannot be deleted from Console
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
 * The single order used by both the canvas (arrow-key focus) and the outline: walk from the trigger in port order, then continue with
 * nodes not yet connected in document order — so it is stable for the same graph
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

/** local hints only — not used to decide publish (the server decides) */
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

/** messages for the closed set of error codes from the server — an unknown code gets a generic message (catalog `error.*`) */
export function errorMessage(code: string | undefined): string {
  return code && appI18n.exists(`journeys:error.${code}`)
    ? journeyText(`error.${code}`)
    : journeyText('error.fallback');
}

/** initial draft the server can save: an event trigger leading to EXIT — the rest is edited in the editor */
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
