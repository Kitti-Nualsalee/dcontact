import {
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  JOURNEY_RESTRICTED_NODE_TYPES,
  JOURNEY_TEMPLATE_RESERVED_NODE_KEYS,
  JOURNEY_TEMPLATE_SCHEMA_VERSION,
  isJourneyTemplateBindPointer,
  isJourneyTemplateParameterType,
  isJourneyTemplateResourceKind,
  sortJourneyDiagnostics,
  type AuthoringDocumentV1,
  type AuthoringStepNodeV1,
  type JourneyAuthoringErrorCode,
  type JourneyDiagnosticPathV1,
  type JourneyDiagnosticV1,
  type JourneyTemplateContentV1,
  type JourneyTemplateParameterV1,
  type JourneyTemplateParameterValue,
} from '@d-contact/cxa-contracts';
import {
  RESTRICTED_NODE_CAPABILITY,
  capabilityAvailable,
  compareText,
  journeyAuthoringDigest,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import { validateAuthoringDocument } from './journey-authoring-validator.js';

/**
 * J5.4 (#342): closed parameter binder ของ template (คำตัดสิน #330 §4–§7)
 *
 * - template เป็น package ที่ต้อง instantiate เป็น Journey draft ใหม่เท่านั้น ไม่มี live pointer
 * - reference เฉพาะ tenant ทุกช่องต้องมาทาง parameter — ช่องที่ฝังค่าไว้ใน graph ถือว่าไม่น่าเชื่อถือ
 * - ค่า parameter ถูกตรวจตามชนิดแบบปิดชุด; literal ห้ามเป็น PII/ข้อความรูปแบบ credential
 * - node ID ของ instance derive แบบ deterministic จาก journeyId + templateNodeKey จึงไม่ชนข้าม Journey
 */

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,127}$/;
const CRON = /^(\S+\s+){4}\S+$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\d[\d\s-]{7,}\d)/;
const RESERVED: ReadonlySet<string> = new Set(JOURNEY_TEMPLATE_RESERVED_NODE_KEYS);
const RESTRICTED: ReadonlySet<string> = new Set(JOURNEY_RESTRICTED_NODE_TYPES);
const PARAMETER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  BOOLEAN: ['default'],
  INTEGER: ['min', 'max', 'default'],
  DURATION_SECONDS: ['min', 'max', 'default'],
  ENUM: ['values', 'default'],
  CANONICAL_EVENT_TYPE: ['default'],
  TIMEZONE: ['default'],
  CRON: ['default'],
  OPAQUE_RESOURCE_REF: ['resourceKind'],
  SAFE_LITERAL: ['maxLength', 'pattern', 'default'],
};
const COMMON_FIELDS = [
  'parameterKey',
  'labelKey',
  'descriptionKey',
  'type',
  'required',
  'bindTargets',
];

/** ช่องที่เป็น reference ของ tenant — ต้องถูก bind ด้วย parameter เสมอ (#330 §4) */
const REFERENCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  '@settings': ['senderIdentityId'],
  SEGMENT_ENTRY_TRIGGER: ['segmentId'],
  SEND: ['contentRef'],
  ENSURE_CASE: ['caseTypeId', 'routingIntentRef', 'targetOwnerTeamId'],
  ADMIT_CAMPAIGN_TARGET: ['campaignId', 'targetOwnerTeamId'],
  SCHEDULE_CALLBACK: ['queueId', 'agentId', 'targetOwnerTeamId'],
};

type Json = Record<string, unknown>;

const diagnostic = (
  code: JourneyAuthoringErrorCode,
  path?: JourneyDiagnosticPathV1,
  safeParams?: Record<string, string | number | boolean>,
): JourneyDiagnosticV1 => ({
  code,
  severity: 'ERROR',
  stage: 'AUTHORING',
  messageKey: `journey.template.${code}`,
  ...(path ? { path } : {}),
  ...(safeParams ? { safeParams } : {}),
});

/** node ที่ bind target อ้างถึง: step node ตาม templateNodeKey, `@trigger` หรือ `@settings` */
function targetSlot(document: AuthoringDocumentV1, templateNodeKey: string): Json | undefined {
  if (templateNodeKey === '@settings') return document.settings as unknown as Json;
  if (templateNodeKey === '@trigger') return document.trigger.config as unknown as Json;
  const node = document.nodes.find(
    (candidate) => 'templateNodeKey' in candidate && candidate.templateNodeKey === templateNodeKey,
  ) as AuthoringStepNodeV1 | undefined;
  return node?.config as unknown as Json | undefined;
}

const fieldOf = (pointer: string) => pointer.slice('/config/'.length);

/** ตรวจ package ทั้งชุดก่อน publish/instantiate — built-in และ tenant ใช้กติกาเดียวกัน */
export function validateTemplatePackage(
  content: unknown,
  capabilities: readonly JourneyRuntimeCapability[],
): JourneyDiagnosticV1[] {
  const out: JourneyDiagnosticV1[] = [];
  const value = content as Partial<JourneyTemplateContentV1> | null;
  if (
    !value ||
    value.templateSchemaVersion !== JOURNEY_TEMPLATE_SCHEMA_VERSION ||
    value.authoringSchemaVersion !== JOURNEY_AUTHORING_SCHEMA_VERSION ||
    value.registryVersion !== JOURNEY_AUTHORING_REGISTRY_VERSION ||
    !Array.isArray(value.parameterSchema) ||
    !Array.isArray(value.requiredCapabilities)
  ) {
    return [diagnostic('TEMPLATE_PACKAGE_UNTRUSTED')];
  }
  const document = value.document as AuthoringDocumentV1;
  const schema = validateAuthoringDocument(document, { capabilities }).filter((item) =>
    [
      'AUTHORING_SCHEMA_INVALID',
      'NODE_FIELD_UNKNOWN',
      'COMPILER_VERSION_UNSUPPORTED',
      'NODE_TYPE_UNSUPPORTED',
    ].includes(item.code),
  );
  if (schema.length > 0)
    return sortJourneyDiagnostics([diagnostic('TEMPLATE_PACKAGE_UNTRUSTED'), ...schema]);

  const keys = new Set<string>();
  for (const node of document.nodes as AuthoringStepNodeV1[]) {
    if (
      !node.templateNodeKey ||
      RESERVED.has(node.templateNodeKey) ||
      keys.has(node.templateNodeKey)
    ) {
      out.push(
        diagnostic('TEMPLATE_PROVENANCE_INVALID', {
          nodeId: node.nodeId,
          field: 'templateNodeKey',
        }),
      );
    }
    if (node.templateNodeKey) keys.add(node.templateNodeKey);
    if (
      RESTRICTED.has(node.type) &&
      !capabilityAvailable(capabilities, RESTRICTED_NODE_CAPABILITY)
    ) {
      out.push(
        diagnostic('TEMPLATE_CAPABILITY_UNAVAILABLE', { templateNodeKey: node.templateNodeKey }),
      );
    }
  }

  const bound = new Set<string>();
  const parameterKeys = new Set<string>();
  for (const raw of value.parameterSchema as unknown[]) {
    const parameter = raw as Json;
    const parameterKey = String(parameter.parameterKey ?? '');
    const path = { parameterKey };
    if (!OPAQUE.test(parameterKey) || parameterKeys.has(parameterKey)) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'KEY' }));
      continue;
    }
    parameterKeys.add(parameterKey);
    const type = parameter.type;
    if (!isJourneyTemplateParameterType(type)) {
      // ชนิดนอกชุด (SECRET, CREDENTIAL, JSON, script …) ถูกปฏิเสธทั้ง package
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'TYPE' }));
      continue;
    }
    const allowed = new Set([...COMMON_FIELDS, ...PARAMETER_FIELDS[type]!]);
    if (
      Object.keys(parameter).some((key) => !allowed.has(key)) ||
      typeof parameter.required !== 'boolean'
    ) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'FIELD' }));
    }
    if (type === 'OPAQUE_RESOURCE_REF' && !isJourneyTemplateResourceKind(parameter.resourceKind)) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'RESOURCE_KIND' }));
    }
    if (type === 'ENUM') {
      const values = parameter.values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        new Set(values).size !== values.length ||
        !values.every((item) => typeof item === 'string' && OPAQUE.test(item))
      ) {
        out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'ENUM' }));
      }
    }
    if (
      (type === 'INTEGER' || type === 'DURATION_SECONDS') &&
      !(
        Number.isInteger(parameter.min) &&
        Number.isInteger(parameter.max) &&
        (parameter.min as number) <= (parameter.max as number)
      )
    ) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'RANGE' }));
    }
    if (
      type === 'SAFE_LITERAL' &&
      !(
        Number.isInteger(parameter.maxLength) &&
        (parameter.maxLength as number) >= 1 &&
        (parameter.maxLength as number) <= 256
      )
    ) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'LENGTH' }));
    }
    if (
      parameter.default !== undefined &&
      checkValue(
        parameter as unknown as JourneyTemplateParameterV1,
        parameter.default as JourneyTemplateParameterValue,
      )
    ) {
      out.push(diagnostic('TEMPLATE_PARAMETER_INVALID', path, { reason: 'DEFAULT' }));
    }
    const targets = parameter.bindTargets;
    if (!Array.isArray(targets) || targets.length === 0) {
      out.push(diagnostic('TEMPLATE_BIND_TARGET_INVALID', path));
      continue;
    }
    for (const target of targets as Json[]) {
      const key = String(target.templateNodeKey ?? '');
      const pointer = String(target.pointer ?? '');
      const slot = isJourneyTemplateBindPointer(pointer) ? targetSlot(document, key) : undefined;
      const current = slot?.[fieldOf(pointer)];
      // bind ได้เฉพาะ scalar ที่มีอยู่แล้ว — แทนทั้ง object, เปลี่ยน node/edge หรือเพิ่ม field ใหม่ไม่ได้
      if (!slot || current === undefined || (current !== null && typeof current === 'object')) {
        out.push(
          diagnostic('TEMPLATE_BIND_TARGET_INVALID', {
            parameterKey,
            templateNodeKey: key,
            field: pointer,
          }),
        );
        continue;
      }
      const slotKey = `${key}|${fieldOf(pointer)}`;
      // ช่องเดียวถูกสอง parameter ผูกไม่ได้ — ค่าที่ได้จะขึ้นกับลำดับ ซึ่งไม่ deterministic
      if (bound.has(slotKey)) {
        out.push(
          diagnostic(
            'TEMPLATE_BIND_TARGET_INVALID',
            { parameterKey, templateNodeKey: key, field: pointer },
            { reason: 'DUPLICATE' },
          ),
        );
        continue;
      }
      bound.add(slotKey);
    }
  }

  // reference ของ tenant ที่ไม่ได้ผ่าน parameter แปลว่า template ฝังค่าจริงไว้ใน graph
  const nodes: Array<[string, string, Json]> = [
    ['@settings', '@settings', document.settings as unknown as Json],
    ['@trigger', document.trigger.type, document.trigger.config as unknown as Json],
    ...(document.nodes as AuthoringStepNodeV1[]).map(
      (node) =>
        [node.templateNodeKey ?? node.nodeId, node.type, node.config as unknown as Json] as [
          string,
          string,
          Json,
        ],
    ),
  ];
  for (const [key, type, config] of nodes) {
    for (const field of REFERENCE_FIELDS[key] ?? REFERENCE_FIELDS[type] ?? []) {
      if (config[field] !== undefined && !bound.has(`${key}|${field}`)) {
        out.push(diagnostic('TEMPLATE_REFERENCE_UNTRUSTED', { templateNodeKey: key, field }));
      }
    }
  }
  return sortJourneyDiagnostics(out);
}

/** คืนเหตุผลที่ค่าใช้ไม่ได้ หรือ undefined เมื่อค่าถูกต้อง */
function checkValue(
  parameter: JourneyTemplateParameterV1,
  value: JourneyTemplateParameterValue,
): string | undefined {
  switch (parameter.type) {
    case 'BOOLEAN':
      return typeof value === 'boolean' ? undefined : 'TYPE';
    case 'INTEGER':
    case 'DURATION_SECONDS':
      if (!Number.isInteger(value)) return 'TYPE';
      if (parameter.type === 'DURATION_SECONDS' && (value as number) <= 0) return 'RANGE';
      return (value as number) >= parameter.min && (value as number) <= parameter.max
        ? undefined
        : 'RANGE';
    case 'ENUM':
      return typeof value === 'string' && parameter.values.includes(value) ? undefined : 'ENUM';
    case 'CANONICAL_EVENT_TYPE':
      return typeof value === 'string' && EVENT_TYPE.test(value) ? undefined : 'FORMAT';
    case 'TIMEZONE':
      if (typeof value !== 'string') return 'TYPE';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return value.includes('/') || value === 'UTC' ? undefined : 'FORMAT';
      } catch {
        return 'FORMAT';
      }
    case 'CRON':
      return typeof value === 'string' && CRON.test(value.trim()) ? undefined : 'FORMAT';
    case 'OPAQUE_RESOURCE_REF':
      return typeof value === 'string' && OPAQUE.test(value) ? undefined : 'FORMAT';
    case 'SAFE_LITERAL':
      if (typeof value !== 'string' || value.length === 0 || value.length > parameter.maxLength)
        return 'LENGTH';
      if (EMAIL.test(value) || PHONE.test(value) || /[<>{}`$\\]/.test(value)) return 'UNSAFE';
      if (parameter.pattern && !new RegExp(`^(?:${parameter.pattern})$`).test(value))
        return 'FORMAT';
      return undefined;
  }
}

export function deriveTemplateNodeId(journeyId: string, templateNodeKey: string): string {
  return `n-${journeyAuthoringDigest({ journeyId, templateNodeKey }).slice(0, 24)}`;
}

export interface BindTemplateResult {
  readonly document: AuthoringDocumentV1 | null;
  /** templateNodeKey (รวม `@trigger`) → journey nodeId */
  readonly nodeMapping: Readonly<Record<string, string>>;
  readonly bindingDigest: string;
  readonly diagnostics: readonly JourneyDiagnosticV1[];
  /** reference ที่ต้องตรวจกับ tenant/scope ปัจจุบันก่อน commit — ค่าเป็น opaque id เท่านั้น */
  readonly references: ReadonlyArray<{ readonly resourceKind: string; readonly id: string }>;
}

/**
 * instantiate: ตรวจ binding แล้วสร้าง document ใหม่ทั้งฉบับ (detached) ที่ node ID ผูกกับ journeyId ใหม่
 * ค่า parameter อยู่ใน document ของ tenant เท่านั้น; ภายนอกเห็นเพียง `bindingDigest`
 */
export function bindTemplate(
  content: JourneyTemplateContentV1,
  bindings: Readonly<Record<string, JourneyTemplateParameterValue>>,
  target: { readonly journeyId: string; readonly name: string },
): BindTemplateResult {
  const diagnostics: JourneyDiagnosticV1[] = [];
  const known = new Set(content.parameterSchema.map((parameter) => parameter.parameterKey));
  for (const key of Object.keys(bindings).sort(compareText)) {
    if (!known.has(key))
      diagnostics.push(
        diagnostic('TEMPLATE_PARAMETER_INVALID', { parameterKey: key }, { reason: 'UNKNOWN' }),
      );
  }

  const document = structuredClone(content.document) as AuthoringDocumentV1;
  const references: Array<{ resourceKind: string; id: string }> = [];
  for (const parameter of content.parameterSchema) {
    const provided = bindings[parameter.parameterKey];
    const value = provided ?? ('default' in parameter ? parameter.default : undefined);
    if (value === undefined) {
      if (parameter.required)
        diagnostics.push(
          diagnostic('TEMPLATE_PARAMETER_REQUIRED', { parameterKey: parameter.parameterKey }),
        );
      continue;
    }
    const reason = checkValue(parameter, value);
    if (reason) {
      diagnostics.push(
        diagnostic(
          'TEMPLATE_PARAMETER_INVALID',
          { parameterKey: parameter.parameterKey },
          { reason },
        ),
      );
      continue;
    }
    if (parameter.type === 'OPAQUE_RESOURCE_REF')
      references.push({ resourceKind: parameter.resourceKind, id: String(value) });
    for (const bindTarget of parameter.bindTargets) {
      const slot = targetSlot(document, bindTarget.templateNodeKey);
      const field = fieldOf(bindTarget.pointer);
      if (!slot || slot[field] === undefined) {
        diagnostics.push(
          diagnostic('TEMPLATE_BIND_TARGET_INVALID', {
            parameterKey: parameter.parameterKey,
            field: bindTarget.pointer,
          }),
        );
        continue;
      }
      if (typeof slot[field] !== typeof value) {
        diagnostics.push(
          diagnostic(
            'TEMPLATE_PARAMETER_INVALID',
            { parameterKey: parameter.parameterKey },
            { reason: 'TYPE' },
          ),
        );
        continue;
      }
      slot[field] = value;
    }
  }

  const bindingDigest = journeyAuthoringDigest(
    Object.fromEntries(
      Object.entries(bindings).sort(([left], [right]) => compareText(left, right)),
    ),
  );
  if (diagnostics.length > 0) {
    return {
      document: null,
      nodeMapping: {},
      bindingDigest,
      diagnostics: sortJourneyDiagnostics(diagnostics),
      references,
    };
  }

  // node ID ใหม่แบบ deterministic: instance คนละ Journey ไม่ใช้ ID ชุดเดียวกัน
  const localToNew = new Map<string, string>();
  const nodeMapping: Record<string, string> = {};
  const triggerId = deriveTemplateNodeId(target.journeyId, '@trigger');
  localToNew.set(document.trigger.nodeId, triggerId);
  nodeMapping['@trigger'] = triggerId;
  for (const node of document.nodes as AuthoringStepNodeV1[]) {
    const nodeId = deriveTemplateNodeId(target.journeyId, node.templateNodeKey!);
    localToNew.set(node.nodeId, nodeId);
    nodeMapping[node.templateNodeKey!] = nodeId;
  }
  const remap = (nodeId: string) => localToNew.get(nodeId) ?? nodeId;
  const bound: AuthoringDocumentV1 = {
    ...document,
    trigger: { ...document.trigger, nodeId: triggerId },
    nodes: (document.nodes as AuthoringStepNodeV1[]).map((node) => ({
      ...node,
      nodeId: remap(node.nodeId),
    })),
    edges: document.edges.map((edge) => ({
      edgeId: `e-${journeyAuthoringDigest({ journeyId: target.journeyId, edgeId: edge.edgeId }).slice(0, 24)}`,
      source: { nodeId: remap(edge.source.nodeId), portId: edge.source.portId },
      target: { nodeId: remap(edge.target.nodeId) },
    })),
    settings: { ...document.settings, name: target.name },
    layout: {
      ...document.layout,
      nodes: Object.fromEntries(
        Object.entries(document.layout.nodes).map(([nodeId, position]) => [
          remap(nodeId),
          position,
        ]),
      ),
    },
  };
  return { document: bound, nodeMapping, bindingDigest, diagnostics: [], references };
}
