/** E0 test double เท่านั้น: ไม่มี persistence จริง, provider I/O หรือ credential */
import type {
  ClaimReservationForDeliveryInput,
  ContactGovernancePort,
} from '../contact-governance.js';
import { ReservationBindingError } from '../contact-governance.js';
import type {
  DeliveryEnqueueErrorCode,
  DeliveryPort,
  EnqueueDeliveryCommand,
  EnqueueDeliveryResult,
} from '../delivery.js';
import { deliveryId, providerRequestKey } from '../identifiers.js';

function canonical(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([key, v]) => key !== 'correlationId' && key !== 'causationId' && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

interface OutboxRecord {
  canonicalInput: string;
  result: DeliveryEnqueueResultQueued;
}

type DeliveryEnqueueResultQueued = Extract<EnqueueDeliveryResult, { status: 'QUEUED' }>;

/**
 * Owner: Channels/Dialer test double. Mints `deliveryId`/`providerRequestKey`
 * itself (per identifiers.ts ownership) and only persists a simulated outbox
 * row once `ContactGovernancePort.claimReservationForDelivery` accepts the
 * binding — a failed claim never leaves a row behind. Reservation validity,
 * expiry, and binding checks are never re-implemented here; they are the
 * injected Governance port's authority.
 *
 * Idempotency is keyed on `(tenantId, actionKey)` and cached only after a
 * successful claim: a duplicate call with identical canonical input replays
 * the same delivery, a duplicate with different input is a conflict, and a
 * prior *failed* attempt never locks the actionKey — a corrected retry after
 * a real failure is allowed, matching how the underlying fake's own
 * `once()` only caches after its `apply` succeeds.
 */
export class DeliveryTestAdapter implements DeliveryPort {
  private readonly outbox = new Map<string, OutboxRecord>();
  private sequence = 0;

  constructor(private readonly governance: ContactGovernancePort) {}

  async enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    const key = JSON.stringify([command.tenantId, command.actionKey]);
    const hash = canonical(command);
    const existing = this.outbox.get(key);
    if (existing) {
      return existing.canonicalInput === hash
        ? existing.result
        : { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }

    this.sequence += 1;
    const minted = {
      deliveryId: deliveryId(`delivery-${this.sequence}`),
      providerRequestKey: providerRequestKey(`provider-${this.sequence}`),
    };
    const claimInput: ClaimReservationForDeliveryInput = {
      tenantId: command.tenantId,
      correlationId: command.correlationId,
      reservationId: command.reservationId,
      actionKey: command.actionKey,
      deliveryId: minted.deliveryId,
      contactId: command.contactId,
      identityId: command.identityId,
      channel: command.channel,
      purpose: command.purpose,
      senderIdentityId: command.senderIdentityId,
      leaseExpiresAt: command.leaseExpiresAt,
    };

    try {
      await this.governance.claimReservationForDelivery(claimInput);
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      return { status: 'ERROR', code: error.code as DeliveryEnqueueErrorCode };
    }

    const result: DeliveryEnqueueResultQueued = { status: 'QUEUED', ...minted };
    this.outbox.set(key, { canonicalInput: hash, result });
    return result;
  }
}
