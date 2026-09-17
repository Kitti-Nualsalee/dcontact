/**
 * J2 cross-domain contracts. This module owns DTO validation and semantic hashing only;
 * Kafka envelope validation remains in @d-contact/kafka and canonical state remains with
 * Interaction, Cases, Dialer, Journey, and Contact Governance respectively.
 */
import { createHash } from 'node:crypto';
import type {
  ActionKey,
  CampaignId,
  CommandId,
  ContactId,
  EnrollmentId,
  InteractionId,
  JourneyId,
  OutcomeId,
  TeamId,
  TenantId,
} from './identifiers.js';
import { tenantId } from './identifiers.js';

export const J2_CONTRACT_VERSION = 1 as const;

export const INTERACTION_OUTCOME_TYPES = [
  'INTERACTION_ABANDONED',
  'INTERACTION_DISPOSITION_RECORDED',
  'FEEDBACK_DETRACTOR_RECORDED',
] as const;

export type InteractionOutcomeType = (typeof INTERACTION_OUTCOME_TYPES)[number];

export const INTERACTION_OUTCOME_CODES = {
  INTERACTION_ABANDONED: ['ABANDONED'],
  INTERACTION_DISPOSITION_RECORDED: ['CALLBACK_REQUESTED'],
  FEEDBACK_DETRACTOR_RECORDED: ['DETRACTOR'],
} as const;

export type InteractionOutcomeCode = {
  [TType in InteractionOutcomeType]: (typeof INTERACTION_OUTCOME_CODES)[TType][number];
}[InteractionOutcomeType];

type InteractionOutcomeCommonV1 = {
  contractVersion: typeof J2_CONTRACT_VERSION;
  outcomeId: OutcomeId;
  outcomeVersion: number;
  interactionId: InteractionId;
  contactId?: ContactId;
  outcomeCode: InteractionOutcomeCode;
  effectiveAt: string;
  supersedesVersion?: number;
};

export type InteractionOutcomePayloadV1 =
  | (InteractionOutcomeCommonV1 & {
      outcomeType: 'INTERACTION_ABANDONED';
      outcomeCode: 'ABANDONED';
    })
  | (InteractionOutcomeCommonV1 & {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED';
    })
  | (InteractionOutcomeCommonV1 & {
      outcomeType: 'FEEDBACK_DETRACTOR_RECORDED';
      outcomeCode: 'DETRACTOR';
    });

export type J2OutcomeReferenceV1 = {
  outcomeType: InteractionOutcomeType;
  outcomeId: OutcomeId;
  outcomeVersion: number;
};

type OwnerCommandCommonV1 = {
  contractVersion: typeof J2_CONTRACT_VERSION;
  commandId: CommandId;
  actionKey: ActionKey;
  requestHash: string;
  journeyId: JourneyId;
  journeyVersion: number;
  enrollmentId: EnrollmentId;
  stepId: string;
  sourceOutcome: J2OutcomeReferenceV1;
  interactionId: InteractionId;
  contactId: ContactId;
  sourceOwnerTeamId: TeamId;
  targetOwnerTeamId: TeamId;
  expectedOwnerVersion?: number;
};

export type EnsureCaseIntentV1 = {
  caseTypePolicyRef: string;
  routingPolicyRef: string;
};

export type AdmitCampaignTargetIntentV1 = {
  campaignId: CampaignId;
};

export type ScheduleCallbackIntentV1 = {
  requestedFor: string;
  queueId: string;
  agentId?: string;
};

export type CancelOwnerActionIntentV1 = {
  originalActionKey: ActionKey;
  reasonCode: string;
};

export type SupersedeOwnerActionIntentV1 = CancelOwnerActionIntentV1 & {
  supersedingOutcome: J2OutcomeReferenceV1;
};

export type J2OwnerCommandPayloadV1 =
  | (OwnerCommandCommonV1 & {
      commandType: 'ENSURE_CASE';
      intent: EnsureCaseIntentV1;
    })
  | (OwnerCommandCommonV1 & {
      commandType: 'ADMIT_CAMPAIGN_TARGET';
      intent: AdmitCampaignTargetIntentV1;
    })
  | (OwnerCommandCommonV1 & {
      commandType: 'SCHEDULE_CALLBACK';
      intent: ScheduleCallbackIntentV1;
    })
  | (OwnerCommandCommonV1 & {
      commandType: 'CANCEL_CAMPAIGN_TARGET' | 'CANCEL_CALLBACK';
      intent: CancelOwnerActionIntentV1;
    })
  | (OwnerCommandCommonV1 & {
      commandType: 'SUPERSEDE_CAMPAIGN_TARGET' | 'SUPERSEDE_CALLBACK';
      intent: SupersedeOwnerActionIntentV1;
    });

export type J2OwnerCommandType = J2OwnerCommandPayloadV1['commandType'];

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown ? Omit<T, TKey> : never;

export type J2OwnerCommandDraftV1 = DistributiveOmit<J2OwnerCommandPayloadV1, 'requestHash'>;

export type J2OwnerAggregateReferenceV1 = {
  type: 'case' | 'campaign_target' | 'callback';
  id: string;
  version: number;
};

export type J2OwnerResultStatus =
  | 'CREATED'
  | 'LINKED'
  | 'REOPENED'
  | 'ADMITTED'
  | 'ALREADY_ADMITTED'
  | 'SCHEDULED'
  | 'ALREADY_SCHEDULED'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'TOO_LATE'
  | 'REJECTED';

export type J2FailureClass = 'NONE' | 'TRANSIENT' | 'BUSINESS' | 'AUTHORIZATION' | 'CONTRACT';

export type J2RetryDisposition =
  'NONE' | 'RETRY_SAME_IDENTITY' | 'RECONCILE' | 'QUARANTINE' | 'DEAD_LETTER' | 'DO_NOT_RETRY';

export type J2OwnerResultPayloadV1 = {
  contractVersion: typeof J2_CONTRACT_VERSION;
  commandId: CommandId;
  actionKey: ActionKey;
  requestHash: string;
  commandType: J2OwnerCommandType;
  status: J2OwnerResultStatus;
  code: J2OwnerResultCode;
  category: J2OwnerResultCategory;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: J2RetryDisposition;
  observedAt: string;
  ownerAggregate?: J2OwnerAggregateReferenceV1;
  auditRef?: string;
};

export type J2OwnerActionQueryV1 = {
  contractVersion: typeof J2_CONTRACT_VERSION;
  actionKey: ActionKey;
  requestHash: string;
};

/**
 * Structural V2 envelope view used by J2 contracts. Kafka owns its codec and
 * headers; keeping this structural prevents a transport dependency cycle.
 */
export type J2KafkaEnvelopeV2<TPayload extends Record<string, unknown>> = {
  schemaVersion: 2;
  eventKind: 'CANONICAL' | 'COMMAND';
  eventId: string;
  type: string;
  tenantId: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  orderingKey: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: TPayload;
};

export type J2CaseOwnerCommandV1 = Extract<J2OwnerCommandPayloadV1, { commandType: 'ENSURE_CASE' }>;

export type J2DialerOwnerCommandV1 = Exclude<J2OwnerCommandPayloadV1, J2CaseOwnerCommandV1>;

/** Dispatch success confirms durable command/outbox persistence, not the business effect. */
export type J2OwnerCommandPersistedV1 = {
  status: 'PERSISTED';
  commandId: CommandId;
  actionKey: ActionKey;
  requestHash: string;
};

export interface J2OwnerPort<TCommand extends J2OwnerCommandPayloadV1> {
  persistCommand(tenant: TenantId, command: TCommand): Promise<J2OwnerCommandPersistedV1>;
  queryAction(
    tenant: TenantId,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined>;
}

export type J2CaseOwnerPort = J2OwnerPort<J2CaseOwnerCommandV1>;
export type J2DialerOwnerPort = J2OwnerPort<J2DialerOwnerCommandV1>;

export const J2_EVENT_TYPES = {
  INTERACTION_OUTCOME_RECORDED: 'interaction.outcome_recorded',
  CASE_ENSURE_REQUESTED: 'case.ensure_requested',
  CASE_ENSURE_COMPLETED: 'case.ensure_completed',
  CAMPAIGN_TARGET_ADMISSION_REQUESTED: 'dialer.campaign_target_admission_requested',
  CAMPAIGN_TARGET_ADMISSION_COMPLETED: 'dialer.campaign_target_admission_completed',
  CALLBACK_SCHEDULING_REQUESTED: 'dialer.callback_scheduling_requested',
  CALLBACK_SCHEDULING_COMPLETED: 'dialer.callback_scheduling_completed',
  CAMPAIGN_TARGET_CANCELLATION_REQUESTED: 'dialer.campaign_target_cancellation_requested',
  CAMPAIGN_TARGET_CANCELLATION_COMPLETED: 'dialer.campaign_target_cancellation_completed',
  CALLBACK_CANCELLATION_REQUESTED: 'dialer.callback_cancellation_requested',
  CALLBACK_CANCELLATION_COMPLETED: 'dialer.callback_cancellation_completed',
  CAMPAIGN_TARGET_SUPERSEDE_REQUESTED: 'dialer.campaign_target_supersede_requested',
  CAMPAIGN_TARGET_SUPERSEDE_COMPLETED: 'dialer.campaign_target_supersede_completed',
  CALLBACK_SUPERSEDE_REQUESTED: 'dialer.callback_supersede_requested',
  CALLBACK_SUPERSEDE_COMPLETED: 'dialer.callback_supersede_completed',
} as const;

export type J2EventType = (typeof J2_EVENT_TYPES)[keyof typeof J2_EVENT_TYPES];

export const J2_COMMAND_EVENT_TYPE: Readonly<Record<J2OwnerCommandType, J2EventType>> = {
  ENSURE_CASE: J2_EVENT_TYPES.CASE_ENSURE_REQUESTED,
  ADMIT_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_ADMISSION_REQUESTED,
  SCHEDULE_CALLBACK: J2_EVENT_TYPES.CALLBACK_SCHEDULING_REQUESTED,
  CANCEL_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_CANCELLATION_REQUESTED,
  CANCEL_CALLBACK: J2_EVENT_TYPES.CALLBACK_CANCELLATION_REQUESTED,
  SUPERSEDE_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_SUPERSEDE_REQUESTED,
  SUPERSEDE_CALLBACK: J2_EVENT_TYPES.CALLBACK_SUPERSEDE_REQUESTED,
};

export const J2_RESULT_EVENT_TYPE: Readonly<Record<J2OwnerCommandType, J2EventType>> = {
  ENSURE_CASE: J2_EVENT_TYPES.CASE_ENSURE_COMPLETED,
  ADMIT_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_ADMISSION_COMPLETED,
  SCHEDULE_CALLBACK: J2_EVENT_TYPES.CALLBACK_SCHEDULING_COMPLETED,
  CANCEL_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_CANCELLATION_COMPLETED,
  CANCEL_CALLBACK: J2_EVENT_TYPES.CALLBACK_CANCELLATION_COMPLETED,
  SUPERSEDE_CAMPAIGN_TARGET: J2_EVENT_TYPES.CAMPAIGN_TARGET_SUPERSEDE_COMPLETED,
  SUPERSEDE_CALLBACK: J2_EVENT_TYPES.CALLBACK_SUPERSEDE_COMPLETED,
};

export const J2_ERROR_CONTRACT = {
  INVALID_ENVELOPE: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  UNSUPPORTED_SCHEMA_VERSION: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  UNSUPPORTED_CONTRACT_VERSION: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  HEADER_PAYLOAD_MISMATCH: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  ORDERING_KEY_MISMATCH: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  PAYLOAD_VALIDATION_FAILED: { category: 'CONTRACT', retryDisposition: 'DEAD_LETTER' },
  IDEMPOTENCY_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  EVENT_HASH_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  BINDING_MISMATCH: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  OUTCOME_VERSION_CONFLICT: { category: 'CONFLICT', retryDisposition: 'QUARANTINE' },
  OUTCOME_VERSION_GAP: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  SCOPE_CONTEXT_STALE: { category: 'RECOVERY', retryDisposition: 'RETRY_SAME_IDENTITY' },
  OWNER_ACK_UNKNOWN: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  RECONCILIATION_REQUIRED: { category: 'RECOVERY', retryDisposition: 'RECONCILE' },
  OWNER_UNAVAILABLE: { category: 'TRANSIENT', retryDisposition: 'RETRY_SAME_IDENTITY' },
  GOVERNANCE_STATE_UNAVAILABLE: {
    category: 'TRANSIENT',
    retryDisposition: 'RETRY_SAME_IDENTITY',
  },
  TEAM_SEGMENT_NOT_ALLOWED: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  CONTACT_NOT_FOUND: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  IDENTITY_AMBIGUOUS: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  OWNER_REJECTED: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  INVALID_OWNER_TRANSITION: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
  ACTION_TOO_LATE: { category: 'TERMINAL', retryDisposition: 'DO_NOT_RETRY' },
} as const satisfies Record<
  string,
  { category: string; retryDisposition: Exclude<J2RetryDisposition, 'NONE'> }
>;

export type J2ErrorCode = keyof typeof J2_ERROR_CONTRACT;
export type J2ErrorCategory = (typeof J2_ERROR_CONTRACT)[J2ErrorCode]['category'];

export const J2_BUSINESS_RESULTS = [
  'DUPLICATE_NO_OP',
  'ALREADY_ADMITTED',
  'ALREADY_SCHEDULED',
  'BLOCK',
  'DEFER',
  'REVIEW',
] as const;

export type J2BusinessResult = (typeof J2_BUSINESS_RESULTS)[number];
export type J2OwnerResultCode = J2ErrorCode | J2BusinessResult | J2OwnerResultStatus;
export type J2OwnerResultCategory = J2ErrorCategory | 'BUSINESS';

export class J2PayloadContractError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_CONTRACT_VERSION' | 'PAYLOAD_VALIDATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'J2PayloadContractError';
  }
}

const OUTCOME_TYPES = new Set<string>(INTERACTION_OUTCOME_TYPES);
const COMMAND_TYPES = new Set<string>([
  'ENSURE_CASE',
  'ADMIT_CAMPAIGN_TARGET',
  'SCHEDULE_CALLBACK',
  'CANCEL_CAMPAIGN_TARGET',
  'CANCEL_CALLBACK',
  'SUPERSEDE_CAMPAIGN_TARGET',
  'SUPERSEDE_CALLBACK',
]);

function fail(field: string, reason: string): never {
  throw new J2PayloadContractError('PAYLOAD_VALIDATION_FAILED', `${field}: ${reason}`);
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

function contractVersion(value: unknown): asserts value is typeof J2_CONTRACT_VERSION {
  if (value !== J2_CONTRACT_VERSION) {
    throw new J2PayloadContractError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `ไม่รองรับ J2 contractVersion: ${String(value)}`,
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

function stableCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    fail(field, 'ต้องเป็น allowlisted machine code รูปแบบ UPPER_SNAKE_CASE');
  }
}

function hashValue(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(field, 'ต้องเป็น lowercase SHA-256');
  }
}

function validateOutcomeReference(value: unknown, field: string): J2OutcomeReferenceV1 {
  const candidate = objectValue(value, field);
  exactKeys(candidate, field, ['outcomeType', 'outcomeId', 'outcomeVersion']);
  if (!OUTCOME_TYPES.has(String(candidate.outcomeType))) fail(`${field}.outcomeType`, 'ไม่รองรับ');
  opaqueReference(candidate.outcomeId, `${field}.outcomeId`);
  positiveVersion(candidate.outcomeVersion, `${field}.outcomeVersion`);
  return candidate as J2OutcomeReferenceV1;
}

export function validateInteractionOutcomePayload(value: unknown): InteractionOutcomePayloadV1 {
  const candidate = objectValue(value, 'payload');
  exactKeys(
    candidate,
    'payload',
    [
      'contractVersion',
      'outcomeType',
      'outcomeId',
      'outcomeVersion',
      'interactionId',
      'outcomeCode',
      'effectiveAt',
    ],
    ['contactId', 'supersedesVersion'],
  );
  contractVersion(candidate.contractVersion);
  if (!OUTCOME_TYPES.has(String(candidate.outcomeType))) fail('payload.outcomeType', 'ไม่รองรับ');
  opaqueReference(candidate.outcomeId, 'payload.outcomeId');
  positiveVersion(candidate.outcomeVersion, 'payload.outcomeVersion');
  opaqueReference(candidate.interactionId, 'payload.interactionId');
  if (candidate.contactId !== undefined) opaqueReference(candidate.contactId, 'payload.contactId');
  stableCode(candidate.outcomeCode, 'payload.outcomeCode');
  const allowedOutcomeCodes = INTERACTION_OUTCOME_CODES[
    candidate.outcomeType as InteractionOutcomeType
  ] as readonly string[];
  if (!allowedOutcomeCodes.includes(candidate.outcomeCode as string)) {
    fail('payload.outcomeCode', 'ไม่อยู่ใน outcomeType allowlist');
  }
  timestamp(candidate.effectiveAt, 'payload.effectiveAt');
  if (candidate.supersedesVersion !== undefined) {
    positiveVersion(candidate.supersedesVersion, 'payload.supersedesVersion');
    if ((candidate.supersedesVersion as number) >= (candidate.outcomeVersion as number)) {
      fail('payload.supersedesVersion', 'ต้องน้อยกว่า outcomeVersion');
    }
  }
  return candidate as InteractionOutcomePayloadV1;
}

const COMMAND_COMMON_REQUIRED = [
  'contractVersion',
  'commandId',
  'actionKey',
  'requestHash',
  'journeyId',
  'journeyVersion',
  'enrollmentId',
  'stepId',
  'sourceOutcome',
  'interactionId',
  'contactId',
  'sourceOwnerTeamId',
  'targetOwnerTeamId',
  'commandType',
  'intent',
] as const;

function validateCommandIntent(commandType: J2OwnerCommandType, value: unknown): void {
  const intent = objectValue(value, 'payload.intent');
  switch (commandType) {
    case 'ENSURE_CASE':
      exactKeys(intent, 'payload.intent', ['caseTypePolicyRef', 'routingPolicyRef']);
      opaqueReference(intent.caseTypePolicyRef, 'payload.intent.caseTypePolicyRef');
      opaqueReference(intent.routingPolicyRef, 'payload.intent.routingPolicyRef');
      return;
    case 'ADMIT_CAMPAIGN_TARGET':
      exactKeys(intent, 'payload.intent', ['campaignId']);
      opaqueReference(intent.campaignId, 'payload.intent.campaignId');
      return;
    case 'SCHEDULE_CALLBACK':
      exactKeys(intent, 'payload.intent', ['requestedFor', 'queueId'], ['agentId']);
      timestamp(intent.requestedFor, 'payload.intent.requestedFor');
      opaqueReference(intent.queueId, 'payload.intent.queueId');
      if (intent.agentId !== undefined) opaqueReference(intent.agentId, 'payload.intent.agentId');
      return;
    case 'CANCEL_CAMPAIGN_TARGET':
    case 'CANCEL_CALLBACK':
      exactKeys(intent, 'payload.intent', ['originalActionKey', 'reasonCode']);
      opaqueReference(intent.originalActionKey, 'payload.intent.originalActionKey');
      stableCode(intent.reasonCode, 'payload.intent.reasonCode');
      return;
    case 'SUPERSEDE_CAMPAIGN_TARGET':
    case 'SUPERSEDE_CALLBACK':
      exactKeys(intent, 'payload.intent', [
        'originalActionKey',
        'reasonCode',
        'supersedingOutcome',
      ]);
      opaqueReference(intent.originalActionKey, 'payload.intent.originalActionKey');
      stableCode(intent.reasonCode, 'payload.intent.reasonCode');
      validateOutcomeReference(intent.supersedingOutcome, 'payload.intent.supersedingOutcome');
  }
}

export function validateOwnerCommandPayload(value: unknown): J2OwnerCommandPayloadV1 {
  const candidate = objectValue(value, 'payload');
  exactKeys(candidate, 'payload', COMMAND_COMMON_REQUIRED, ['expectedOwnerVersion']);
  contractVersion(candidate.contractVersion);
  opaqueReference(candidate.commandId, 'payload.commandId');
  opaqueReference(candidate.actionKey, 'payload.actionKey');
  hashValue(candidate.requestHash, 'payload.requestHash');
  opaqueReference(candidate.journeyId, 'payload.journeyId');
  positiveVersion(candidate.journeyVersion, 'payload.journeyVersion');
  opaqueReference(candidate.enrollmentId, 'payload.enrollmentId');
  opaqueReference(candidate.stepId, 'payload.stepId');
  validateOutcomeReference(candidate.sourceOutcome, 'payload.sourceOutcome');
  opaqueReference(candidate.interactionId, 'payload.interactionId');
  opaqueReference(candidate.contactId, 'payload.contactId');
  opaqueReference(candidate.sourceOwnerTeamId, 'payload.sourceOwnerTeamId');
  opaqueReference(candidate.targetOwnerTeamId, 'payload.targetOwnerTeamId');
  if (!COMMAND_TYPES.has(String(candidate.commandType))) fail('payload.commandType', 'ไม่รองรับ');
  if (candidate.expectedOwnerVersion !== undefined) {
    nonNegativeVersion(candidate.expectedOwnerVersion, 'payload.expectedOwnerVersion');
  }
  validateCommandIntent(candidate.commandType as J2OwnerCommandType, candidate.intent);
  const command = candidate as J2OwnerCommandPayloadV1;
  if (
    'originalActionKey' in command.intent &&
    command.intent.originalActionKey !== command.actionKey
  ) {
    fail('payload.intent.originalActionKey', 'ต้องตรงกับ actionKey ของ positive effect เดิม');
  }
  return command;
}

const STATUS_BY_COMMAND: Readonly<Record<J2OwnerCommandType, ReadonlySet<J2OwnerResultStatus>>> = {
  ENSURE_CASE: new Set(['CREATED', 'LINKED', 'REOPENED', 'REJECTED']),
  ADMIT_CAMPAIGN_TARGET: new Set(['ADMITTED', 'ALREADY_ADMITTED', 'REJECTED']),
  SCHEDULE_CALLBACK: new Set(['SCHEDULED', 'ALREADY_SCHEDULED', 'REJECTED']),
  CANCEL_CAMPAIGN_TARGET: new Set(['CANCELLED', 'TOO_LATE', 'REJECTED']),
  CANCEL_CALLBACK: new Set(['CANCELLED', 'TOO_LATE', 'REJECTED']),
  SUPERSEDE_CAMPAIGN_TARGET: new Set(['SUPERSEDED', 'TOO_LATE', 'REJECTED']),
  SUPERSEDE_CALLBACK: new Set(['SUPERSEDED', 'TOO_LATE', 'REJECTED']),
};

const AGGREGATE_TYPE_BY_COMMAND: Readonly<
  Record<J2OwnerCommandType, J2OwnerAggregateReferenceV1['type']>
> = {
  ENSURE_CASE: 'case',
  ADMIT_CAMPAIGN_TARGET: 'campaign_target',
  SCHEDULE_CALLBACK: 'callback',
  CANCEL_CAMPAIGN_TARGET: 'campaign_target',
  CANCEL_CALLBACK: 'callback',
  SUPERSEDE_CAMPAIGN_TARGET: 'campaign_target',
  SUPERSEDE_CALLBACK: 'callback',
};

const RECEIPT_AGGREGATE_TYPE_BY_COMMAND: Readonly<Record<J2OwnerCommandType, string>> = {
  ENSURE_CASE: 'case_command_receipt',
  ADMIT_CAMPAIGN_TARGET: 'dialer_command_receipt',
  SCHEDULE_CALLBACK: 'dialer_command_receipt',
  CANCEL_CAMPAIGN_TARGET: 'dialer_command_receipt',
  CANCEL_CALLBACK: 'dialer_command_receipt',
  SUPERSEDE_CAMPAIGN_TARGET: 'dialer_command_receipt',
  SUPERSEDE_CALLBACK: 'dialer_command_receipt',
};

const FAILURE_CLASSES = new Set<J2FailureClass>([
  'NONE',
  'TRANSIENT',
  'BUSINESS',
  'AUTHORIZATION',
  'CONTRACT',
]);
const RETRY_DISPOSITIONS = new Set<J2RetryDisposition>([
  'NONE',
  'RETRY_SAME_IDENTITY',
  'RECONCILE',
  'QUARANTINE',
  'DEAD_LETTER',
  'DO_NOT_RETRY',
]);

function validateOwnerAggregate(value: unknown): J2OwnerAggregateReferenceV1 {
  const aggregate = objectValue(value, 'payload.ownerAggregate');
  exactKeys(aggregate, 'payload.ownerAggregate', ['type', 'id', 'version']);
  if (!['case', 'campaign_target', 'callback'].includes(String(aggregate.type))) {
    fail('payload.ownerAggregate.type', 'ไม่รองรับ');
  }
  opaqueReference(aggregate.id, 'payload.ownerAggregate.id');
  positiveVersion(aggregate.version, 'payload.ownerAggregate.version');
  return aggregate as J2OwnerAggregateReferenceV1;
}

export function validateOwnerResultPayload(value: unknown): J2OwnerResultPayloadV1 {
  const candidate = objectValue(value, 'payload');
  exactKeys(
    candidate,
    'payload',
    [
      'contractVersion',
      'commandId',
      'actionKey',
      'requestHash',
      'commandType',
      'status',
      'code',
      'category',
      'reasonCode',
      'failureClass',
      'retryDisposition',
      'observedAt',
    ],
    ['ownerAggregate', 'auditRef'],
  );
  contractVersion(candidate.contractVersion);
  opaqueReference(candidate.commandId, 'payload.commandId');
  opaqueReference(candidate.actionKey, 'payload.actionKey');
  hashValue(candidate.requestHash, 'payload.requestHash');
  if (!COMMAND_TYPES.has(String(candidate.commandType))) fail('payload.commandType', 'ไม่รองรับ');
  const commandType = candidate.commandType as J2OwnerCommandType;
  if (!STATUS_BY_COMMAND[commandType].has(candidate.status as J2OwnerResultStatus)) {
    fail('payload.status', `ไม่รองรับสำหรับ ${commandType}`);
  }
  stableCode(candidate.reasonCode, 'payload.reasonCode');
  if (!FAILURE_CLASSES.has(candidate.failureClass as J2FailureClass)) {
    fail('payload.failureClass', 'ไม่รองรับ');
  }
  if (!RETRY_DISPOSITIONS.has(candidate.retryDisposition as J2RetryDisposition)) {
    fail('payload.retryDisposition', 'ไม่รองรับ');
  }
  timestamp(candidate.observedAt, 'payload.observedAt');
  const ownerAggregate =
    candidate.ownerAggregate === undefined
      ? undefined
      : validateOwnerAggregate(candidate.ownerAggregate);
  if (candidate.auditRef !== undefined) opaqueReference(candidate.auditRef, 'payload.auditRef');

  const status = candidate.status as J2OwnerResultStatus;
  const code = candidate.code as J2OwnerResultCode;
  const category = candidate.category as J2OwnerResultCategory;
  const positive = status !== 'REJECTED' && status !== 'TOO_LATE';
  if (positive && candidate.ownerAggregate === undefined) {
    fail('payload.ownerAggregate', 'canonical successต้องอ้าง owner aggregate');
  }
  if (ownerAggregate && ownerAggregate.type !== AGGREGATE_TYPE_BY_COMMAND[commandType]) {
    fail('payload.ownerAggregate.type', `ต้องตรงกับ owner ของ ${commandType}`);
  }
  if (positive && (candidate.failureClass !== 'NONE' || candidate.retryDisposition !== 'NONE')) {
    fail('payload.failureClass', 'canonical successต้องใช้ NONE/NONE');
  }
  if (positive && (code !== status || category !== 'BUSINESS')) {
    fail('payload.code', 'canonical successต้องใช้ status เป็น code และ BUSINESS category');
  }
  if (status === 'TOO_LATE') {
    if (candidate.failureClass !== 'BUSINESS' || candidate.retryDisposition !== 'DO_NOT_RETRY') {
      fail('payload.failureClass', 'TOO_LATEต้องใช้ BUSINESS/DO_NOT_RETRY');
    }
    if (code !== 'ACTION_TOO_LATE' || category !== J2_ERROR_CONTRACT.ACTION_TOO_LATE.category) {
      fail('payload.code', 'TOO_LATEต้องใช้ ACTION_TOO_LATE terminal code');
    }
  }
  if (status === 'REJECTED' && candidate.failureClass === 'NONE') {
    fail('payload.failureClass', 'REJECTEDต้องมี failure class');
  }
  if (status === 'REJECTED') {
    const error = J2_ERROR_CONTRACT[code as J2ErrorCode];
    if (
      !error ||
      category !== error.category ||
      candidate.retryDisposition !== error.retryDisposition
    ) {
      fail('payload.code', 'REJECTEDต้องใช้ frozen error code/category/retryDisposition');
    }
  }
  return candidate as J2OwnerResultPayloadV1;
}

export function validateOwnerActionQuery(value: unknown): J2OwnerActionQueryV1 {
  const candidate = objectValue(value, 'query');
  exactKeys(candidate, 'query', ['contractVersion', 'actionKey', 'requestHash']);
  contractVersion(candidate.contractVersion);
  opaqueReference(candidate.actionKey, 'query.actionKey');
  hashValue(candidate.requestHash, 'query.requestHash');
  return candidate as J2OwnerActionQueryV1;
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

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalInteractionOutcomeHash(value: unknown): string {
  return sha256(validateInteractionOutcomePayload(value));
}

export function canonicalOwnerRequestHash(
  tenant: TenantId,
  value: J2OwnerCommandDraftV1 | J2OwnerCommandPayloadV1,
): string {
  const {
    requestHash: _requestHash,
    commandId: _commandId,
    ...semanticCommand
  } = value as J2OwnerCommandPayloadV1;
  return sha256({ tenantId: tenant, ...semanticCommand });
}

export function withOwnerRequestHash(
  tenant: TenantId,
  value: J2OwnerCommandDraftV1,
): J2OwnerCommandPayloadV1 {
  return {
    ...value,
    requestHash: canonicalOwnerRequestHash(tenant, value),
  } as J2OwnerCommandPayloadV1;
}

export function assertOwnerRequestHash(tenant: TenantId, value: unknown): J2OwnerCommandPayloadV1 {
  const command = validateOwnerCommandPayload(value);
  if (command.requestHash !== canonicalOwnerRequestHash(tenant, command)) {
    fail('payload.requestHash', 'ไม่ตรงกับ canonical tenant/action/target/intent fields');
  }
  return command;
}

function validateEnvelope(value: unknown): J2KafkaEnvelopeV2<Record<string, unknown>> {
  const candidate = objectValue(value, 'envelope');
  if (candidate.schemaVersion !== 2) fail('envelope.schemaVersion', 'J2 ต้องใช้ Kafka V2');
  if (candidate.eventKind !== 'CANONICAL' && candidate.eventKind !== 'COMMAND') {
    fail('envelope.eventKind', 'ต้องเป็น CANONICAL หรือ COMMAND');
  }
  opaqueReference(candidate.eventId, 'envelope.eventId');
  opaqueReference(candidate.type, 'envelope.type');
  stableCode(candidate.type.replaceAll('.', '_').toUpperCase(), 'envelope.type');
  opaqueReference(candidate.tenantId, 'envelope.tenantId');
  timestamp(candidate.occurredAt, 'envelope.occurredAt');
  opaqueReference(candidate.correlationId, 'envelope.correlationId');
  if (candidate.causationId !== undefined)
    opaqueReference(candidate.causationId, 'envelope.causationId');
  opaqueReference(candidate.orderingKey, 'envelope.orderingKey');
  opaqueReference(candidate.aggregateType, 'envelope.aggregateType');
  opaqueReference(candidate.aggregateId, 'envelope.aggregateId');
  nonNegativeVersion(candidate.aggregateVersion, 'envelope.aggregateVersion');
  objectValue(candidate.payload, 'envelope.payload');
  return candidate as J2KafkaEnvelopeV2<Record<string, unknown>>;
}

export function assertInteractionOutcomeEnvelope(
  value: unknown,
): J2KafkaEnvelopeV2<InteractionOutcomePayloadV1> {
  const envelope = validateEnvelope(value);
  const payload = validateInteractionOutcomePayload(envelope.payload);
  if (
    envelope.eventKind !== 'CANONICAL' ||
    envelope.type !== J2_EVENT_TYPES.INTERACTION_OUTCOME_RECORDED ||
    envelope.aggregateType !== 'interaction_outcome' ||
    envelope.aggregateId !== payload.outcomeId ||
    envelope.aggregateVersion !== payload.outcomeVersion ||
    envelope.orderingKey !== payload.interactionId
  ) {
    fail('envelope', 'interaction outcome V2 metadata ไม่ตรงกับ canonical payload');
  }
  return { ...envelope, payload };
}

export function assertOwnerCommandEnvelope(
  value: unknown,
): J2KafkaEnvelopeV2<J2OwnerCommandPayloadV1> {
  const envelope = validateEnvelope(value);
  const command = assertOwnerRequestHash(tenantId(envelope.tenantId), envelope.payload);
  if (
    envelope.eventKind !== 'COMMAND' ||
    envelope.eventId !== command.commandId ||
    envelope.type !== J2_COMMAND_EVENT_TYPE[command.commandType] ||
    envelope.aggregateType !== 'journey_action' ||
    envelope.aggregateId !== command.actionKey ||
    envelope.aggregateVersion !== 0 ||
    envelope.orderingKey !== command.actionKey
  ) {
    fail('envelope', 'owner command V2 metadata ไม่ตรงกับ payload');
  }
  return { ...envelope, payload: command };
}

export function assertOwnerResultEnvelope(
  value: unknown,
): J2KafkaEnvelopeV2<J2OwnerResultPayloadV1> {
  const envelope = validateEnvelope(value);
  const result = validateOwnerResultPayload(envelope.payload);
  if (
    envelope.eventKind !== 'CANONICAL' ||
    envelope.type !== J2_RESULT_EVENT_TYPE[result.commandType] ||
    envelope.aggregateType !== RECEIPT_AGGREGATE_TYPE_BY_COMMAND[result.commandType] ||
    envelope.aggregateId !== result.commandId ||
    envelope.aggregateVersion < 1 ||
    envelope.orderingKey !== result.actionKey
  ) {
    fail('envelope', 'owner result V2 metadata ไม่ตรงกับ payload');
  }
  return { ...envelope, payload: result };
}

/**
 * J2.8 (#136): envelope ของผลที่ owner publish กลับ — owner ทุกรายใช้ builder เดียวกันจึงไม่ต้องรู้
 * metadata rule ของ contract เอง ผลลัพธ์ผ่าน `assertOwnerResultEnvelope` เสมอ
 *
 * eventId คงที่ต่อ commandId: receipt ของ owner immutable การ publish ซ้ำหลัง redelivery จึงเป็น
 * event เดิม ไม่ใช่ผลใบใหม่ และ causation ชี้ command envelope ที่ทำให้เกิดผลนี้
 */
export function createOwnerResultEnvelope(
  command: J2KafkaEnvelopeV2<J2OwnerCommandPayloadV1>,
  resultValue: J2OwnerResultPayloadV1,
  occurredAt: string,
): J2KafkaEnvelopeV2<J2OwnerResultPayloadV1> {
  const result = validateOwnerResultPayload(resultValue);
  const envelope = assertOwnerResultEnvelope({
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: `${result.commandId}:result`,
    type: J2_RESULT_EVENT_TYPE[result.commandType],
    tenantId: command.tenantId,
    occurredAt,
    correlationId: command.correlationId,
    causationId: command.eventId,
    orderingKey: result.actionKey,
    aggregateType: RECEIPT_AGGREGATE_TYPE_BY_COMMAND[result.commandType],
    aggregateId: result.commandId,
    aggregateVersion: 1,
    payload: result,
  });
  assertOwnerResultBinding(command, envelope);
  return envelope;
}

const J2_COMMAND_ENVELOPE_TYPES = new Set<string>(Object.values(J2_COMMAND_EVENT_TYPE));

export type OwnerCommandProcessingOutcome =
  | { outcome: 'PROCESSED'; commandId: CommandId }
  | { outcome: 'IGNORED' }
  /** ห้าม retry: command อ่านไม่ได้ตาม contract หรือ commandId/actionKey เดิมแต่เนื้อหาต่าง */
  | {
      outcome: 'QUARANTINED';
      code: 'PAYLOAD_VALIDATION_FAILED' | 'UNSUPPORTED_CONTRACT_VERSION' | 'IDEMPOTENCY_CONFLICT';
    };

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Error && (error as Error & { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT'
  );
}

/**
 * J2.8 (#136): ประมวลผล owner command หนึ่งใบสำหรับ owner transport ใดก็ได้ (ไม่ผูก Kafka)
 *
 * 1. `assertOwnerCommandEnvelope` — envelope/requestHash ต้องผ่าน contract
 * 2. `owner.persistCommand` — receipt + canonical mutation ใน transaction เดียวของ owner
 * 3. อ่านผลจาก receipt แล้ว `publish(createOwnerResultEnvelope(...))`
 *
 * crash ระหว่าง 2 กับ 3 → redelivery เจอ receipt เดิมแล้ว publish ผลเดิมซ้ำด้วย eventId เดิม receipt
 * ของ owner จึงทำหน้าที่ result outbox โดยตรง
 *
 * แยกผลสามแบบให้ transport ตัดสิน: `IGNORED` (ไม่ใช่ J2 owner command), `QUARANTINED` (ผิด contract
 * หรือ IDEMPOTENCY_CONFLICT — retry กี่ครั้งก็ได้ผลเดิม ต้องกักไว้ไม่ให้ block คิว) ส่วน error อื่น
 * (DB/broker ล่ม) ถูกโยนต่อเพื่อให้ retry ด้วย identity เดิม
 */
export async function processOwnerCommandEvent<TCommand extends J2OwnerCommandPayloadV1>(
  event: unknown,
  options: {
    owner: J2OwnerPort<TCommand>;
    publish: (envelope: J2KafkaEnvelopeV2<J2OwnerResultPayloadV1>) => Promise<void>;
    now: () => Date;
  },
): Promise<OwnerCommandProcessingOutcome> {
  const type = (event as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !J2_COMMAND_ENVELOPE_TYPES.has(type)) {
    return { outcome: 'IGNORED' };
  }

  let command: J2KafkaEnvelopeV2<J2OwnerCommandPayloadV1>;
  try {
    command = assertOwnerCommandEnvelope(event);
  } catch (error) {
    if (error instanceof J2PayloadContractError)
      return { outcome: 'QUARANTINED', code: error.code };
    throw error;
  }
  const tenant = tenantId(command.tenantId);
  const payload = command.payload as TCommand;
  try {
    await options.owner.persistCommand(tenant, payload);
  } catch (error) {
    if (isIdempotencyConflict(error))
      return { outcome: 'QUARANTINED', code: 'IDEMPOTENCY_CONFLICT' };
    throw error;
  }
  const result = await options.owner.queryAction(tenant, {
    contractVersion: J2_CONTRACT_VERSION,
    actionKey: payload.actionKey,
    requestHash: payload.requestHash,
  });
  if (!result) {
    throw new Error(`owner receipt ของ command ${payload.commandId} หายหลัง persistCommand`);
  }
  await options.publish(createOwnerResultEnvelope(command, result, options.now().toISOString()));
  return { outcome: 'PROCESSED', commandId: payload.commandId };
}

export function assertOwnerCommandCausation(outcomeValue: unknown, commandValue: unknown): void {
  const outcome = assertInteractionOutcomeEnvelope(outcomeValue);
  const command = assertOwnerCommandEnvelope(commandValue);
  if (
    command.tenantId !== outcome.tenantId ||
    command.correlationId !== outcome.correlationId ||
    command.causationId !== outcome.eventId ||
    command.payload.interactionId !== outcome.payload.interactionId ||
    command.payload.sourceOutcome.outcomeType !== outcome.payload.outcomeType ||
    command.payload.sourceOutcome.outcomeId !== outcome.payload.outcomeId ||
    command.payload.sourceOutcome.outcomeVersion !== outcome.payload.outcomeVersion
  ) {
    fail(
      'envelope',
      'owner command ต้อง bind tenant/root correlation/causation และ source outcome',
    );
  }
}

export function assertOwnerResultBinding(commandValue: unknown, resultValue: unknown): void {
  const command = assertOwnerCommandEnvelope(commandValue);
  const result = assertOwnerResultEnvelope(resultValue);
  if (
    result.tenantId !== command.tenantId ||
    result.correlationId !== command.correlationId ||
    result.causationId !== command.eventId ||
    result.payload.commandId !== command.payload.commandId ||
    result.payload.actionKey !== command.payload.actionKey ||
    result.payload.requestHash !== command.payload.requestHash ||
    result.payload.commandType !== command.payload.commandType
  ) {
    fail('envelope', 'owner result ต้อง bind tenant/command/action/request/correlation/causation');
  }
}

export function assertOwnerResultQueryBinding(queryValue: unknown, resultValue: unknown): void {
  const query = validateOwnerActionQuery(queryValue);
  const result = validateOwnerResultPayload(resultValue);
  if (result.actionKey !== query.actionKey || result.requestHash !== query.requestHash) {
    fail('result', 'owner query result ต้อง bind actionKey และ requestHash เดิม');
  }
}
