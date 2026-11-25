/**
 * Owner: Channels/Dialer — PII boundary of the delivery outbox
 *
 * C1 forbids a contact reference, phone number, email, LINE id or CRM id from appearing in any key, header,
 * log or evidence of delivery. This file is the only place that decides which field
 * may be released outside — every log/evidence must pass through `deliveryEvidence`; never serialize
 * an outbox row directly because the row holds contentRef and bindings that must not leave
 */
import { createHash } from 'node:crypto';
import type { DlDeliveryState, DlOutboxEntry } from '@d-contact/db';

/** Fields that may be released to log/evidence: opaque ids, enums and timestamps only */
export const DELIVERY_EVIDENCE_FIELDS = [
  'tenantId',
  'deliveryId',
  'providerRequestKey',
  'reservationId',
  'actionKey',
  'adapter',
  'channel',
  'state',
  'outcome',
  'outcomeRef',
  'submittedAt',
  'settledAt',
  'correlationId',
] as const;

export type DeliveryEvidenceField = (typeof DELIVERY_EVIDENCE_FIELDS)[number];

export type DeliveryEvidence = Record<DeliveryEvidenceField, string | null> & {
  state: DlDeliveryState;
};

/**
 * contentRef is resolved into content only by the channel owner at real send time, so the adapter
 * accepts only a short reference with no whitespace and no `@` — enough to reject the case where a
 * caller mistakenly passes a message body or a customer email as the contentRef
 */
const CONTENT_REFERENCE_PATTERN = /^[A-Za-z0-9._:\-/]{1,200}$/;

export class InlineContentRejectedError extends Error {
  readonly code = 'INLINE_CONTENT_REJECTED';

  constructor() {
    super('contentRef must be an opaque reference, not content or a contact identifier');
    this.name = 'InlineContentRejectedError';
  }
}

export function assertOpaqueContentRef(value: string): void {
  if (!CONTENT_REFERENCE_PATTERN.test(value)) throw new InlineContentRejectedError();
}

export function deliveryEvidence(entry: DlOutboxEntry): DeliveryEvidence {
  return {
    tenantId: entry.tenantId,
    deliveryId: entry.deliveryId,
    providerRequestKey: entry.providerRequestKey,
    reservationId: entry.reservationId,
    actionKey: entry.actionKey,
    adapter: entry.adapter,
    channel: entry.channel,
    state: entry.state,
    outcome: entry.outcome,
    outcomeRef: entry.outcomeRef,
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    settledAt: entry.settledAt?.toISOString() ?? null,
    correlationId: entry.correlationId,
  };
}

/**
 * deliveryId and providerRequestKey are derived from (tenantId, actionKey, inputHash) deterministically:
 * a retry after a crash therefore mints the same values and gets the same claim/begin back as a
 * replay instead of opening a new delivery. The values are digests, so they carry no PII out with the key
 */
export function mintOpaqueKey(
  kind: 'delivery' | 'provider-request',
  tenantId: string,
  actionKey: string,
  inputHash: string,
): string {
  const digest = createHash('sha256')
    .update([kind, tenantId, actionKey, inputHash].join('|'))
    .digest('hex');
  return `${kind === 'delivery' ? 'dlv' : 'prq'}_${digest.slice(0, 32)}`;
}

export function canonicalInputHash(input: Record<string, unknown>): string {
  const canonical = Object.entries(input)
    .filter(
      ([key, value]) => key !== 'correlationId' && key !== 'causationId' && value !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
