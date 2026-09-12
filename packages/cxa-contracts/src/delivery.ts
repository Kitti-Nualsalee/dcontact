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
 * Delivery reports its durable lifecycle into Journey's owner-local inbox. This
 * is an immutable binding notification, not permission for Delivery to write a
 * Journey table directly. `eventId` is stable for retry of the same transition.
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
