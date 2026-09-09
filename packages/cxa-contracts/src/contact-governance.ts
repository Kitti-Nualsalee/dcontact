/** Owner: Contact Governance — สัญญาข้าม domain; ไม่มี database หรือ transport dependency */
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

export type ContactChannel = 'VOICE' | 'WEBCHAT' | 'LINE' | 'FACEBOOK' | 'WHATSAPP' | 'EMAIL';

export type ContactDecision = 'ALLOW' | 'BLOCK' | 'DEFER' | 'REVIEW';

export interface ContactPolicyTraceEntry {
  gate: 'IDENTITY' | 'HARD_RESTRICTION' | 'CONSENT';
  outcome: 'PASS' | 'ALLOW' | 'BLOCK' | 'REVIEW';
  reasonCode?: string;
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
      `ไม่รองรับ reservation transition: ${state} -> ${typeof command === 'string' ? command : command.type}`,
    );
    this.name = 'InvalidReservationTransitionError';
  }
}

export class RefundNotAllowedError extends Error {
  readonly code = 'REFUND_NOT_ALLOWED';

  constructor(readonly outcome: RefundReservationCommand['outcome']) {
    super(`ไม่อนุญาตให้ refund reservation สำหรับ outcome ${outcome}`);
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
        identityResolution: 'AMBIGUOUS' | 'NOT_FOUND';
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
    super(`actionKey ถูกใช้กับ canonical input อื่นแล้ว: ${actionKey}`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ReservationNotFoundError extends Error {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(readonly reservationId: string) {
    super(`ไม่พบ reservation ใน active tenant: ${reservationId}`);
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
    super(`ไม่สามารถใช้ reservation สำหรับ delivery: ${code}`);
    this.name = 'ReservationNotUsableError';
  }
}

/** Port แคบสำหรับ Foundation; คง signature เดิมเพื่อ expand โดยไม่เปลี่ยน behavior */
export interface ContactAuthorizationPort {
  authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
  ): Promise<AuthorizationOutcome>;
}

/** UNKNOWN_RECONCILING เป็น delivery settlement status ไม่ใช่ reservation state ในฐานข้อมูล */
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
  /** Lease ของ worker ก่อน provider I/O; ต้องไม่เกิน reservation expiry */
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
  /** ก่อน claim ไม่มี deliveryId; เมื่อ claim แล้วต้องระบุ binding เดิม */
  deliveryId?: DeliveryId;
  reason: 'CANCELLED_BEFORE_SUBMIT' | 'LEASE_EXPIRED';
}

/** Adapter ส่ง fact; countsAsAttempt/countsAsTouch และ refund เป็น authority ของ Governance */
export type NormalizedDeliveryOutcome =
  'UNKNOWN_RECONCILING' | 'PROVIDER_REJECTED' | 'DELIVERED' | 'DELIVERY_FAILED';

export interface SettleDeliveryInput extends BoundDeliveryCommand {
  providerRequestKey: ProviderRequestKey;
  outcomeRef: OutcomeRef;
  outcome: NormalizedDeliveryOutcome;
  occurredAt: string;
}

export interface ReservationSettlementView {
  reservationId: ReservationId;
  actionKey: ActionKey;
  deliveryId?: DeliveryId;
  state: ReservationState;
  status: DeliverySettlementStatus;
  /** Snapshot ของ command; duplicate เก่าไม่ใช่ lease authority สำหรับส่งซ้ำ */
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
  | 'IDEMPOTENCY_CONFLICT';

export class ReservationBindingError extends Error {
  constructor(readonly code: ReservationBindingErrorCode) {
    super(`ไม่สามารถเปลี่ยน delivery binding: ${code}`);
    this.name = 'ReservationBindingError';
  }
}

/**
 * Owner: Contact Governance; full port ของ E0 ยังไม่มี production implementation
 * ทุก operation ต้อง atomic ภายใน tenant และ fail closed เมื่อ binding ไม่ตรง
 * Duplicate canonical input คืนผลเดิม; correlationId เป็น trace ไม่ใช่ idempotency identity
 * Claim เริ่ม leaseVersion=1; renewal ใช้ CAS version และต่อได้ก่อน lease หมด/ก่อน submission เท่านั้น
 * beginProviderSubmission ต้อง persist barrier ก่อน provider I/O; หลัง barrier ถือว่าอาจส่งแล้ว
 * Barrier ใช้ UNKNOWN_RECONCILING โดยยังไม่ CONFIRMED; lease/TTL ห้ามปล่อยสิทธิ์หลัง barrier
 * Confirm/settle รับผลได้เฉพาะ binding/request key ที่ begin แล้ว แม้ lease หมดระหว่างรอผล
 * Duplicate response เป็น snapshot ของ command เดิม ไม่อนุญาต provider I/O ซ้ำ
 * Adapter ต้องถือ durable outbox ownership และใช้ provider-specific idempotency/reconcile gate
 * หลัง barrier ห้าม release/refund/blind retry จาก timeout; terminal refund ยังเป็น Governance policy
 * Terminal outcome แรกชนะ; late outcome ไม่ย้อน state และไม่สร้าง Attempt/Touch ซ้ำ
 * Consumer ห้ามใช้ port นี้เป็นหลักฐานว่า CG2 หรือ provider traffic พร้อมแล้ว
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
