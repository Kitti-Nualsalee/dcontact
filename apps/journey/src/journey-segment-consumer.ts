/**
 * J3.6 (#217) — Kafka V2 consumer of `dc.customer.events`
 *
 * Accepts only `customer.segment.changed` that passes `assertSegmentMembershipChangeEnvelope`, which already
 * enforces contractVersion, ordering key, aggregate binding and the whole payload shape
 * — this consumer therefore does not recheck it, because two rule sets that must be kept in sync are the origin of loopholes
 *
 * Ingest is deliberately separated from trigger matching as J2.7 did: it does not resolve identity/scope here
 * and does not create an enrollment — it only persists the receipt durably/idempotently and lets a separately
 * polling processor continue. Combining the two in one place would make the Kafka offset the authority
 * of work ordering, which the stop condition of #217 forbids
 */
import type { PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import {
  J3_EVENT_TYPES,
  assertSegmentMembershipChangeEnvelope,
  canonicalSegmentMembershipHash,
  tenantId as contractTenantId,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';

/**
 * No separate inbox table is needed because `JourneySegmentReceiptRepository.ingest()` is already its own durable
 * dedup boundary through unique (tenantId, source, eventId), so calling it again is always safe
 * no matter how the wrapper reports processed/duplicate
 */
export function createDurableJourneySegmentIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateJourneySegmentConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  /** transport source persisted in the receipt to avoid colliding with another receipt source */
  source?: string;
}

export function createJourneySegmentConsumer(
  options: CreateJourneySegmentConsumerOptions,
): Promise<DcConsumer> {
  const receipts = new JourneySegmentReceiptRepository(options.database);
  const source = options.source ?? 'CUSTOMER_360';
  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CUSTOMER_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneySegmentIdempotencyStore(),
    handler: async ({ event }) => {
      // an event of another type on the same topic is skipped silently, not an error — Customer 360 owns the topic
      // and has the right to announce other events Journey does not care about
      if (event.type !== J3_EVENT_TYPES.CUSTOMER_SEGMENT_CHANGED) return;
      const envelope = assertSegmentMembershipChangeEnvelope(event);
      const payload = envelope.payload;
      /**
       * `supersedesRevision` exists only for some changeKinds per the discriminated union of the contract
       * (ENTERED has none) — read through `in` instead of a cast so the contract still does the enforcing —
       * if the union changes one day, this still compiles and yields undefined, not a wrong value
       */
      const supersedesRevision =
        'supersedesRevision' in payload ? payload.supersedesRevision : undefined;
      await receipts.ingest({
        tenantId: envelope.tenantId,
        source,
        eventId: envelope.eventId,
        contactId: payload.contactId,
        segmentId: payload.segmentId,
        membershipRevision: payload.membershipRevision,
        changeKind: payload.changeKind,
        segmentDefinitionVersion: payload.segmentDefinitionVersion,
        payloadHash: canonicalSegmentMembershipHash(contractTenantId(envelope.tenantId), payload),
        correlationId: envelope.correlationId,
        ...(payload.entryId ? { entryId: payload.entryId } : {}),
        ...(supersedesRevision !== undefined ? { supersedesRevision } : {}),
        ...(payload.evidenceRef ? { evidenceRef: payload.evidenceRef } : {}),
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      });
    },
  };
  return createConsumer(consumerOptions);
}
