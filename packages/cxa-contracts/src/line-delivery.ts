/**
 * Owner: Delivery/Channels — controlled vocabulary ของ S2 LINE provider pilot (#365)
 *
 * Authority: Phase Contract #362 §3/§5/§6/§9/§10 และ decisions #357/#358/#359/#361
 *
 * ไฟล์นี้เป็นสัญญาข้าม domain ล้วน: ไม่มี provider SDK, network, credential value หรือ PII
 * control flow ต้องใช้ค่าใน union เหล่านี้เท่านั้น — free-form detail เป็น diagnostic ที่ redact แล้ว
 * ค่าทุกชุดต้องตรงกับ Postgres enum ใน migration `20260922160100_add_s2_line_persistence`
 * (`line-delivery.test.ts` ตรวจให้)
 */
import type {
  ActionKey,
  DeliveryId,
  OutcomeRef,
  ProviderRequestKey,
  ReservationId,
  TenantId,
} from './identifiers.js';
import type { DeliveryRejectionScope, NormalizedDeliveryOutcome } from './contact-governance.js';

/** identity ของ adapter ใน `dl_outbox_entries.adapter`; caller-facing DeliveryPort ไม่เห็นค่านี้ */
export const DELIVERY_ADAPTERS = ['TEST_ADAPTER', 'LINE_MESSAGING_API'] as const;
export type DeliveryAdapter = (typeof DELIVERY_ADAPTERS)[number];

/** profile เดียวของ S2 — caps ด้านล่างผูกกับชื่อนี้ ปรับสูงขึ้นต้องเป็น decision ใหม่ (#358 §C) */
export const LINE_PILOT_PROFILE = 'S2_LINE_LOCAL_PILOT_V1';

export const LINE_PILOT_CAPS = Object.freeze({
  logicalDeliveriesPerRun: 1,
  runAuthorizationTtlMinutes: 30,
  logicalDeliveriesPerRecipientPer24h: 1,
  logicalDeliveriesPer24h: 3,
  logicalDeliveriesLifetime: 10,
  concurrentSubmissions: 1,
  concurrentUnknownReconciling: 1,
  providerAttemptsPerLogicalDelivery: 4,
});

/** retry ด้วย X-Line-Retry-Key เดิมต้องจบก่อน 24 ชม. นับจาก request แรก (#357 §3) */
export const LINE_RETRY_WINDOW_HOURS = 24;

// ── Outbound provider outcomes (#357 §5, #362 §10) ──────────────────────────

export const LINE_PROVIDER_OUTCOME_CODES = [
  'LINE_ACCEPTED',
  'LINE_ACCEPTED_REPLAY',
  'LINE_REQUEST_REJECTED',
  'LINE_AUTH_INVALID',
  'LINE_RATE_LIMITED',
  'LINE_MONTHLY_QUOTA_EXHAUSTED',
  'LINE_PROVIDER_UNAVAILABLE',
  'LINE_UNKNOWN_OUTCOME',
  'LINE_RESPONSE_INVALID',
  'LINE_RETRY_WINDOW_EXPIRED',
] as const;
export type LineProviderOutcomeCode = (typeof LINE_PROVIDER_OUTCOME_CODES)[number];

export const LINE_PROVIDER_OUTCOME_CLASSES = [
  'ACCEPTED',
  'TERMINAL_REJECTED',
  'RETRYABLE_UNKNOWN',
  'QUARANTINED',
] as const;
export type LineProviderOutcomeClass = (typeof LINE_PROVIDER_OUTCOME_CLASSES)[number];

/**
 * ทุก outcome map ไป class เดียว (#357 §5). `LINE_RESPONSE_INVALID` ยังเป็น unknown ที่ reconcile
 * ต่อด้วย key เดิม — quarantine เกิดเมื่อ window หมดเท่านั้น (`LINE_RETRY_WINDOW_EXPIRED`)
 */
export const LINE_PROVIDER_OUTCOME_CLASS: Readonly<
  Record<LineProviderOutcomeCode, LineProviderOutcomeClass>
> = Object.freeze({
  LINE_ACCEPTED: 'ACCEPTED',
  LINE_ACCEPTED_REPLAY: 'ACCEPTED',
  LINE_REQUEST_REJECTED: 'TERMINAL_REJECTED',
  LINE_AUTH_INVALID: 'TERMINAL_REJECTED',
  LINE_RATE_LIMITED: 'TERMINAL_REJECTED',
  LINE_MONTHLY_QUOTA_EXHAUSTED: 'TERMINAL_REJECTED',
  LINE_PROVIDER_UNAVAILABLE: 'RETRYABLE_UNKNOWN',
  LINE_UNKNOWN_OUTCOME: 'RETRYABLE_UNKNOWN',
  LINE_RESPONSE_INVALID: 'RETRYABLE_UNKNOWN',
  LINE_RETRY_WINDOW_EXPIRED: 'QUARANTINED',
});

/**
 * rejection แยกสองแบบเพราะนับ Attempt ต่างกัน (#361 §B): recipient-specific = Attempt 1,
 * operational (auth/schema/quota/rate) = Attempt 0. auth/rate/quota เป็น operational เสมอ
 */
/** ชื่อเฉพาะของ LINE ต่อ vocabulary กลาง — derive ตรง ๆ เพื่อให้ทั้งสองฝั่งเดินแยกกันไม่ได้ */
export type LineRejectionScope = DeliveryRejectionScope;
export const LINE_REJECTION_SCOPES: readonly LineRejectionScope[] = Object.freeze([
  'RECIPIENT',
  'OPERATIONAL',
]);

export const LINE_ALWAYS_OPERATIONAL_REJECTIONS: readonly LineProviderOutcomeCode[] = Object.freeze(
  ['LINE_AUTH_INVALID', 'LINE_RATE_LIMITED', 'LINE_MONTHLY_QUOTA_EXHAUSTED'],
);

// ── Webhook ingress outcomes (#359 §G) ──────────────────────────────────────

export const LINE_WEBHOOK_CODES = [
  'WEBHOOK_ACCEPTED',
  'WEBHOOK_DUPLICATE',
  'WEBHOOK_EMPTY_VERIFICATION',
  'WEBHOOK_SIGNATURE_INVALID',
  'WEBHOOK_DESTINATION_MISMATCH',
  'WEBHOOK_SCHEMA_INVALID',
  'WEBHOOK_IDEMPOTENCY_CONFLICT',
  'WEBHOOK_UNSUPPORTED_EVENT_TYPE',
  'WEBHOOK_DURABILITY_UNAVAILABLE',
  'WEBHOOK_QUARANTINED',
] as const;
export type LineWebhookCode = (typeof LINE_WEBHOOK_CODES)[number];

export const LINE_WEBHOOK_INBOX_STATES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'QUARANTINED',
] as const;
export type LineWebhookInboxState = (typeof LINE_WEBHOOK_INBOX_STATES)[number];

// ── Rollout gate (#358 §A/§F, #362 §9/§10) ──────────────────────────────────

export const LINE_ROLLOUT_STATES = [
  'DISABLED',
  'DRY_RUN',
  'PROVIDER_CONFORMANCE',
  'CAPPED_PILOT',
] as const;
export type LineRolloutState = (typeof LINE_ROLLOUT_STATES)[number];

export const LINE_KILL_REASONS = [
  'CROSS_TENANT_LEAK',
  'ALLOWLIST_BINDING_MISMATCH',
  'CG3_BYPASS',
  'DUPLICATE_BUSINESS_EFFECT',
  'PII_OR_CREDENTIAL_LEAK',
  'EVIDENCE_HASH_MISMATCH',
  'UNKNOWN_OUTCOME_EXPIRED',
  'PROVIDER_ATTEMPTS_EXHAUSTED',
  'AUTH_FAILURE',
  'QUOTA_EXHAUSTED',
  'CAP_ACCOUNTING_INCONSISTENCY',
  'OPERATOR_KILL',
  'COMPLIANCE_KILL',
  'PILOT_ROLLBACK',
] as const;
export type LineKillReason = (typeof LINE_KILL_REASONS)[number];

export const LINE_GATE_ERROR_CODES = [
  'LINE_GATE_AUTHORIZATION_DENIED',
  'LINE_GATE_SCOPE_NOT_ALLOWED',
  'LINE_GATE_INVALID_TRANSITION',
  'LINE_GATE_KILLED',
  'LINE_GATE_TECHNICAL_SWITCH_OFF',
  // cap codes เดิมจาก S1 simulation (`line-caps-tracker.ts`) + ขอบเขตใหม่ของ #358 §C
  'SUBMISSION_WINDOW_CAP_EXCEEDED',
  'CONCURRENT_SUBMISSION_CAP_EXCEEDED',
  'CONTACT_WINDOW_CAP_EXCEEDED',
  'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
  'RUN_DELIVERY_CAP_EXCEEDED',
  'LIFETIME_CAP_EXCEEDED',
  'PROVIDER_ATTEMPT_CAP_EXCEEDED',
  // ledger กับสิ่งที่ผู้เรียกขอไม่ตรงกันจนนับ cap ต่อไม่ได้ (เช่น ปลุก delivery ที่ release แล้ว)
  // — เป็น cap code ตาม #362 §10 และเป็น automatic kill trigger ตาม #358 §F
  'CAP_ACCOUNTING_INCONSISTENCY',
  // one-shot/credential/config mismatch
  'RUN_AUTHORIZATION_MISSING',
  'RUN_AUTHORIZATION_EXPIRED',
  'RUN_AUTHORIZATION_CONSUMED',
  'CREDENTIAL_UNAVAILABLE',
  'CREDENTIAL_VERSION_MISMATCH',
  'CONFIG_DIGEST_MISMATCH',
] as const;
export type LineGateErrorCode = (typeof LINE_GATE_ERROR_CODES)[number];

export const LINE_RUN_AUTHORIZATION_STATES = [
  'PROPOSED',
  'APPROVED',
  'CONSUMED',
  'EXPIRED',
  'REVOKED',
] as const;
export type LineRunAuthorizationState = (typeof LINE_RUN_AUTHORIZATION_STATES)[number];

export const LINE_CAP_KINDS = [
  'LOGICAL_DELIVERY',
  'PROVIDER_ATTEMPT',
  'CONCURRENT_SUBMISSION',
  'CONCURRENT_UNKNOWN',
] as const;
export type LineCapKind = (typeof LINE_CAP_KINDS)[number];

export const LINE_CAP_RESERVATION_STATES = ['RESERVED', 'COMMITTED', 'RELEASED'] as const;
export type LineCapReservationState = (typeof LINE_CAP_RESERVATION_STATES)[number];

// ── Credential reference (#358 §G) — ไม่มี secret value ในสัญญานี้ ─────────────

export const LINE_CREDENTIAL_KINDS = [
  'CHANNEL_ACCESS_TOKEN_V2_1',
  'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
  'CHANNEL_SECRET',
] as const;
export type LineCredentialKind = (typeof LINE_CREDENTIAL_KINDS)[number];

export const LINE_CREDENTIAL_STATUSES = ['CANDIDATE', 'ACTIVE', 'RETIRED', 'REVOKED'] as const;
export type LineCredentialStatus = (typeof LINE_CREDENTIAL_STATUSES)[number];

/** token v2.1 อายุไม่เกิน 30 วันเป็นค่าแนะนำ; long-lived ต้องมี exception ref และ revoke หลัง S2 */
export const LINE_V2_1_TOKEN_MAX_DAYS = 30;

// ── Attempt/Touch evidence (#361 §D/§E) ─────────────────────────────────────

/** Touch ของ LINE เกิดได้จากสองรูปแบบนี้เท่านั้น — ไม่มี time-window inference */
export const TOUCH_EVIDENCE_KINDS = ['USER_QUOTED_RESPONSE', 'SIGNED_POSTBACK'] as const;
export type TouchEvidenceKind = (typeof TOUCH_EVIDENCE_KINDS)[number];

export const LINE_TOUCH_CORRELATION_STATES = ['PENDING', 'BOUND', 'QUARANTINED'] as const;
export type LineTouchCorrelationState = (typeof LINE_TOUCH_CORRELATION_STATES)[number];

/**
 * input ของ `ContactGovernancePort.recordCorrelatedTouch` ที่ S2.2 จะเพิ่ม — adapter ส่ง binding +
 * evidence ref เท่านั้น ห้ามมี raw LINE user ID, message body หรือ Boolean ที่อ้างตัวเป็น authority
 */
export interface RecordCorrelatedTouchInput {
  tenantId: TenantId;
  correlationId: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
  deliveryId: DeliveryId;
  attemptId: string;
  /** opaque ref ของ `(channelAccountId, webhookEventId)` — unique ต่อ tenant */
  responseEvidenceRef: OutcomeRef;
  evidenceKind: TouchEvidenceKind;
  /** provider event timestamp ไม่ใช่เวลาที่รับ — ใช้ตัด window ให้ redelivery ช้ายังตัดสินถูก */
  occurredAt: string;
}

/** คำตัดสินของ Governance ต่อ outcome หนึ่งใบ (#362 §4); adapter ห้ามคำนวณเอง */
export interface DeliverySettlementPolicyDecision {
  countsAsAttempt: boolean;
  countsAsSuccessfulTouch: boolean;
  refundOnFailure: boolean;
}

/** snapshot ของ Touch ที่ correlate แล้ว; duplicate คืนค่าชุดเดิมเสมอ */
export interface CorrelatedTouchView {
  touchId: string;
  attemptId: string;
  reservationId: ReservationId;
  deliveryId: DeliveryId;
  responseEvidenceRef: OutcomeRef;
  evidenceKind: TouchEvidenceKind;
  occurredAt: string;
}

export const CORRELATED_TOUCH_ERROR_CODES = [
  /** ยังไม่มี accepted Attempt ใน tenant นี้ — response มาก่อน acceptance commit (#361 §F) */
  'ATTEMPT_NOT_FOUND',
  /** Attempt มีจริงแต่ไม่ใช่ `PROVIDER_ACCEPTED` — Touch เกาะ Attempt แบบอื่นไม่ได้ */
  'ATTEMPT_NOT_ACCEPTED',
  /** reservation/delivery/actionKey ที่ส่งมาไม่ตรงกับ Attempt */
  'TOUCH_BINDING_CONFLICT',
  /** evidence ref เดิมถูกใช้กับ binding อื่น หรือ Attempt นี้มี Touch จาก evidence อื่นแล้ว */
  'TOUCH_EVIDENCE_CONFLICT',
  /** evidence kind นอก `TOUCH_EVIDENCE_KINDS` — ไม่มี time-window inference */
  'TOUCH_EVIDENCE_KIND_UNSUPPORTED',
] as const;
export type CorrelatedTouchErrorCode = (typeof CORRELATED_TOUCH_ERROR_CODES)[number];

export class CorrelatedTouchError extends Error {
  constructor(readonly code: CorrelatedTouchErrorCode) {
    super(`ไม่สามารถบันทึก correlated Touch: ${code}`);
    this.name = 'CorrelatedTouchError';
  }
}

/** policy ที่ละเมิด #361/#362 §8 เช่น acceptance ที่อ้างว่าเป็น Touch หรือ refund นอก failure */
export class SettlementPolicyViolationError extends Error {
  readonly code = 'SETTLEMENT_POLICY_VIOLATION';

  constructor(
    readonly outcome: NormalizedDeliveryOutcome,
    readonly decision: DeliverySettlementPolicyDecision,
  ) {
    super(`settlement policy ตัดสิน ${outcome} ผิดสัญญา`);
    this.name = 'SettlementPolicyViolationError';
  }
}

/**
 * Owner: Contact Governance (#362 §4) — operation แยกจาก `ContactGovernancePort` เพราะผู้เรียกคือ
 * webhook worker ของ Channels เท่านั้น ส่วน Journey/Dialer/Delivery adapter ไม่เคย correlate Touch
 *
 * สัญญา:
 * - idempotent ต่อ `(tenantId, responseEvidenceRef)`; duplicate คืน snapshot เดิม ไม่สร้างแถวซ้ำ
 * - append Touch ให้ accepted Attempt เดิมเท่านั้น และไม่เปลี่ยน reservation/Attempt ใด ๆ
 * - Attempt หนึ่งใบมี Touch ได้ครั้งเดียว; evidence คนละใบบน Attempt เดิม = `TOUCH_EVIDENCE_CONFLICT`
 * - response ที่ยังไม่มี Attempt คือ `ATTEMPT_NOT_FOUND` ให้ caller คง correlation เป็น PENDING
 * - ไม่มี time-window inference: `evidenceKind` นอก `TOUCH_EVIDENCE_KINDS` ถูกปฏิเสธ
 */
export interface ContactTouchCorrelationPort {
  recordCorrelatedTouch(input: RecordCorrelatedTouchInput): Promise<CorrelatedTouchView>;
  /**
   * S2.6b (#403): binding ของ accepted Attempt ที่ Channels ต้องใช้ประกอบ `recordCorrelatedTouch`
   * โดยไม่อ่าน `cg_*` เอง — คืนเฉพาะ Attempt `PROVIDER_ACCEPTED` ของ delivery นั้นใน tenant นั้น
   * ไม่มี = `null` (response มาก่อน acceptance commit หรือ delivery ของ tenant อื่น)
   */
  findAcceptedAttempt(input: {
    tenantId: TenantId;
    deliveryId: DeliveryId;
  }): Promise<AcceptedAttemptView | null>;
}

/** snapshot ของ accepted Attempt — ไม่มี contact/identity/recipient */
export interface AcceptedAttemptView {
  attemptId: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
  deliveryId: DeliveryId;
  acceptedAt: string;
}

export function isTouchEvidenceKind(value: unknown): value is TouchEvidenceKind {
  return typeof value === 'string' && (TOUCH_EVIDENCE_KINDS as readonly string[]).includes(value);
}

/**
 * fact ของ LINE หนึ่งใบ → canonical outcome ของ Governance (#357 §5, #362 §6)
 * unknown และ quarantined ยังไม่ terminal จึงคง `UNKNOWN_RECONCILING` — sweeper ห้าม release
 */
export function lineNormalizedOutcome(
  outcomeCode: LineProviderOutcomeCode,
): NormalizedDeliveryOutcome {
  switch (LINE_PROVIDER_OUTCOME_CLASS[outcomeCode]) {
    case 'ACCEPTED':
      return 'PROVIDER_ACCEPTED';
    case 'TERMINAL_REJECTED':
      return 'PROVIDER_REJECTED';
    default:
      return 'UNKNOWN_RECONCILING';
  }
}

/**
 * matrix Attempt/Touch/refund ของ LINE (#361 §B, #362 §8) — pure function ที่ Governance ใช้ตัดสิน
 * acceptance คือ Attempt 1/Touch 0/refund 0 เสมอ: provider รับ request ไม่ใช่ delivery และไม่ใช่ read
 */
export function lineProviderSettlement(
  outcomeCode: LineProviderOutcomeCode,
  rejectionScope?: LineRejectionScope,
): DeliverySettlementPolicyDecision {
  const outcomeClass = assertLineOutcomeScope(outcomeCode, rejectionScope);
  return Object.freeze({
    countsAsAttempt:
      outcomeClass === 'ACCEPTED' ||
      (outcomeClass === 'TERMINAL_REJECTED' && rejectionScope === 'RECIPIENT'),
    countsAsSuccessfulTouch: false,
    refundOnFailure: false,
  });
}

// ── PII-safe events (#362 §5) ───────────────────────────────────────────────

export const LINE_EVENT_TYPES = [
  'delivery.line.lifecycle.v1',
  'channel.line.inbound.v1',
  'contact.touch.correlated.v1',
] as const;
export type LineEventType = (typeof LINE_EVENT_TYPES)[number];

export const LINE_LIFECYCLE_STATES = [
  'PRE_BARRIER',
  'POST_BARRIER',
  'ACCEPTED',
  'RECONCILING',
  'SETTLED',
] as const;
export type LineLifecycleState = (typeof LINE_LIFECYCLE_STATES)[number];

/** ทุก event มี eventId คงที่ต่อ transition เดิม; consumer dedupe ด้วย eventId และรับ out-of-order */
interface LineEventBase {
  eventId: string;
  tenantId: TenantId;
  occurredAt: string;
  correlationId: string;
}

export interface LineDeliveryLifecycleEventV1 extends LineEventBase {
  type: 'delivery.line.lifecycle.v1';
  state: LineLifecycleState;
  actionKey: ActionKey;
  reservationId: ReservationId;
  deliveryId: DeliveryId;
  providerRequestKey: ProviderRequestKey;
  outcomeCode?: LineProviderOutcomeCode;
}

export interface LineInboundEventV1 extends LineEventBase {
  type: 'channel.line.inbound.v1';
  channelAccountId: string;
  webhookEventId: string;
  /** ชนิดจาก provider — unknown type ต้องผ่านได้ (forward-compatible) จึงไม่ปิดชุด */
  eventType: string;
  providerTimestamp: string;
  payloadHash: string;
  protectedPayloadRef: string;
}

export interface ContactTouchCorrelatedEventV1 extends LineEventBase {
  type: 'contact.touch.correlated.v1';
  attemptId: string;
  deliveryId: DeliveryId;
  responseEvidenceRef: OutcomeRef;
  evidenceKind: TouchEvidenceKind;
}

export type LineEventV1 =
  LineDeliveryLifecycleEventV1 | LineInboundEventV1 | ContactTouchCorrelatedEventV1;

/**
 * ชื่อ field ที่ห้ามปรากฏใน event/key/header/evidence (#362 §5) — ใช้ใน negative scan และ test
 * ของ owner ทุกตัว ไม่ใช่รายการครบของ PII ทั้งหมด
 */
export const LINE_FORBIDDEN_EVIDENCE_FIELDS = Object.freeze([
  'userId',
  'recipient',
  'to',
  'text',
  'body',
  'messages',
  'replyToken',
  'quoteToken',
  'postbackData',
  'accessToken',
  'channelAccessToken',
  'channelSecret',
  'signature',
  'x-line-signature',
  'authorization',
]);

/** LINE รับ `X-Line-Retry-Key` เป็น hexadecimal UUID ตัวพิมพ์เล็ก (#357 §2) */
const LINE_RETRY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLineRetryKey(value: string): boolean {
  return LINE_RETRY_KEY_PATTERN.test(value);
}

export class LineOutcomeScopeError extends Error {
  readonly code = 'LINE_OUTCOME_SCOPE_INVALID';

  constructor(
    readonly outcomeCode: LineProviderOutcomeCode,
    readonly rejectionScope: LineRejectionScope | undefined,
  ) {
    super(`outcome ${outcomeCode} ใช้ rejection scope ${rejectionScope ?? 'ว่าง'} ไม่ได้`);
    this.name = 'LineOutcomeScopeError';
  }
}

/**
 * ตรวจว่า outcome + rejection scope เป็นคู่ที่ถูกต้อง: เฉพาะ TERMINAL_REJECTED ต้องมี scope
 * และ auth/rate/quota ต้องเป็น OPERATIONAL — ตรงกับ CHECK ของ `dl_provider_submission_attempts`
 */
export function assertLineOutcomeScope(
  outcomeCode: LineProviderOutcomeCode,
  rejectionScope?: LineRejectionScope,
): LineProviderOutcomeClass {
  const outcomeClass = LINE_PROVIDER_OUTCOME_CLASS[outcomeCode];
  const valid =
    outcomeClass === 'TERMINAL_REJECTED'
      ? rejectionScope !== undefined &&
        (rejectionScope === 'OPERATIONAL' ||
          !LINE_ALWAYS_OPERATIONAL_REJECTIONS.includes(outcomeCode))
      : rejectionScope === undefined;
  if (!valid) throw new LineOutcomeScopeError(outcomeCode, rejectionScope);
  return outcomeClass;
}
