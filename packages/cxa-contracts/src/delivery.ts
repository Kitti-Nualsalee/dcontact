/** Owner: Channels/Dialer: a cross-domain contract; no database, provider SDK or transport dependency */
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
 * Owner: Channels/Dialer; the full E0 port has no production implementation yet.
 * `enqueue` is the only operation this port opens: cancellation and outcome
 * settlement stay on ContactGovernancePort so that Governance is the single
 * writer of reservation/Attempt/Touch. A real adapter must persist the outbox
 * row before answering QUEUED, and must not issue a new providerRequestKey from a retry of
 * the same actionKey
 */
export interface DeliveryPort {
  enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult>;
}

/**
 * Delivery reports durable lifecycle to the Journey owner-local inbox. This is an
 * immutable binding notification, not permission for Delivery to write Journey tables directly,
 * and `eventId` must stay the same when the same transition is retried
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
 * A command from Journey to the Delivery owner, only after crossing the submission barrier.
 * Journey does not settle a reservation or talk to the provider in Delivery's place.
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
