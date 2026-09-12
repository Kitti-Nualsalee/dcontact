/** Owner: Channels/Dialer — สัญญาข้าม domain; ไม่มี database, provider SDK หรือ transport dependency */
import type {
  ActionKey,
  ContactId,
  DeliveryId,
  IdentityId,
  ProviderRequestKey,
  ReservationId,
  TenantId,
} from './identifiers.js';
import type { ContactChannel, ReservationBindingErrorCode } from './contact-governance.js';

/**
 * Fields this port must forward to `ContactGovernancePort.claimReservationForDelivery`
 * as part of `DeliveryBinding`/`ClaimReservationForDeliveryInput`; not part of the
 * Channels/Dialer domain model, but required to drive the already-frozen Governance
 * contract without duplicating its vocabulary.
 */
export interface DeliveryReservationBinding {
  purpose: string;
  senderIdentityId: string;
  /** Worker lease before provider I/O; forwarded verbatim to the claim call. */
  leaseExpiresAt: string;
}

export interface EnqueueDeliveryCommand extends DeliveryReservationBinding {
  tenantId: TenantId;
  source: string;
  actionKey: ActionKey;
  reservationId: ReservationId;
  channel: ContactChannel;
  contactId: ContactId;
  identityId?: IdentityId;
  /** Content the channel owner resolves; this port never inlines a message body. */
  contentRef: string;
  correlationId: string;
  causationId?: string;
}

export interface DeliveryQueued {
  status: 'QUEUED';
  deliveryId: DeliveryId;
  providerRequestKey: ProviderRequestKey;
}

/** Only the subset of ReservationBindingErrorCode a bare claim call can produce; renew/begin-only codes are excluded. */
export type DeliveryEnqueueErrorCode = Exclude<
  ReservationBindingErrorCode,
  'STALE_RESERVATION_LEASE' | 'DELIVERY_RECONCILIATION_REQUIRED' | 'INVALID_RESERVATION_TRANSITION'
>;

export interface DeliveryEnqueueFailure {
  status: 'ERROR';
  code: DeliveryEnqueueErrorCode;
}

export type EnqueueDeliveryResult = DeliveryQueued | DeliveryEnqueueFailure;

/**
 * Owner: Channels/Dialer; full port ของ E0 ยังไม่มี production implementation.
 * `enqueue` เป็น operation เดียวที่ port นี้เปิด — cancellation และ outcome
 * settlement ยังอยู่บน ContactGovernancePort เพื่อให้ Governance เป็น single
 * writer ของ reservation/Attempt/Touch ตัว adapter จริงต้อง persist outbox
 * row ก่อนตอบ QUEUED เสมอ และห้ามออก providerRequestKey ใหม่จาก retry ของ
 * actionKey เดิม
 */
export interface DeliveryPort {
  enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult>;
}

/**
 * Delivery รายงาน lifecycle ที่ durable เข้า Journey owner-local inbox. นี่เป็น
 * immutable binding notification ไม่ใช่สิทธิ์ให้ Delivery เขียน Journey table โดยตรง
 * และ `eventId` ต้องคงที่เมื่อ retry transition เดิม
 */
export interface JourneyActionLifecycleRecord {
  tenantId: TenantId;
  actionKey: ActionKey;
  reservationId: ReservationId;
  deliveryId: DeliveryId;
  providerRequestKey: ProviderRequestKey;
  state: 'PRE_BARRIER' | 'POST_BARRIER' | 'ACCEPTED';
  eventId: string;
  occurredAt: string;
  correlationId: string;
}

export interface JourneyActionLifecyclePort {
  record(input: JourneyActionLifecycleRecord): Promise<void>;
}

/**
 * คำสั่งจาก Journey ไปยัง Delivery owner หลังข้าม submission barrier แล้วเท่านั้น.
 * Journey ไม่ settle reservation หรือสื่อสารกับ provider แทน Delivery.
 */
export interface ReconcileJourneyDeliveryCommand {
  tenantId: TenantId;
  actionKey: ActionKey;
  reservationId: ReservationId;
  deliveryId: DeliveryId;
  providerRequestKey: ProviderRequestKey;
  correlationId: string;
}

export interface JourneyDeliveryReconcilePort {
  requestReconcile(input: ReconcileJourneyDeliveryCommand): Promise<void>;
}
