/**
 * CG4.8 (#191): การอ่าน `dc.contact-governance.events` ฝั่ง downstream owner
 *
 * Journey, Dialer และ Workspace ไม่ประเมิน policy หรือ exception เอง (#174 §1) สิ่งที่ต้องรู้
 * จาก event มีเพียง: อยู่ใน stream ไหน version อะไร, ต้องทำอะไรกับงานที่ค้าง (ขอ canonical
 * re-authorization, hold scope หรือไม่ทำอะไร) และ scope ที่กระทบ ผลการตัดสินจริงยังมาจาก
 * Contact Governance ผ่าน revalidation port เท่านั้น
 *
 * อยู่ใน contracts เพื่อให้ทุก consumer ตีความ event ชุดเดียวกันด้วยกติกาเดียว โดยไม่ต้อง
 * import แอป Contact Governance
 */
import { createHash } from 'node:crypto';
import type { ContactChannel } from './contact-governance.js';
import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_AGGREGATE_TYPES,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4Restrictiveness,
  type Cg4TransitionKind,
} from './contact-governance-cg4.js';

export const CG3_CONTACT_EVENT_TYPES = Object.freeze([
  'restriction.changed',
  'consent.changed',
  'preference.changed',
] as const);

/** CG4.2 foundation ยังเขียน event รูป CG3 ลง contact stream เดียวกัน */
export const CG4_FOUNDATION_CONTACT_EVENT_TYPES = Object.freeze(['exception.recorded'] as const);

/** reason ที่ registry ของ CG4 มีอยู่แล้ว ใช้เมื่อ scoped kill switch หยุดงาน */
export const GOVERNANCE_KILL_SWITCH_ACTIVE = 'GOVERNANCE_KILL_SWITCH_ACTIVE' as const;

export type GovernanceStreamAggregate = 'CONTACT' | 'POLICY';
export type GovernanceEventFamily = 'CG3' | 'CG4';

/**
 * - `REAUTHORIZE` ขอ canonical re-authorization ให้งานที่อยู่ใน scope
 * - `HOLD_SCOPE` kill switch: hold งานใน scope ทันทีโดยไม่ต้องถาม evaluator
 * - `NO_OP` relaxation หรือ activation ที่ยังไม่ถึงเวลา: ห้าม resume หรือ retry งานเดิม
 */
export type GovernanceDownstreamEffect = 'REAUTHORIZE' | 'HOLD_SCOPE' | 'NO_OP';

/** `null` หมายถึงไม่ผูก dimension นั้น ซึ่งกว้างกว่า ไม่ใช่ไม่ตรง */
export interface GovernanceDownstreamScope {
  identityId: string | null;
  channel: ContactChannel | null;
  purpose: string | null;
  contactKind: string | null;
  sourceType: string | null;
  scopeKey: string | null;
}

export interface GovernanceDownstreamEvent {
  family: GovernanceEventFamily;
  eventType: string;
  aggregate: GovernanceStreamAggregate;
  aggregateId: string;
  aggregateVersion: number;
  subjectVersion: number;
  mutationId: string;
  transitionKind?: Cg4TransitionKind;
  state?: string;
  restrictiveness: Cg4Restrictiveness;
  effect: GovernanceDownstreamEffect;
  scope: GovernanceDownstreamScope;
  stateDigest: string;
  effectiveAt: string;
  policyVersion?: number;
  /** digest ของ payload ทั้งก้อน ใช้ตรวจ duplicate และ hash conflict ต่อ version */
  payloadDigest: string;
}

export const GOVERNANCE_DOWNSTREAM_REJECTION_REASONS = Object.freeze([
  'UNSUPPORTED_EVENT_TYPE',
  'UNSUPPORTED_TRANSITION_KIND',
  'MALFORMED_PAYLOAD',
  'UNSUPPORTED_CONTRACT_VERSION',
  'UNSUPPORTED_POLICY_SCHEMA_VERSION',
  'UNSUPPORTED_RULE_REGISTRY_VERSION',
  'UNSUPPORTED_EVALUATOR_VERSION',
] as const);

export type GovernanceDownstreamRejectionReason =
  (typeof GOVERNANCE_DOWNSTREAM_REJECTION_REASONS)[number];

/** reason ที่ต้องส่ง DLQ (#179 §4 "unknown contract/schema version เข้า DLQ") ต่างจาก hash conflict */
export function isGovernanceContractRejection(
  reasonCode: string | undefined,
): reasonCode is GovernanceDownstreamRejectionReason {
  return (
    reasonCode !== undefined &&
    (GOVERNANCE_DOWNSTREAM_REJECTION_REASONS as readonly string[]).includes(reasonCode)
  );
}

export interface GovernanceDownstreamRejection {
  ok: false;
  reason: GovernanceDownstreamRejectionReason;
  detail: string;
  aggregate: GovernanceStreamAggregate;
  aggregateId: string;
  aggregateVersion: number;
  payloadDigest: string;
}

export type GovernanceDownstreamClassification =
  { ok: true; event: GovernanceDownstreamEvent } | GovernanceDownstreamRejection;

export interface GovernanceEventEnvelopeInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: unknown;
}

const TRANSITION_KINDS: ReadonlySet<string> = new Set<Cg4TransitionKind>([
  'EXCEPTION_REQUESTED',
  'EXCEPTION_APPROVED',
  'EXCEPTION_REJECTED',
  'EXCEPTION_CANCELLED',
  'EXCEPTION_ACTIVATED',
  'EXCEPTION_EXPIRED',
  'EXCEPTION_REVOKED',
  'POLICY_CHANGED',
  'POLICY_ACTIVATED',
  'KILL_SWITCH_ACTIVATED',
  'KILL_SWITCH_CLEARED',
]);
const RESTRICTIVENESS: ReadonlySet<string> = new Set(['TIGHTENING', 'NEUTRAL', 'RELAXATION']);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function governanceStreamAggregate(
  aggregateType: string,
): GovernanceStreamAggregate | undefined {
  if (aggregateType === CG4_EVENT_AGGREGATE_TYPES.CONTACT) return 'CONTACT';
  if (aggregateType === CG4_EVENT_AGGREGATE_TYPES.POLICY) return 'POLICY';
  return undefined;
}

/**
 * digest เดียวกับที่ inbox ของ Journey/Dialer ใช้มาตั้งแต่ S1 (key เรียงด้วย localeCompare)
 * คงไว้เพื่อให้แถว inbox เดิมเทียบกับ event ที่ส่งซ้ำได้ตรงกัน
 */
export function governancePayloadDigest(value: unknown): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object') {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${encode(nested)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item ?? null);
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}

class PayloadRejection extends Error {
  constructor(
    readonly reason: GovernanceDownstreamRejectionReason,
    detail: string,
  ) {
    super(detail);
  }
}

function malformed(detail: string): never {
  throw new PayloadRejection('MALFORMED_PAYLOAD', detail);
}

function objectField(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    malformed(`${name} ต้องเป็น object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) malformed(`${name} ต้องเป็น string`);
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    malformed(`${name} ต้องเป็น positive integer`);
  }
  return value as number;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    malformed(`${name} ต้องเป็น SHA-256 lowercase`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const text = requiredString(value, name);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) malformed(`${name} ต้องเป็น ISO-8601`);
  return parsed.toISOString();
}

function optionalPolicyVersion(payload: Record<string, unknown>): { policyVersion?: number } {
  return payload.policyVersion === undefined
    ? {}
    : { policyVersion: positiveInteger(payload.policyVersion, 'policyVersion') };
}

/** CG3 payload: subject version คือ aggregate version เสมอ และทุก change ต้อง re-authorize */
function parseCg3Shape(
  input: GovernanceEventEnvelopeInput,
  aggregate: GovernanceStreamAggregate,
  payloadDigest: string,
): GovernanceDownstreamEvent {
  const payload = objectField(input.payload, 'payload');
  if (payload.contractVersion !== 1) {
    throw new PayloadRejection(
      'UNSUPPORTED_CONTRACT_VERSION',
      `CG3 contractVersion ${String(payload.contractVersion)} ไม่รองรับ`,
    );
  }
  const subjectVersion = positiveInteger(payload.subjectVersion, 'subjectVersion');
  if (subjectVersion !== input.aggregateVersion) {
    malformed('CG3 subjectVersion ต้องตรงกับ envelope aggregateVersion');
  }
  const scope = objectField(payload.affectedScope, 'affectedScope');
  return {
    family: 'CG3',
    eventType: input.type,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    subjectVersion,
    mutationId: requiredString(payload.mutationId, 'mutationId'),
    restrictiveness: 'NEUTRAL',
    effect: 'REAUTHORIZE',
    scope: {
      identityId: optionalString(scope.identityId, 'affectedScope.identityId'),
      channel: optionalString(scope.channel, 'affectedScope.channel') as ContactChannel | null,
      purpose: optionalString(scope.purpose, 'affectedScope.purpose'),
      contactKind: optionalString(scope.contactKind, 'affectedScope.contactKind'),
      sourceType: null,
      scopeKey: null,
    },
    stateDigest: sha256(payload.stateDigest, 'stateDigest'),
    effectiveAt: instant(payload.effectiveAt, 'effectiveAt'),
    ...optionalPolicyVersion(payload),
    payloadDigest,
  };
}

const TRANSITIONS_BY_EVENT_TYPE: Readonly<Record<string, (kind: string) => boolean>> = {
  [CG4_EVENT_TYPES.EXCEPTION_CHANGED]: (kind) => kind.startsWith('EXCEPTION_'),
  [CG4_EVENT_TYPES.POLICY_CHANGED]: (kind) =>
    kind === 'POLICY_CHANGED' || kind === 'POLICY_ACTIVATED',
  [CG4_EVENT_TYPES.KILL_SWITCH_CHANGED]: (kind) => kind.startsWith('KILL_SWITCH_'),
};

/**
 * CG4 payload (#179 §4). version ของ contract/schema/registry/evaluator ถูกตรวจก่อน field อื่น:
 * payload ของ contract ที่ใหม่กว่าอาจมีรูปต่างไป และต้องออกมาเป็น unsupported ไม่ใช่ malformed
 */
function parseCg4Shape(
  input: GovernanceEventEnvelopeInput,
  aggregate: GovernanceStreamAggregate,
  payloadDigest: string,
): GovernanceDownstreamEvent {
  const payload = objectField(input.payload, 'payload');
  const versionChecks = [
    ['contractVersion', CG4_CONTRACT_VERSION, 'UNSUPPORTED_CONTRACT_VERSION'],
    ['policySchemaVersion', CG4_POLICY_SCHEMA_VERSION, 'UNSUPPORTED_POLICY_SCHEMA_VERSION'],
    ['ruleRegistryVersion', CG4_RULE_REGISTRY_VERSION, 'UNSUPPORTED_RULE_REGISTRY_VERSION'],
    ['evaluatorVersion', CG4_EVALUATOR_VERSION, 'UNSUPPORTED_EVALUATOR_VERSION'],
  ] as const;
  for (const [field, expected, reason] of versionChecks) {
    if (payload[field] !== expected) {
      throw new PayloadRejection(reason, `${field} ${String(payload[field])} ไม่รองรับ`);
    }
  }

  const transitionKind = requiredString(payload.transitionKind, 'transitionKind');
  if (!TRANSITION_KINDS.has(transitionKind)) {
    throw new PayloadRejection(
      'UNSUPPORTED_TRANSITION_KIND',
      `transitionKind ${transitionKind} ไม่รองรับ`,
    );
  }
  if (!TRANSITIONS_BY_EVENT_TYPE[input.type]?.(transitionKind)) {
    malformed(`transitionKind ${transitionKind} ไม่ตรงกับ event type ${input.type}`);
  }
  const restrictiveness = requiredString(payload.restrictiveness, 'restrictiveness');
  if (!RESTRICTIVENESS.has(restrictiveness)) malformed('restrictiveness ไม่ใช่ค่าที่รู้จัก');
  const state = requiredString(payload.state, 'state');
  const scope = objectField(payload.affectedScope, 'affectedScope');
  requiredString(payload.subjectId, 'subjectId');
  sha256(payload.scopeDigest, 'scopeDigest');

  let effect: GovernanceDownstreamEffect;
  if (input.type === CG4_EVENT_TYPES.KILL_SWITCH_CHANGED) {
    if (state === 'ACTIVE') {
      if (restrictiveness !== 'TIGHTENING') malformed('kill switch ที่ ACTIVE ต้องเป็น TIGHTENING');
      effect = 'HOLD_SCOPE';
    } else if (state === 'CLEARED') {
      effect = 'NO_OP';
    } else {
      malformed(`kill switch state ${state} ไม่รองรับ`);
    }
  } else if (input.type === CG4_EVENT_TYPES.POLICY_CHANGED && state === 'SCHEDULED') {
    // head ที่ยังไม่ถึงเวลา activate ยังไม่เปลี่ยนผลใด ๆ; activation จะออก event ของตัวเอง
    effect = 'NO_OP';
  } else {
    effect = restrictiveness === 'RELAXATION' ? 'NO_OP' : 'REAUTHORIZE';
  }

  return {
    family: 'CG4',
    eventType: input.type,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    subjectVersion: positiveInteger(payload.subjectVersion, 'subjectVersion'),
    mutationId: requiredString(payload.mutationId, 'mutationId'),
    transitionKind: transitionKind as Cg4TransitionKind,
    state,
    restrictiveness: restrictiveness as Cg4Restrictiveness,
    effect,
    scope: {
      identityId: null,
      channel: optionalString(scope.channel, 'affectedScope.channel') as ContactChannel | null,
      purpose: optionalString(scope.purpose, 'affectedScope.purpose'),
      contactKind: optionalString(scope.contactKind, 'affectedScope.contactKind'),
      sourceType: optionalString(scope.sourceType, 'affectedScope.sourceType'),
      scopeKey: requiredString(scope.scopeKey, 'affectedScope.scopeKey'),
    },
    stateDigest: sha256(payload.stateDigest, 'stateDigest'),
    effectiveAt: instant(payload.effectiveAt, 'effectiveAt'),
    ...optionalPolicyVersion(payload),
    payloadDigest,
  };
}

/**
 * คืน `undefined` เฉพาะเมื่อ aggregateType ไม่ใช่ของ Contact Governance ซึ่งไม่มี scope
 * ให้ fail closed ได้เลย; ทุกกรณีอื่นคืนผลที่ consumer ใช้ตัดสินต่อได้
 */
export function classifyGovernanceEvent(
  input: GovernanceEventEnvelopeInput,
): GovernanceDownstreamClassification | undefined {
  const aggregate = governanceStreamAggregate(input.aggregateType);
  if (!aggregate) return undefined;
  const payloadDigest = governancePayloadDigest(input.payload);
  const rejection = (
    reason: GovernanceDownstreamRejectionReason,
    detail: string,
  ): GovernanceDownstreamRejection => ({
    ok: false,
    reason,
    detail,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    payloadDigest,
  });

  if (!Number.isInteger(input.aggregateVersion) || input.aggregateVersion < 1) {
    return rejection('MALFORMED_PAYLOAD', 'aggregateVersion ต้องเป็น positive integer');
  }

  try {
    if (aggregate === 'CONTACT') {
      if (
        (CG3_CONTACT_EVENT_TYPES as readonly string[]).includes(input.type) ||
        (CG4_FOUNDATION_CONTACT_EVENT_TYPES as readonly string[]).includes(input.type)
      ) {
        return { ok: true, event: parseCg3Shape(input, aggregate, payloadDigest) };
      }
      if (input.type === CG4_EVENT_TYPES.EXCEPTION_CHANGED) {
        return { ok: true, event: parseCg4Shape(input, aggregate, payloadDigest) };
      }
    } else {
      if (input.type === CG4_EVENT_TYPES.POLICY_CHANGED) {
        const payload = input.payload as Record<string, unknown> | null;
        const isCg4 = !!payload && typeof payload === 'object' && 'transitionKind' in payload;
        return {
          ok: true,
          event: isCg4
            ? parseCg4Shape(input, aggregate, payloadDigest)
            : parseCg3Shape(input, aggregate, payloadDigest),
        };
      }
      if (input.type === CG4_EVENT_TYPES.KILL_SWITCH_CHANGED) {
        return { ok: true, event: parseCg4Shape(input, aggregate, payloadDigest) };
      }
    }
  } catch (error) {
    if (error instanceof PayloadRejection) return rejection(error.reason, error.message);
    throw error;
  }
  return rejection(
    'UNSUPPORTED_EVENT_TYPE',
    `event type ${input.type} ไม่รองรับบน ${input.aggregateType}`,
  );
}

export interface GovernanceWorkScope {
  identityId: string;
  channel: string;
  purpose: string;
  /** ไม่รู้ contactKind ของงาน = ถือว่าอยู่ใน scope เพื่อ fail closed */
  contactKind?: string | null;
  /** source type ที่งานของ owner นี้เป็นได้ เช่น Dialer เป็นทั้ง DIALER และ CAMPAIGN */
  sourceTypes: readonly string[];
}

export function governanceScopeCovers(
  scope: GovernanceDownstreamScope,
  work: GovernanceWorkScope,
): boolean {
  if (scope.identityId && scope.identityId !== work.identityId) return false;
  if (scope.channel && scope.channel !== work.channel) return false;
  if (scope.purpose && scope.purpose !== work.purpose) return false;
  if (scope.sourceType && !work.sourceTypes.includes(scope.sourceType)) return false;
  if (scope.contactKind && work.contactKind && scope.contactKind !== work.contactKind) {
    return false;
  }
  return true;
}

export interface GovernanceStreamCursor {
  version: number;
  digest: string;
}

export type GovernanceStreamPosition =
  /** version ถัดไปพอดี */
  | { kind: 'APPLY' }
  /** version+digest ที่ apply แล้ว: ไม่มี effect ซ้ำ */
  | { kind: 'DUPLICATE' }
  /** version เดียวกันแต่ digest ต่าง: มีสองความจริงสำหรับ version เดียว */
  | { kind: 'HASH_CONFLICT'; version: number }
  /** version ขาดหาย: ห้ามสร้าง projection บนช่องว่าง */
  | { kind: 'GAP'; expectedVersion: number; receivedVersion: number }
  /** version เก่ากว่าที่ cursor ข้ามไปแล้วด้วย canonical reload */
  | { kind: 'SUPERSEDED' };

/**
 * ตำแหน่งของ event ใน stream ของ aggregate เดียว (#179 §4) เป็น pure function เพื่อให้ทุก
 * consumer ตัดสินแบบเดียวกันและทดสอบได้ครบทุกกิ่งโดยไม่ต้องมี broker
 *
 * `appliedAtIncomingVersion` ใช้เฉพาะเมื่อ event เก่ากว่า cursor: ถ้า version นั้นเคย apply
 * แล้วต้องเทียบ digest ของ version นั้นเอง ไม่ใช่ของ cursor
 */
export function classifyGovernanceStreamPosition(input: {
  cursor?: GovernanceStreamCursor;
  appliedAtIncomingVersion?: { digest: string };
  incoming: GovernanceStreamCursor;
}): GovernanceStreamPosition {
  const { cursor, incoming } = input;
  if (!cursor) {
    return incoming.version === 1
      ? { kind: 'APPLY' }
      : { kind: 'GAP', expectedVersion: 1, receivedVersion: incoming.version };
  }
  if (incoming.version === cursor.version + 1) return { kind: 'APPLY' };
  if (incoming.version > cursor.version) {
    return {
      kind: 'GAP',
      expectedVersion: cursor.version + 1,
      receivedVersion: incoming.version,
    };
  }
  const applied =
    incoming.version === cursor.version
      ? { digest: cursor.digest }
      : input.appliedAtIncomingVersion;
  if (!applied) return { kind: 'SUPERSEDED' };
  return applied.digest === incoming.digest
    ? { kind: 'DUPLICATE' }
    : { kind: 'HASH_CONFLICT', version: incoming.version };
}
