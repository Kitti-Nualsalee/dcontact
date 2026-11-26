/**
 * Owner: Delivery/Channels: controlled vocabulary of the S2 LINE provider pilot (#365)
 *
 * Authority: Phase Contract #362 §3/§5/§6/§9/§10 and decisions #357/#358/#359/#361
 *
 * This file is a purely cross-domain contract: no provider SDK, network, credential value or PII.
 * Control flow must use only the values in these unions; free-form detail is redacted diagnostics.
 * Every value set must match the Postgres enums in migration `20260922160100_add_s2_line_persistence`
 * (checked by `line-delivery.test.ts`)
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

/** adapter identity in `dl_outbox_entries.adapter`; the caller-facing DeliveryPort does not see this value */
export const DELIVERY_ADAPTERS = ['TEST_ADAPTER', 'LINE_MESSAGING_API'] as const;
export type DeliveryAdapter = (typeof DELIVERY_ADAPTERS)[number];

/** The single S2 profile: the caps below are tied to this name; raising them requires a new decision (#358 §C) */
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

/**
 * #567: UAT send/receive trial window (amendment #358 2026-10-01): one authorization per recipient, usable for many deliveries.
 * These values are the "ceilings" that the DB enforces again (`dl_line_run_authorizations_caps_check`); the actual caps live in the authorization.
 */
export const LINE_TEAM_TRIAL_PROFILE = 'S2_LINE_TEAM_TRIAL_V1';

export const LINE_TEAM_TRIAL_MAX_CAPS = Object.freeze({
  logicalDeliveriesPerRun: 600,
  logicalDeliveriesPerRecipientPer24h: 20,
  logicalDeliveriesPer24h: 100,
  logicalDeliveriesLifetime: 3000,
  runAuthorizationTtlDays: 30,
  providerAttemptsPerLogicalDelivery: 4,
  /** reply text (T2) */
  textMaxLength: 500,
});

/** allowlisted content class in the trial: free text <=500 characters (the digest of the real text lives in the trial send) */
export const LINE_TEAM_TRIAL_CONTENT_CLASS = 'content-class:text-500/v1';

export const LINE_RUN_PROFILES = [LINE_PILOT_PROFILE, LINE_TEAM_TRIAL_PROFILE] as const;
export type LineRunProfile = (typeof LINE_RUN_PROFILES)[number];

/** A retry with the same X-Line-Retry-Key must finish within 24 hours of the first request (#357 §3) */
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
 * Every outcome maps to a single class (#357 §5). `LINE_RESPONSE_INVALID` stays an unknown that is reconciled
 * with the same key; quarantine happens only when the window expires (`LINE_RETRY_WINDOW_EXPIRED`)
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
 * Rejections are split in two because they count Attempts differently (#361 §B): recipient-specific = Attempt 1,
 * operational (auth/schema/quota/rate) = Attempt 0. auth/rate/quota are always operational
 */
/** LINE-specific names per the shared vocabulary, derived directly so the two sides cannot drift apart */
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
  // cap codes carried over from the S1 simulation (`line-caps-tracker.ts`) + new boundaries from #358 §C
  'SUBMISSION_WINDOW_CAP_EXCEEDED',
  'CONCURRENT_SUBMISSION_CAP_EXCEEDED',
  'CONTACT_WINDOW_CAP_EXCEEDED',
  'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
  'RUN_DELIVERY_CAP_EXCEEDED',
  'LIFETIME_CAP_EXCEEDED',
  'PROVIDER_ATTEMPT_CAP_EXCEEDED',
  // ledger disagrees with what the caller asked for, so caps can no longer be counted (e.g. waking a delivery that was already released)
  // - this is a cap code per #362 §10 and an automatic kill trigger per #358 §F
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

// ── Credential reference (#358 §G): no secret value in this contract ─────────────

export const LINE_CREDENTIAL_KINDS = [
  'CHANNEL_ACCESS_TOKEN_V2_1',
  'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
  'CHANNEL_SECRET',
] as const;
export type LineCredentialKind = (typeof LINE_CREDENTIAL_KINDS)[number];

export const LINE_CREDENTIAL_STATUSES = ['CANDIDATE', 'ACTIVE', 'RETIRED', 'REVOKED'] as const;
export type LineCredentialStatus = (typeof LINE_CREDENTIAL_STATUSES)[number];

/** A v2.1 token with a lifetime of at most 30 days is the recommended value; long-lived needs an exception ref and revocation after S2 */
export const LINE_V2_1_TOKEN_MAX_DAYS = 30;

// ── Attempt/Touch evidence (#361 §D/§E) ─────────────────────────────────────

/** A LINE Touch can arise from only these two forms: no time-window inference */
export const TOUCH_EVIDENCE_KINDS = ['USER_QUOTED_RESPONSE', 'SIGNED_POSTBACK'] as const;
export type TouchEvidenceKind = (typeof TOUCH_EVIDENCE_KINDS)[number];

export const LINE_TOUCH_CORRELATION_STATES = ['PENDING', 'BOUND', 'QUARANTINED'] as const;
export type LineTouchCorrelationState = (typeof LINE_TOUCH_CORRELATION_STATES)[number];

/**
 * input of `ContactGovernancePort.recordCorrelatedTouch`, which S2.2 will add: the adapter sends only the binding +
 * evidence ref; it must not contain a raw LINE user ID, message body or a Boolean that claims to be authority
 */
export interface RecordCorrelatedTouchInput {
  tenantId: TenantId;
  correlationId: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
  deliveryId: DeliveryId;
  attemptId: string;
  /** opaque ref of `(channelAccountId, webhookEventId)`, unique per tenant */
  responseEvidenceRef: OutcomeRef;
  evidenceKind: TouchEvidenceKind;
  /** provider event timestamp, not the receive time: used to cut the window so a late redelivery is still judged correctly */
  occurredAt: string;
}

/** Governance's decision for one outcome (#362 §4); the adapter must not compute it itself */
export interface DeliverySettlementPolicyDecision {
  countsAsAttempt: boolean;
  countsAsSuccessfulTouch: boolean;
  refundOnFailure: boolean;
}

/** snapshot of the correlated Touch; a duplicate always returns the same values */
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
  /** No accepted Attempt in this tenant yet: the response came before the acceptance commit (#361 §F) */
  'ATTEMPT_NOT_FOUND',
  /** The Attempt exists but is not `PROVIDER_ACCEPTED`: a Touch cannot attach to any other kind of Attempt */
  'ATTEMPT_NOT_ACCEPTED',
  /** The reservation/delivery/actionKey sent does not match the Attempt */
  'TOUCH_BINDING_CONFLICT',
  /** The same evidence ref was used with another binding, or this Attempt already has a Touch from other evidence */
  'TOUCH_EVIDENCE_CONFLICT',
  /** evidence kind outside `TOUCH_EVIDENCE_KINDS`: no time-window inference */
  'TOUCH_EVIDENCE_KIND_UNSUPPORTED',
] as const;
export type CorrelatedTouchErrorCode = (typeof CORRELATED_TOUCH_ERROR_CODES)[number];

export class CorrelatedTouchError extends Error {
  constructor(readonly code: CorrelatedTouchErrorCode) {
    super(`Cannot record correlated Touch: ${code}`);
    this.name = 'CorrelatedTouchError';
  }
}

/** A policy that violates #361/#362 §8, e.g. an acceptance claiming to be a Touch, or a refund outside failure */
export class SettlementPolicyViolationError extends Error {
  readonly code = 'SETTLEMENT_POLICY_VIOLATION';

  constructor(
    readonly outcome: NormalizedDeliveryOutcome,
    readonly decision: DeliverySettlementPolicyDecision,
  ) {
    super(`settlement policy decided ${outcome} in violation of the contract`);
    this.name = 'SettlementPolicyViolationError';
  }
}

/**
 * Owner: Contact Governance (#362 §4): an operation separate from `ContactGovernancePort` because the caller is
 * only the Channels webhook worker; Journey/Dialer/Delivery adapters never correlate a Touch
 *
 * Contract:
 * - idempotent per `(tenantId, responseEvidenceRef)`; a duplicate returns the original snapshot and creates no duplicate row
 * - appends a Touch only to the original accepted Attempt and changes no reservation/Attempt
 * - an Attempt can have a Touch only once; different evidence on the same Attempt = `TOUCH_EVIDENCE_CONFLICT`
 * - a response with no Attempt yet is `ATTEMPT_NOT_FOUND`, so the caller keeps the correlation PENDING
 * - no time-window inference: an `evidenceKind` outside `TOUCH_EVIDENCE_KINDS` is rejected
 */
export interface ContactTouchCorrelationPort {
  recordCorrelatedTouch(input: RecordCorrelatedTouchInput): Promise<CorrelatedTouchView>;
  /**
   * S2.6b (#403): binding of the accepted Attempt that Channels needs to assemble `recordCorrelatedTouch`
   * without reading `cg_*` itself: returns only the `PROVIDER_ACCEPTED` Attempt of that delivery in that tenant
   * none = `null` (the response came before the acceptance commit, or the delivery belongs to another tenant)
   */
  findAcceptedAttempt(input: {
    tenantId: TenantId;
    deliveryId: DeliveryId;
  }): Promise<AcceptedAttemptView | null>;
}

/** snapshot of the accepted Attempt: no contact/identity/recipient */
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
 * one LINE fact -> Governance canonical outcome (#357 §5, #362 §6)
 * unknown and quarantined are not terminal, so they stay `UNKNOWN_RECONCILING`: the sweeper must not release
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
 * LINE Attempt/Touch/refund matrix (#361 §B, #362 §8): a pure function Governance uses to decide
 * acceptance is always Attempt 1/Touch 0/refund 0: the provider accepting the request is not delivery and not a read
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

/** Every event has an eventId that is stable per transition; the consumer dedupes by eventId and accepts out-of-order */
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
  /** type from the provider: an unknown type must be allowed through (forward-compatible), so the set is not closed */
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
 * Field names that must not appear in an event/key/header/evidence (#362 §5): used in negative scans and tests
 * of every owner, not a complete list of all PII
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

/** LINE takes `X-Line-Retry-Key` as a lowercase hexadecimal UUID (#357 §2) */
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
    super(`outcome ${outcomeCode} cannot use rejection scope ${rejectionScope ?? 'empty'}`);
    this.name = 'LineOutcomeScopeError';
  }
}

/**
 * Check that outcome + rejection scope are a valid pair: only TERMINAL_REJECTED needs a scope,
 * and auth/rate/quota must be OPERATIONAL, matching the CHECK of `dl_provider_submission_attempts`
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
