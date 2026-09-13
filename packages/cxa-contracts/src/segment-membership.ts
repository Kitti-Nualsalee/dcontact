import { createHash } from 'node:crypto';
import {
  contactId,
  membershipRevision,
  segmentEntryId,
  segmentId,
  segmentMembershipStreamId,
  tenantId,
  type ContactId,
  type CustomerSnapshotVersion,
  type MembershipRevision,
  type SegmentDefinitionVersion,
  type SegmentEntryId,
  type SegmentEvidenceRef,
  type SegmentId,
  type SegmentMembershipStreamId,
  type TenantId,
} from './identifiers.js';

export const J3_CONTRACT_VERSION = 1 as const;

export const SEGMENT_MEMBERSHIP_CHANGE_KINDS = [
  'ENTERED',
  'LEFT',
  'CORRECTED',
  'REFILTER_REQUIRED',
  'IDENTITY_INVALIDATED',
] as const;

export type SegmentMembershipChangeKind = (typeof SEGMENT_MEMBERSHIP_CHANGE_KINDS)[number];

type SegmentMembershipChangeCommonV1 = {
  contractVersion: typeof J3_CONTRACT_VERSION;
  contactId: ContactId;
  segmentId: SegmentId;
  segmentDefinitionVersion: SegmentDefinitionVersion;
  membershipRevision: MembershipRevision;
  snapshotVersion: CustomerSnapshotVersion;
  evaluatedAt: string;
  /** lowercase SHA-256 ของ canonical state ที่ Customer 360 เป็น owner */
  stateDigest: string;
  /** opaque reference ที่ควบคุมสิทธิ์เข้าถึง; ห้ามเป็น raw evaluation evidence หรือ PII */
  evidenceRef?: SegmentEvidenceRef;
};

export type SegmentMembershipChangePayloadV1 =
  | (SegmentMembershipChangeCommonV1 & {
      changeKind: 'ENTERED';
      entryId: SegmentEntryId;
    })
  | (SegmentMembershipChangeCommonV1 & {
      changeKind: 'LEFT';
      entryId: SegmentEntryId;
      supersedesRevision?: MembershipRevision;
    })
  | (SegmentMembershipChangeCommonV1 & {
      changeKind: 'CORRECTED';
      entryId?: SegmentEntryId;
      supersedesRevision: MembershipRevision;
    })
  | (SegmentMembershipChangeCommonV1 & {
      changeKind: 'REFILTER_REQUIRED' | 'IDENTITY_INVALIDATED';
      entryId?: SegmentEntryId;
      supersedesRevision?: MembershipRevision;
    });

export const J3_EVENT_TYPES = {
  CUSTOMER_SEGMENT_CHANGED: 'customer.segment.changed',
} as const;

/** โครงสร้าง Kafka V2 เดิมสำหรับเลี่ยง dependency cycle ไปยัง transport package */
export type J3KafkaEnvelopeV2<TPayload extends Record<string, unknown>> = {
  schemaVersion: 2;
  eventKind: 'CANONICAL';
  eventId: string;
  type: (typeof J3_EVENT_TYPES)[keyof typeof J3_EVENT_TYPES];
  tenantId: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  orderingKey: string;
  aggregateType: 'customer_segment_membership';
  aggregateId: string;
  aggregateVersion: number;
  payload: TPayload;
};

export type ResolveSegmentEntryInput = Readonly<{
  tenantId: TenantId;
  contactId: ContactId;
  segmentId: SegmentId;
  entryId: SegmentEntryId;
  membershipRevision: MembershipRevision;
  at: string;
}>;

export type EligibleSegmentEntry = Readonly<{
  status: 'ELIGIBLE';
  contactId: ContactId;
  originalContactId?: ContactId;
  segmentId: SegmentId;
  entryId: SegmentEntryId;
  segmentDefinitionVersion: SegmentDefinitionVersion;
  membershipRevision: MembershipRevision;
  snapshotVersion: CustomerSnapshotVersion;
  evaluatedAt: string;
  stateDigest: string;
  evidenceRef?: SegmentEvidenceRef;
}>;

export type SegmentEntryResolution =
  | EligibleSegmentEntry
  | Readonly<{ status: 'NOT_ELIGIBLE'; reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE' }>
  | Readonly<{ status: 'STALE'; reasonCode: 'MEMBERSHIP_CONTEXT_STALE' }>
  | Readonly<{ status: 'AMBIGUOUS'; reasonCode: 'IDENTITY_AMBIGUOUS' }>
  | Readonly<{ status: 'NOT_FOUND'; reasonCode: 'RESOURCE_NOT_FOUND' }>;

export type ReadSegmentMembershipChangesInput = Readonly<{
  tenantId: TenantId;
  contactId: ContactId;
  segmentId: SegmentId;
  /** revision ที่ consumer apply แล้ว; ศูนย์หมายถึงขอตั้งแต่ต้น stream */
  afterRevision: number;
  throughRevision: MembershipRevision;
}>;

export type SegmentMembershipChangesRead =
  | Readonly<{
      status: 'CHANGES';
      /** เรียง membershipRevision จากน้อยไปมากแบบต่อเนื่องตลอดช่วงที่ขอ */
      changes: readonly SegmentMembershipChangePayloadV1[];
    }>
  | Readonly<{
      status: 'SUPERSEDED';
      currentRevision: MembershipRevision;
      stateDigest: string;
      evidenceRef?: SegmentEvidenceRef;
      reasonCode: 'RECONCILIATION_REQUIRED';
    }>
  | Readonly<{ status: 'STALE'; reasonCode: 'MEMBERSHIP_CONTEXT_STALE' }>
  | Readonly<{ status: 'AMBIGUOUS'; reasonCode: 'IDENTITY_AMBIGUOUS' }>
  | Readonly<{ status: 'NOT_FOUND'; reasonCode: 'RESOURCE_NOT_FOUND' }>;

/**
 * Customer 360 เป็น owner ของ read boundary นี้ โดย tenantId มาจาก trusted service context;
 * caller ส่ง membership snapshot, survivor contact หรือ team scope มาเป็น authority ไม่ได้
 */
export interface CustomerSegmentMembershipReader<TContext = undefined> {
  resolveEntry(
    input: ResolveSegmentEntryInput,
    context?: TContext,
  ): Promise<SegmentEntryResolution>;
  readChanges(
    input: ReadSegmentMembershipChangesInput,
    context?: TContext,
  ): Promise<SegmentMembershipChangesRead>;
}

export type J3RetryDisposition =
  'DEAD_LETTER' | 'QUARANTINE' | 'RECONCILE' | 'RETRY_SAME_IDENTITY' | 'DO_NOT_RETRY';

export const J3_ERROR_CONTRACT = Object.freeze({
  INVALID_ENVELOPE: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  UNSUPPORTED_SCHEMA_VERSION: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  UNSUPPORTED_CONTRACT_VERSION: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  HEADER_PAYLOAD_MISMATCH: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  ORDERING_KEY_MISMATCH: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  PAYLOAD_VALIDATION_FAILED: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  IDEMPOTENCY_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  EVENT_HASH_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  BINDING_MISMATCH: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  MEMBERSHIP_REVISION_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  IDENTITY_LINEAGE_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  MEMBERSHIP_REVISION_GAP: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  MEMBERSHIP_CONTEXT_STALE: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  SCOPE_CONTEXT_STALE: { category: 'RECOVERY', retryDisposition: 'RETRY_SAME_IDENTITY' },
  RECONCILIATION_REQUIRED: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  OWNER_ACK_UNKNOWN: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  CUSTOMER_360_UNAVAILABLE: { category: 'TRANSIENT', retryDisposition: 'RETRY_SAME_IDENTITY' },
  IAM_UNAVAILABLE: { category: 'TRANSIENT', retryDisposition: 'RETRY_SAME_IDENTITY' },
  GOVERNANCE_STATE_UNAVAILABLE: {
    category: 'TRANSIENT',
    retryDisposition: 'RETRY_SAME_IDENTITY',
  },
  SEGMENT_ENTRY_NOT_ELIGIBLE: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  TEAM_SEGMENT_NOT_ALLOWED: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  CONTACT_NOT_FOUND: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  IDENTITY_AMBIGUOUS: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  INVALID_MEMBERSHIP_TRANSITION: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  ACTION_TOO_LATE: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  RESOURCE_NOT_FOUND: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  RECOVERY_NOT_ALLOWED: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
} as const satisfies Record<string, { category: string; retryDisposition: J3RetryDisposition }>);

export type J3ErrorCode = keyof typeof J3_ERROR_CONTRACT;
export type J3ErrorCategory = (typeof J3_ERROR_CONTRACT)[J3ErrorCode]['category'];

export const J3_BUSINESS_RESULTS = [
  'DUPLICATE_NO_OP',
  'IGNORED_SUPERSEDED',
  'DEFER',
  'REVIEW',
  'CANCELLED',
  'TOO_LATE',
] as const;

export type J3BusinessResult = (typeof J3_BUSINESS_RESULTS)[number];

export class J3ContractError extends Error {
  constructor(
    readonly code: J3ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'J3ContractError';
  }
}

const CHANGE_KINDS = new Set<string>(SEGMENT_MEMBERSHIP_CHANGE_KINDS);

function fail(field: string, reason: string): never {
  throw new J3ContractError('PAYLOAD_VALIDATION_FAILED', `${field}: ${reason}`);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(field, 'ต้องเป็น object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, 'ไม่อยู่ใน closed contract');
  }
  for (const key of required) {
    if (!(key in value)) fail(`${field}.${key}`, 'จำเป็นต้องระบุ');
  }
}

function requireContractVersion(value: unknown): asserts value is typeof J3_CONTRACT_VERSION {
  if (value !== J3_CONTRACT_VERSION) {
    throw new J3ContractError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `ไม่รองรับ J3 contractVersion: ${String(value)}`,
    );
  }
}

function opaqueReference(value: unknown, field: string): asserts value is string {
  const normalizedPhoneCandidate =
    typeof value === 'string' ? value.replace(/[().\s-]/g, '') : undefined;
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value) ||
    (normalizedPhoneCandidate !== undefined && /^\d{7,}$/.test(normalizedPhoneCandidate))
  ) {
    fail(field, 'ต้องเป็น opaque internal reference ที่ไม่ว่างและไม่ใช่ PII text');
  }
}

function positiveVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) fail(field, 'ต้องเป็นจำนวนเต็มตั้งแต่ 1');
}

function nonNegativeVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(field, 'ต้องเป็นจำนวนเต็มไม่ติดลบ');
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(field, 'ต้องเป็น ISO-8601 timestamp');
  }
}

function hashValue(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(field, 'ต้องเป็น lowercase SHA-256');
  }
}

function validateOptionalEntryId(value: unknown): void {
  if (value !== undefined) opaqueReference(value, 'payload.entryId');
}

function validateOptionalSupersedesRevision(value: unknown, currentRevision: number): void {
  if (value === undefined) return;
  positiveVersion(value, 'payload.supersedesRevision');
  if (value >= currentRevision) {
    fail('payload.supersedesRevision', 'ต้องน้อยกว่า membershipRevision ปัจจุบัน');
  }
}

export function validateSegmentMembershipChangePayload(
  value: unknown,
): SegmentMembershipChangePayloadV1 {
  const candidate = objectValue(value, 'payload');
  const commonRequired = [
    'contractVersion',
    'changeKind',
    'contactId',
    'segmentId',
    'segmentDefinitionVersion',
    'membershipRevision',
    'snapshotVersion',
    'evaluatedAt',
    'stateDigest',
  ] as const;
  const commonOptional = ['evidenceRef'] as const;

  requireContractVersion(candidate.contractVersion);
  if (!CHANGE_KINDS.has(String(candidate.changeKind))) {
    fail('payload.changeKind', 'ไม่รองรับ');
  }

  switch (candidate.changeKind) {
    case 'ENTERED':
      exactKeys(candidate, 'payload', [...commonRequired, 'entryId'], commonOptional);
      opaqueReference(candidate.entryId, 'payload.entryId');
      break;
    case 'LEFT':
      exactKeys(
        candidate,
        'payload',
        [...commonRequired, 'entryId'],
        [...commonOptional, 'supersedesRevision'],
      );
      opaqueReference(candidate.entryId, 'payload.entryId');
      break;
    case 'CORRECTED':
      exactKeys(
        candidate,
        'payload',
        [...commonRequired, 'supersedesRevision'],
        [...commonOptional, 'entryId'],
      );
      validateOptionalEntryId(candidate.entryId);
      break;
    case 'REFILTER_REQUIRED':
    case 'IDENTITY_INVALIDATED':
      exactKeys(candidate, 'payload', commonRequired, [
        ...commonOptional,
        'entryId',
        'supersedesRevision',
      ]);
      validateOptionalEntryId(candidate.entryId);
      break;
    default:
      return fail('payload.changeKind', 'ไม่รองรับ');
  }

  opaqueReference(candidate.contactId, 'payload.contactId');
  opaqueReference(candidate.segmentId, 'payload.segmentId');
  positiveVersion(candidate.segmentDefinitionVersion, 'payload.segmentDefinitionVersion');
  positiveVersion(candidate.membershipRevision, 'payload.membershipRevision');
  positiveVersion(candidate.snapshotVersion, 'payload.snapshotVersion');
  timestamp(candidate.evaluatedAt, 'payload.evaluatedAt');
  hashValue(candidate.stateDigest, 'payload.stateDigest');
  if (candidate.evidenceRef !== undefined) {
    opaqueReference(candidate.evidenceRef, 'payload.evidenceRef');
  }
  validateOptionalSupersedesRevision(
    candidate.supersedesRevision,
    candidate.membershipRevision as number,
  );
  return candidate as SegmentMembershipChangePayloadV1;
}

export function validateResolveSegmentEntryInput(value: unknown): ResolveSegmentEntryInput {
  const candidate = objectValue(value, 'input');
  exactKeys(candidate, 'input', [
    'tenantId',
    'contactId',
    'segmentId',
    'entryId',
    'membershipRevision',
    'at',
  ]);
  opaqueReference(candidate.tenantId, 'input.tenantId');
  opaqueReference(candidate.contactId, 'input.contactId');
  opaqueReference(candidate.segmentId, 'input.segmentId');
  opaqueReference(candidate.entryId, 'input.entryId');
  positiveVersion(candidate.membershipRevision, 'input.membershipRevision');
  timestamp(candidate.at, 'input.at');
  return {
    tenantId: tenantId(candidate.tenantId),
    contactId: contactId(candidate.contactId),
    segmentId: segmentId(candidate.segmentId),
    entryId: segmentEntryId(candidate.entryId),
    membershipRevision: membershipRevision(candidate.membershipRevision),
    at: candidate.at,
  };
}

export function validateReadSegmentMembershipChangesInput(
  value: unknown,
): ReadSegmentMembershipChangesInput {
  const candidate = objectValue(value, 'input');
  exactKeys(candidate, 'input', [
    'tenantId',
    'contactId',
    'segmentId',
    'afterRevision',
    'throughRevision',
  ]);
  opaqueReference(candidate.tenantId, 'input.tenantId');
  opaqueReference(candidate.contactId, 'input.contactId');
  opaqueReference(candidate.segmentId, 'input.segmentId');
  nonNegativeVersion(candidate.afterRevision, 'input.afterRevision');
  positiveVersion(candidate.throughRevision, 'input.throughRevision');
  if (candidate.afterRevision >= candidate.throughRevision) {
    fail('input', 'afterRevision ต้องน้อยกว่า throughRevision');
  }
  return {
    tenantId: tenantId(candidate.tenantId),
    contactId: contactId(candidate.contactId),
    segmentId: segmentId(candidate.segmentId),
    afterRevision: candidate.afterRevision,
    throughRevision: membershipRevision(candidate.throughRevision),
  };
}

export function customerSegmentMembershipStreamId(
  contact: ContactId,
  segment: SegmentId,
): SegmentMembershipStreamId {
  return segmentMembershipStreamId(`${contact}:${segment}`);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical payload', 'ตัวเลขต้องเป็น finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return fail('canonical payload', `ไม่รองรับ value type ${typeof value}`);
}

export function canonicalSegmentMembershipHash(tenant: TenantId, value: unknown): string {
  const payload = validateSegmentMembershipChangePayload(value);
  return createHash('sha256')
    .update(canonicalJson({ tenantId: tenant, payload }))
    .digest('hex');
}

function validateEnvelope(value: unknown): Record<string, unknown> {
  const candidate = objectValue(value, 'envelope');
  exactKeys(
    candidate,
    'envelope',
    [
      'schemaVersion',
      'eventKind',
      'eventId',
      'type',
      'tenantId',
      'occurredAt',
      'correlationId',
      'orderingKey',
      'aggregateType',
      'aggregateId',
      'aggregateVersion',
      'payload',
    ],
    ['causationId'],
  );
  if (candidate.schemaVersion !== 2) {
    throw new J3ContractError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `J3 ต้องใช้ Kafka envelope schemaVersion=2: ${String(candidate.schemaVersion)}`,
    );
  }
  opaqueReference(candidate.eventId, 'envelope.eventId');
  opaqueReference(candidate.tenantId, 'envelope.tenantId');
  timestamp(candidate.occurredAt, 'envelope.occurredAt');
  opaqueReference(candidate.correlationId, 'envelope.correlationId');
  if (candidate.causationId !== undefined) {
    opaqueReference(candidate.causationId, 'envelope.causationId');
  }
  objectValue(candidate.payload, 'envelope.payload');
  return candidate;
}

export function assertSegmentMembershipChangeEnvelope(
  value: unknown,
): J3KafkaEnvelopeV2<SegmentMembershipChangePayloadV1> {
  const envelope = validateEnvelope(value);
  const payload = validateSegmentMembershipChangePayload(envelope.payload);
  const streamId = customerSegmentMembershipStreamId(payload.contactId, payload.segmentId);
  if (envelope.orderingKey !== streamId || envelope.aggregateId !== streamId) {
    throw new J3ContractError(
      'ORDERING_KEY_MISMATCH',
      'orderingKey และ aggregateId ต้องตรงกับ contactId:segmentId',
    );
  }
  if (
    envelope.eventKind !== 'CANONICAL' ||
    envelope.type !== J3_EVENT_TYPES.CUSTOMER_SEGMENT_CHANGED ||
    envelope.aggregateType !== 'customer_segment_membership' ||
    envelope.aggregateVersion !== payload.membershipRevision
  ) {
    throw new J3ContractError(
      'BINDING_MISMATCH',
      'Kafka V2 aggregate metadata ไม่ตรงกับ canonical membership payload',
    );
  }
  return { ...envelope, payload } as J3KafkaEnvelopeV2<SegmentMembershipChangePayloadV1>;
}
