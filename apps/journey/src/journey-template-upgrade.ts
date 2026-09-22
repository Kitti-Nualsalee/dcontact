import {
  JOURNEY_NODE_PORTS,
  JOURNEY_TEMPLATE_BLOCKING_CONFLICT_KINDS,
  type AuthoringDocumentV1,
  type AuthoringEdgeV1,
  type AuthoringStepNodeV1,
  type JourneyPortId,
  type JourneyTemplateConflictKind,
  type JourneyTemplateConflictResolution,
  type JourneyTemplateConflictV1,
  type JourneyTemplateContentV1,
  type JourneyTemplateUpgradeProposalV1,
} from '@d-contact/cxa-contracts';
import {
  canonicalJourneyJson,
  compareText,
  journeyAuthoringDigest,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import { deriveTemplateNodeId, validateTemplatePackage } from './journey-template-binder.js';

/**
 * J5.4 (#342): explicit three-way upgrade (คำตัดสิน #330 §10, Phase Spec §7)
 *
 * base = template version ที่ instance ใช้, remote = template version เป้าหมาย, local = draft ปัจจุบัน
 * จับคู่ด้วย `templateNodeKey` เท่านั้น (ห้าม fuzzy match ชื่อ) แล้วเทียบทีละ field/port:
 * - template ไม่เปลี่ยน → คงค่า local; local ไม่เปลี่ยน → ใช้ค่า template
 * - ทั้งสองฝั่งแก้ต่างกัน → conflict ที่ต้องเลือก KEEP_LOCAL / TAKE_TEMPLATE อย่าง explicit
 * - field ที่ bind ด้วย parameter คงค่าของ tenant ไว้เสมอ (template มีแค่ placeholder)
 * ผลลัพธ์เป็น deterministic: input เดิมได้ proposal/digest เดิมทุกครั้ง และ apply สร้าง draft revision
 * ใหม่เท่านั้น — ไม่ publish, ไม่ activate และไม่มี background merge
 */

type Fields = Record<string, unknown>;
interface Entity {
  readonly type: string;
  readonly fields: Fields;
}

const BLOCKING: ReadonlySet<string> = new Set(JOURNEY_TEMPLATE_BLOCKING_CONFLICT_KINDS);
const LOCAL_ONLY_SETTINGS = new Set(['name']);
const same = (left: unknown, right: unknown) =>
  canonicalJourneyJson(left) === canonicalJourneyJson(right);

function portsOf(type: string): Record<string, string> {
  return (JOURNEY_NODE_PORTS[type as keyof typeof JOURNEY_NODE_PORTS]?.outputs ?? {}) as Record<
    string,
    string
  >;
}

/** entity ของเอกสาร: step ตาม key, `@trigger`, `@settings`; port เก็บเป็น field `port:<id>` ที่ชี้ key ปลายทาง */
function entities(
  document: AuthoringDocumentV1,
  keyOfNode: (nodeId: string) => string | undefined,
): Map<string, Entity> {
  const result = new Map<string, Entity>();
  const outgoing = new Map<string, Fields>();
  for (const edge of document.edges) {
    const key = keyOfNode(edge.source.nodeId);
    if (!key) continue;
    const fields = outgoing.get(key) ?? {};
    fields[`port:${edge.source.portId}`] =
      keyOfNode(edge.target.nodeId) ?? `local:${edge.target.nodeId}`;
    outgoing.set(key, fields);
  }
  result.set('@trigger', {
    type: document.trigger.type,
    fields: { ...(document.trigger.config as unknown as Fields), ...outgoing.get('@trigger') },
  });
  result.set('@settings', {
    type: 'SETTINGS',
    fields: { ...(document.settings as unknown as Fields) },
  });
  for (const node of document.nodes as AuthoringStepNodeV1[]) {
    const key = keyOfNode(node.nodeId);
    if (!key) continue;
    result.set(key, {
      type: node.type,
      fields: { ...(node.config as unknown as Fields), ...outgoing.get(key) },
    });
  }
  return result;
}

function templateEntities(content: JourneyTemplateContentV1) {
  const keys = new Map<string, string>([[content.document.trigger.nodeId, '@trigger']]);
  for (const node of content.document.nodes as AuthoringStepNodeV1[])
    keys.set(node.nodeId, node.templateNodeKey!);
  return entities(content.document, (nodeId) => keys.get(nodeId));
}

/** field ที่ bind ด้วย parameter → parameterKey */
function boundFields(content: JourneyTemplateContentV1) {
  const bound = new Map<string, string>();
  for (const parameter of content.parameterSchema) {
    for (const target of parameter.bindTargets) {
      bound.set(
        `${target.templateNodeKey}|${target.pointer.slice('/config/'.length)}`,
        parameter.parameterKey,
      );
    }
  }
  return bound;
}

export interface TemplateUpgradeInput {
  readonly journeyId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly base: JourneyTemplateContentV1;
  readonly target: JourneyTemplateContentV1;
  readonly local: AuthoringDocumentV1;
  /** provenance: templateNodeKey → journey nodeId */
  readonly nodeMapping: Readonly<Record<string, string>>;
  readonly capabilities: readonly JourneyRuntimeCapability[];
}

interface Merge {
  readonly proposal: JourneyTemplateUpgradeProposalV1;
  /** ค่าที่แต่ละ conflict จะได้ตามทางเลือก */
  readonly choices: ReadonlyMap<
    string,
    { readonly apply: (choice: JourneyTemplateConflictResolution) => void }
  >;
  readonly build: () => { document: AuthoringDocumentV1; nodeMapping: Record<string, string> };
}

function merge(input: TemplateUpgradeInput): Merge {
  const mapping: Record<string, string> = { ...input.nodeMapping };
  const keyOfLocal = new Map(Object.entries(mapping).map(([key, nodeId]) => [nodeId, key]));
  const base = templateEntities(input.base);
  const target = templateEntities(input.target);
  const local = entities(input.local, (nodeId) =>
    nodeId === input.local.trigger.nodeId ? '@trigger' : keyOfLocal.get(nodeId),
  );
  const boundBase = boundFields(input.base);
  const boundTarget = boundFields(input.target);
  const conflicts: JourneyTemplateConflictV1[] = [];
  const choices = new Map<string, { apply: (choice: JourneyTemplateConflictResolution) => void }>();
  const result = new Map<string, { type: string; fields: Fields } | null>();

  const conflict = (
    kind: JourneyTemplateConflictKind,
    key: string,
    field: string | undefined,
    apply?: (choice: JourneyTemplateConflictResolution) => void,
  ) => {
    const conflictId = `${kind}:${key}${field ? `:${field}` : ''}`;
    conflicts.push({
      conflictId,
      kind,
      templateNodeKey: key,
      ...(mapping[key] ? { nodeId: mapping[key] } : {}),
      ...(field ? { field } : {}),
    });
    if (apply) choices.set(conflictId, { apply });
  };

  // package ปลายทางต้องผ่านกติกาเดียวกับตอน publish — node/capability ที่ไม่รู้จัก block ทั้ง upgrade
  if (validateTemplatePackage(input.target, input.capabilities).length > 0) {
    conflict('UNKNOWN_NODE_OR_CAPABILITY', '@package', undefined);
  }

  const keys = [...new Set([...base.keys(), ...target.keys()])].sort(compareText);
  for (const key of keys) {
    const b = base.get(key);
    const t = target.get(key);
    const l = local.get(key);
    if (!mapping[key] && key !== '@settings')
      mapping[key] =
        key === '@trigger'
          ? input.local.trigger.nodeId
          : deriveTemplateNodeId(input.journeyId, key);

    if (b && !t) {
      // template ลบ node: local ที่ไม่ได้แตะลบตามได้; ถ้า local แก้ไว้ต้องเลือกเอง
      if (!l) continue;
      if (same(l.fields, b.fields) || nodeUnchangedExceptBound(l, b, key, boundBase)) {
        result.set(key, null);
      } else {
        result.set(key, { type: l.type, fields: { ...l.fields } });
        conflict('NODE_REMOVED_BUT_EDITED', key, undefined, (choice) => {
          result.set(
            key,
            choice === 'TAKE_TEMPLATE' ? null : { type: l.type, fields: { ...l.fields } },
          );
        });
      }
      continue;
    }
    if (!b && t) {
      // node ใหม่จาก template: field ที่ bind ต้องมีค่าจาก binding เดิมหรือ default
      const fields: Fields = {};
      for (const [field, value] of Object.entries(t.fields)) {
        const parameterKey = boundTarget.get(`${key}|${field}`);
        fields[field] = parameterKey ? boundValue(parameterKey, key, field, value) : value;
      }
      result.set(key, { type: t.type, fields });
      continue;
    }
    if (!b || !t) continue;
    if (!l) {
      // ผู้ใช้ลบ node เอง: template ไม่เปลี่ยนก็ลบต่อ, template แก้ต้องเลือกเอง
      if (!same(b, t)) {
        result.set(key, null);
        conflict('NODE_REMOVED_BUT_EDITED', key, undefined, (choice) => {
          result.set(
            key,
            choice === 'TAKE_TEMPLATE' ? { type: t.type, fields: { ...t.fields } } : null,
          );
        });
      }
      continue;
    }
    const fields: Fields = {};
    const names = [
      ...new Set([...Object.keys(b.fields), ...Object.keys(t.fields), ...Object.keys(l.fields)]),
    ].sort(compareText);
    for (const field of names) {
      const slot = `${key}|${field}`;
      if (key === '@settings' && LOCAL_ONLY_SETTINGS.has(field)) {
        fields[field] = l.fields[field];
      } else if (boundTarget.has(slot) && boundBase.get(slot) === boundTarget.get(slot)) {
        fields[field] =
          l.fields[field] ?? boundValue(boundTarget.get(slot)!, key, field, t.fields[field]);
      } else if (boundBase.has(slot) || boundTarget.has(slot)) {
        // binding ถูกลบ/เปลี่ยน parameter — คงค่า tenant ได้เท่านั้น ไม่เอา placeholder ของ template มาใส่
        fields[field] = l.fields[field];
        conflict('PARAMETER_BREAKING', key, field, (choice) => {
          if (choice === 'TAKE_TEMPLATE')
            throw new TemplateUpgradeConflictError([`PARAMETER_BREAKING:${key}:${field}`]);
        });
      } else {
        const [bv, tv, lv] = [b.fields[field], t.fields[field], l.fields[field]];
        if (same(tv, bv) || same(lv, tv)) fields[field] = lv;
        else if (same(lv, bv)) fields[field] = tv;
        else {
          fields[field] = lv;
          const current = fields;
          conflict(
            field.startsWith('port:') ? 'EDGE_CHANGED_BOTH' : 'FIELD_CHANGED_BOTH',
            key,
            field,
            (choice) => {
              current[field] = choice === 'TAKE_TEMPLATE' ? tv : lv;
            },
          );
        }
      }
      if (fields[field] === undefined) delete fields[field];
    }
    result.set(key, { type: l.type === b.type && b.type !== t.type ? t.type : l.type, fields });
  }

  // parameter ใหม่ที่ required และไม่มี default แต่ไม่มีค่าเดิมให้ใช้ต่อ → block
  function boundValue(parameterKey: string, key: string, field: string, placeholder: unknown) {
    for (const [slot, existing] of boundBase) {
      if (existing !== parameterKey) continue;
      const [otherKey, otherField] = slot.split('|') as [string, string];
      const value = local.get(otherKey)?.fields[otherField];
      if (value !== undefined) return value;
    }
    const parameter = input.target.parameterSchema.find(
      (item) => item.parameterKey === parameterKey,
    );
    if (parameter && 'default' in parameter && parameter.default !== undefined)
      return parameter.default;
    conflict('PARAMETER_REQUIRED_UNBOUND', key, field);
    return placeholder;
  }

  const visualOnly =
    same(stripVisual(input.base.document), stripVisual(input.target.document)) &&
    same(input.base.parameterSchema, input.target.parameterSchema);

  const build = () => {
    const document = structuredClone(input.local) as AuthoringDocumentV1 & {
      nodes: AuthoringStepNodeV1[];
      edges: AuthoringEdgeV1[];
    };
    const idOf = (value: unknown) =>
      typeof value === 'string' && value.startsWith('local:')
        ? value.slice('local:'.length)
        : mapping[String(value)];
    const trigger = result.get('@trigger') ?? local.get('@trigger')!;
    const settings = result.get('@settings') ?? local.get('@settings')!;
    const configOf = (entity: { fields: Fields }) =>
      Object.fromEntries(
        Object.entries(entity.fields).filter(([field]) => !field.startsWith('port:')),
      );

    const triggerId = document.trigger.nodeId;
    const nodes: AuthoringStepNodeV1[] = [];
    const keyed = new Set<string>();
    for (const node of input.local.nodes as AuthoringStepNodeV1[]) {
      const key = keyOfLocal.get(node.nodeId);
      if (!key || !result.has(key)) {
        nodes.push(node);
        continue;
      }
      keyed.add(key);
      const entity = result.get(key);
      if (entity)
        nodes.push({ ...node, type: entity.type, config: configOf(entity) } as AuthoringStepNodeV1);
    }
    for (const [key, entity] of [...result.entries()].sort(([a], [b]) => compareText(a, b))) {
      if (!entity || keyed.has(key) || key.startsWith('@') || local.has(key)) continue;
      nodes.push({
        nodeId: mapping[key]!,
        type: entity.type,
        templateNodeKey: key,
        config: configOf(entity),
      } as AuthoringStepNodeV1);
    }
    const present = new Set([triggerId, ...nodes.map((node) => node.nodeId)]);
    const keyedIds = new Set(
      [...result.keys()].filter((key) => key !== '@settings').map((key) => mapping[key]),
    );
    const edges: AuthoringEdgeV1[] = document.edges.filter(
      (edge) =>
        !keyedIds.has(edge.source.nodeId) &&
        present.has(edge.source.nodeId) &&
        present.has(edge.target.nodeId),
    );
    for (const [key, entity] of result) {
      if (!entity || key === '@settings') continue;
      const nodeId = mapping[key]!;
      for (const portId of Object.keys(portsOf(entity.type))) {
        const targetId = idOf(entity.fields[`port:${portId}`]);
        if (targetId && present.has(targetId)) {
          edges.push({
            edgeId: `${nodeId}.${portId}`,
            source: { nodeId, portId: portId as JourneyPortId },
            target: { nodeId: targetId },
          });
        }
      }
    }
    const nodeMapping = Object.fromEntries(
      Object.entries(mapping).filter(([key, nodeId]) => key !== '@settings' && present.has(nodeId)),
    );
    return {
      document: {
        ...document,
        trigger: {
          ...document.trigger,
          type: trigger.type,
          config: configOf(trigger),
        } as AuthoringDocumentV1['trigger'],
        nodes,
        edges: edges.sort((left, right) => compareText(left.edgeId, right.edgeId)),
        settings: configOf(settings) as unknown as AuthoringDocumentV1['settings'],
        layout: {
          ...document.layout,
          nodes: Object.fromEntries(
            [...present]
              .sort(compareText)
              .map((nodeId, index) => [
                nodeId,
                document.layout.nodes[nodeId] ?? { x: 240 * index, y: 240 },
              ]),
          ),
        },
      } as AuthoringDocumentV1,
      nodeMapping,
    };
  };

  const sorted = conflicts.sort((left, right) => compareText(left.conflictId, right.conflictId));
  const provisional = build();
  const conflictDigest = journeyAuthoringDigest(sorted);
  const withoutDigest = {
    journeyId: input.journeyId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    baseDraftDigest: journeyAuthoringDigest(input.base.document),
    localDraftDigest: journeyAuthoringDigest(input.local),
    proposedDocument: provisional.document,
    nodeMapping: provisional.nodeMapping,
    conflicts: sorted,
    visualOnly,
    conflictDigest,
  };
  return {
    proposal: { ...withoutDigest, proposalDigest: journeyAuthoringDigest(withoutDigest) },
    choices,
    build,
  };
}

function nodeUnchangedExceptBound(
  local: Entity,
  base: Entity,
  key: string,
  bound: Map<string, string>,
) {
  return Object.keys({ ...local.fields, ...base.fields }).every(
    (field) => bound.has(`${key}|${field}`) || same(local.fields[field], base.fields[field]),
  );
}

function stripVisual(document: AuthoringDocumentV1) {
  return {
    trigger: { type: document.trigger.type, config: document.trigger.config },
    nodes: (document.nodes as AuthoringStepNodeV1[])
      .map((node) => ({ key: node.templateNodeKey, type: node.type, config: node.config }))
      .sort((left, right) => compareText(String(left.key), String(right.key))),
    edges: document.edges
      .map((edge) => `${edge.source.nodeId}.${edge.source.portId}>${edge.target.nodeId}`)
      .sort(compareText),
    settings: document.settings,
  };
}

export class TemplateUpgradeConflictError extends Error {
  readonly code = 'TEMPLATE_UPGRADE_CONFLICT' as const;

  constructor(readonly conflictIds: readonly string[]) {
    super(`template upgrade มี conflict ที่ยังไม่ได้เลือก: ${conflictIds.join(', ')}`);
    this.name = 'TemplateUpgradeConflictError';
  }
}

export class TemplateUpgradeStaleError extends Error {
  readonly code = 'TEMPLATE_UPGRADE_STALE' as const;

  constructor() {
    super('proposal/conflict digest ไม่ตรงกับสถานะปัจจุบัน');
    this.name = 'TemplateUpgradeStaleError';
  }
}

/** read-only: คำนวณ proposal แบบ deterministic */
export function checkTemplateUpgrade(
  input: TemplateUpgradeInput,
): JourneyTemplateUpgradeProposalV1 {
  return merge(input).proposal;
}

/**
 * apply ได้เมื่อ proposal/conflict digest ยังตรงกับที่ผู้ใช้เห็น และทุก conflict มีทางเลือก explicit;
 * conflict ชนิด block ต้องแก้ต้นทาง (bind/instantiate ใหม่) ก่อน
 */
export function applyTemplateUpgrade(
  input: TemplateUpgradeInput,
  expected: {
    readonly proposalDigest: string;
    readonly conflictDigest: string;
    readonly resolutions: Readonly<Record<string, JourneyTemplateConflictResolution>>;
  },
): { readonly document: AuthoringDocumentV1; readonly nodeMapping: Record<string, string> } {
  const merged = merge(input);
  if (
    merged.proposal.proposalDigest !== expected.proposalDigest ||
    merged.proposal.conflictDigest !== expected.conflictDigest
  ) {
    throw new TemplateUpgradeStaleError();
  }
  const unresolved = merged.proposal.conflicts
    .filter((item) => BLOCKING.has(item.kind) || !expected.resolutions[item.conflictId])
    .map((item) => item.conflictId);
  if (unresolved.length > 0) throw new TemplateUpgradeConflictError(unresolved);
  for (const item of merged.proposal.conflicts) {
    merged.choices.get(item.conflictId)?.apply(expected.resolutions[item.conflictId]!);
  }
  return merged.build();
}
