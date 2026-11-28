/** Owner: Contact Governance: a cross-domain contract; no database or transport dependency */
import type {
  ActionKey,
  ContactId,
  DeliveryId,
  IdentityId,
  OutcomeRef,
  ProviderRequestKey,
  ReservationId,
  TenantId,
} from './identifiers.js';
import type { Cg4DecisionTracePinsV1 } from './contact-governance-cg4.js';

export type ContactChannel = 'VOICE' | 'WEBCHAT' | 'LINE' | 'FACEBOOK' | 'WHATSAPP' | 'EMAIL';

export type ContactDecision = 'ALLOW' | 'BLOCK' | 'DEFER' | 'REVIEW';

export type ContactPolicyGate =
  | 'IDENTITY'
  | 'HARD_RESTRICTION'
  | 'CONSENT'
  | 'PREFERENCE'
  | 'MODULE_RULE'
  | 'TEMPORAL_POLICY'
  | 'ATTEMPT_TOUCH_CAP'
  | 'CALLBACK_EXCEPTION'
  | 'APPROVED_EXCEPTION'
  | 'SENDER_IDENTITY'
  | 'KILL_SWITCH'
  /** CG4.10 (#193): the CG4 head-based policy reader cannot check the policy and fails closed */
  | 'POLICY_HEAD'
  /** CG4.10 (#193): the CG3 and CG4 shadow digests differ on the pilot scope */
  | 'MIGRATION_SHADOW'
  | 'RESERVATION';

export interface ContactPolicyTraceEntry {
  gate: ContactPolicyGate;
  outcome: 'PASS' | 'ALLOW' | 'BLOCK' | 'DEFER' | 'REVIEW';
  reasonCode?: string;
  /** #1065: the lawful basis a policy named when it did not require consent (CONSENT gate only) */
  lawfulBasis?: string;
}

export type ReservationState = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'REFUNDED';
export interface RefundReservationCommand {
  type: 'REFUND';
  outcome: 'DELIVERY_FAILED' | 'DELIVERED';
}

export type ReservationCommand = 'CONFIRM' | 'RELEASE' | RefundReservationCommand;

export interface ReservationSnapshot {
  id: string;
  state: ReservationState;
}

export class InvalidReservationTransitionError extends Error {
  readonly code = 'INVALID_RESERVATION_TRANSITION';

  constructor(state: ReservationState, command: ReservationCommand) {
    super(
      `Unsupported reservation transition: ${state} -> ${typeof command === 'string' ? command : command.type}`,
    );
    this.name = 'InvalidReservationTransitionError';
  }
}

export class RefundNotAllowedError extends Error {
  readonly code = 'REFUND_NOT_ALLOWED';

  constructor(readonly outcome: RefundReservationCommand['outcome']) {
    super(`Refunding a reservation is not allowed for outcome ${outcome}`);
    this.name = 'RefundNotAllowedError';
  }
}

interface AuthorizationInputBase {
  channel: ContactChannel;
  purpose: string;
  source: string;
  sourceId: string;
  actionKey: string;
  policyVersion: number;
  teamId?: string;
  /** CG3: extra dimensions for preference/policy scope matching */
  contactKind?: string;
  /** CG3: has not passed the full authority check (S1.6); used only to prepare trace/contract */
  senderIdentityId?: string;
}

export type AuthorizeAndReserveInput = AuthorizationInputBase &
  (
    | {
        contactId: string;
        identityId?: string;
        identityResolution?: never;
      }
    | {
        contactId?: never;
        identityId?: never;
        /** IDENTITY_MAPPING_PENDING: Cus360 C3 (#793) the identity has not been imported as a contact point beyond the retry window */
        identityResolution: 'AMBIGUOUS' | 'NOT_FOUND' | 'IDENTITY_MAPPING_PENDING';
      }
  );

export interface AuthorizationOutcome {
  decisionId: string;
  decision: ContactDecision;
  reasonCode: string;
  policyVersion: number;
  trace: ContactPolicyTraceEntry[];
  reservationId?: string;
  reservationExpiresAt?: string;
  /** CG3: the canonical CgContactStateHead.aggregateVersion used for evaluation at decide time */
  aggregateVersion?: number;
  /** CG3: version of the winning preference record (if any) */
  preferenceVersion?: number;
  /** CG3: the first instant that passes every relevant temporal gate; present only for a DEFER that can be computed */
  nextEligibleAt?: string;
  /** CG3: the timezone source used for evaluation (customer-explicit/customer-360/tenant-default) */
  timezoneSource?: string;
  /** CG3: PII-free scope of the matching preference/policy */
  matchedScope?: Record<string, string | null>;
  matchedWindowRef?: string;
  exceptionMode?: 'NO_OVERRIDE' | 'SCOPED_OVERRIDE' | 'TIME_POLICY_OVERRIDE';
  exceptionRef?: string;
  /** CG4: digest of the immutable facts/policy/exception the decision used; added additively for replay */
  cg4?: Cg4DecisionTracePinsV1;
}

/**
 * S1.5 read-only canonical check for an action that already has a reservation
 * must not create a new decision, reservation, Attempt or Touch; Journey keeps
 * the at-least-once consumer result of this call
 */
export interface RevalidateAuthorizedActionInput {
  tenantId: TenantId;
  reservationId: ReservationId;
  actionKey: ActionKey;
  correlationId: string;
  sourceAggregateType: 'CONTACT' | 'POLICY';
  sourceAggregateId: string;
  sourceAggregateVersion: number;
  /** missing history context must REVIEW fail-closed; never infer ALLOW */
  contactKind?: string;
  /**
   * CG4.8 (#191) additive: CG4 policy/kill events use the scope head or kill switch as the version
   * authority, not the CG3 policy version; not specified = the original CG3 behavior
   */
  sourceContract?: 'CG3' | 'CG4';
  sourceEventType?: string;
  sourceScopeKey?: string;
}

export interface RevalidateAuthorizedActionOutcome {
  decision: ContactDecision;
  reasonCode: string;
  observedAggregateVersion: number;
  observedPolicyVersion?: number;
  nextEligibleAt?: string;
  /** opaque digest of the evaluated facts, with no PII or policy body */
  decisionDigest: string;
}

export interface ContactGovernanceRevalidationPort {
  revalidateAuthorizedAction(
    input: RevalidateAuthorizedActionInput,
  ): Promise<RevalidateAuthorizedActionOutcome>;
}

export interface ReservationView {
  id: string;
  state: ReservationState;
  expiresAt: string;
  confirmedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly actionKey: string) {
    super(`actionKey was already used with different canonical input: ${actionKey}`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ReservationNotFoundError extends Error {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(readonly reservationId: string) {
    super(`Reservation not found in the active tenant: ${reservationId}`);
    this.name = 'ReservationNotFoundError';
  }
}

export type ReservationNotUsableCode =
  'RESERVATION_NOT_FOUND' | 'RESERVATION_NOT_RESERVED' | 'RESERVATION_EXPIRED';

export class ReservationNotUsableError extends Error {
  constructor(
    readonly code: ReservationNotUsableCode,
    readonly reservationId: string,
  ) {
    super(`Cannot use the reservation for delivery: ${code}`);
    this.name = 'ReservationNotUsableError';
  }
}

/** Narrow port for the Foundation; keeps the original signature so it can expand without changing behavior */
export interface ContactAuthorizationPort<TContext = undefined> {
  authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
    context?: TContext,
  ): Promise<AuthorizationOutcome>;
}

/** UNKNOWN_RECONCILING is a delivery settlement status, not a reservation state in the database */
export type DeliverySettlementStatus =
  'UNCLAIMED' | 'CLAIMED' | 'UNKNOWN_RECONCILING' | 'ACCEPTED' | 'SETTLED';

export interface ReservationDeliveryCommand {
  tenantId: TenantId;
  correlationId: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
}

export interface DeliveryBinding {
  deliveryId: DeliveryId;
  contactId: ContactId;
  identityId?: IdentityId;
  channel: ContactChannel;
  purpose: string;
  senderIdentityId: string;
}

export interface ClaimReservationForDeliveryInput
  extends ReservationDeliveryCommand, DeliveryBinding {
  /** Worker lease before provider I/O; must not exceed the reservation expiry */
  leaseExpiresAt: string;
}

export interface BoundDeliveryCommand extends ReservationDeliveryCommand {
  deliveryId: DeliveryId;
}

export interface RenewReservationLeaseInput extends BoundDeliveryCommand {
  expectedLeaseVersion: number;
  leaseExpiresAt: string;
}

export interface BeginProviderSubmissionInput extends BoundDeliveryCommand {
  expectedLeaseVersion: number;
  providerRequestKey: ProviderRequestKey;
}

export interface ConfirmProviderAcceptanceInput extends BoundDeliveryCommand {
  providerRequestKey: ProviderRequestKey;
}

export interface ReleaseBeforeSubmitInput extends ReservationDeliveryCommand {
  /** Before the claim there is no deliveryId; once claimed it must specify the original binding */
  deliveryId?: DeliveryId;
  reason: 'CANCELLED_BEFORE_SUBMIT' | 'LEASE_EXPIRED';
}

/**
 * The adapter sends facts; countsAsAttempt/countsAsTouch and refund are Governance's authority
 *
 * S2 (#361/#362 §6): `PROVIDER_ACCEPTED` means the provider accepted the request (LINE `2xx/409`);
 * it is not `DELIVERED` and not a Touch. A channel with no delivery/read evidence must not emit `DELIVERED`
 */
export type NormalizedDeliveryOutcome =
  | 'UNKNOWN_RECONCILING'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_ACCEPTED'
  | 'DELIVERED'
  | 'DELIVERY_FAILED';

/**
 * Scope of a provider rejection: a fact the adapter reports, not a Boolean it decides itself (#361 §B)
 * `RECIPIENT` = the specific destination was rejected -> Attempt 1
 * `OPERATIONAL` = system auth/schema/quota/rate -> Attempt 0 (the recipient is untouched)
 */
export type DeliveryRejectionScope = 'RECIPIENT' | 'OPERATIONAL';

export interface SettleDeliveryInput extends BoundDeliveryCommand {
  providerRequestKey: ProviderRequestKey;
  outcomeRef: OutcomeRef;
  outcome: NormalizedDeliveryOutcome;
  /**
   * required for `PROVIDER_REJECTED` of a channel that can separate scopes (LINE per #357 §5)
   * not specified = the original S1 behavior, which is Attempt 1; the adapter must not send a scope with any other outcome
   */
  rejectionScope?: DeliveryRejectionScope;
  occurredAt: string;
}

export interface ReservationSettlementView {
  reservationId: ReservationId;
  actionKey: ActionKey;
  deliveryId?: DeliveryId;
  state: ReservationState;
  status: DeliverySettlementStatus;
  /** Snapshot of the command; an old duplicate is not lease authority to resend */
  leaseVersion?: number;
  leaseExpiresAt?: string;
}

export type ReservationBindingErrorCode =
  | ReservationNotUsableCode
  | 'RESERVATION_BINDING_CONFLICT'
  | 'INVALID_RESERVATION_TRANSITION'
  | 'INVALID_RESERVATION_LEASE'
  | 'STALE_RESERVATION_LEASE'
  | 'DELIVERY_RECONCILIATION_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'GOVERNANCE_VERSION_STALE';

export class ReservationBindingError extends Error {
  constructor(readonly code: ReservationBindingErrorCode) {
    super(`Cannot change the delivery binding: ${code}`);
    this.name = 'ReservationBindingError';
  }
}

/**
 * Owner: Contact Governance; the full E0 port has no production implementation yet
 * Every operation must be atomic within a tenant and fail closed when the binding does not match
 * A duplicate canonical input returns the original result; correlationId is a trace, not an idempotency identity
 * A claim starts at leaseVersion=1; renewal uses CAS on the version and is allowed only before the lease expires / before submission
 * beginProviderSubmission must persist the barrier before provider I/O; after the barrier it is considered possibly sent
 * The barrier uses UNKNOWN_RECONCILING without yet being CONFIRMED; the lease/TTL must not release the entitlement after the barrier
 * Confirm/settle accept a result only for the binding/request key that was begun, even if the lease expires while waiting for the result
 * A duplicate response is a snapshot of the original command and does not allow provider I/O again
 * The adapter must hold durable outbox ownership and use a provider-specific idempotency/reconcile gate
 * After the barrier, never release/refund/blind retry on timeout; a terminal refund remains Governance policy
 * The first terminal outcome wins; a late outcome does not revert state and does not create a duplicate Attempt/Touch
 * A consumer must not use this port as evidence that CG2 or provider traffic is ready
 * S2 (#362 §4/§8): a Touch from an explicit response is a separate operation on
 * `ContactTouchCorrelationPort.recordCorrelatedTouch`; settle never creates a Touch from acceptance
 */
export interface ContactGovernancePort extends ContactAuthorizationPort {
  authorizeAndReserve(
    tenantId: TenantId,
    input: AuthorizeAndReserveInput & { correlationId: string },
  ): Promise<AuthorizationOutcome>;
  claimReservationForDelivery(
    input: ClaimReservationForDeliveryInput,
  ): Promise<ReservationSettlementView>;
  renewReservationLease(input: RenewReservationLeaseInput): Promise<ReservationSettlementView>;
  beginProviderSubmission(input: BeginProviderSubmissionInput): Promise<ReservationSettlementView>;
  confirmProviderAcceptance(
    input: ConfirmProviderAcceptanceInput,
  ): Promise<ReservationSettlementView>;
  releaseBeforeSubmit(input: ReleaseBeforeSubmitInput): Promise<ReservationSettlementView>;
  settleDelivery(input: SettleDeliveryInput): Promise<ReservationSettlementView>;
}
