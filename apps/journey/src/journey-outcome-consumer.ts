/**
 * J2.7 — Kafka V2 consumer of `dc.interaction.events`; ingests only the
 * `interaction.outcome_recorded` allowlist (#120) into a durable receipt (J2.3)
 *
 * Ingest is deliberately separated from trigger matching (`journey-outcome-trigger-processor.ts`)
 * as J2.3 originally designed: this consumer does not resolve identity/scope or create any
 * enrollment — it only persists the receipt durably/idempotently and lets a separately
 * polling processor continue the work
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
  J2_EVENT_TYPES,
  assertInteractionOutcomeEnvelope,
  canonicalInteractionOutcomeHash,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneyOutcomeReceiptRepository } from './journey-outcome-receipt-repository.js';

/**
 * No separate inbox table is needed like the governance consumer because
 * `JourneyOutcomeReceiptRepository.ingest()` is already its own durable dedup boundary
 * through unique (tenantId, source, eventId) — calling it again is always safe no matter how the wrapper
 * reports processed/duplicate
 */
export function createDurableJourneyOutcomeIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateJourneyOutcomeConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  /** transport source persisted in the receipt to avoid colliding with another receipt source */
  source?: string;
}

/** Accepts only canonical interaction outcome facts; other event types on the same topic are skipped silently */
export function createJourneyOutcomeConsumer(
  options: CreateJourneyOutcomeConsumerOptions,
): Promise<DcConsumer> {
  const receipts = new JourneyOutcomeReceiptRepository(options.database);
  const source = options.source ?? 'INTERACTION';
  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.INTERACTION_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneyOutcomeIdempotencyStore(),
    handler: async ({ event }) => {
      if (event.type !== J2_EVENT_TYPES.INTERACTION_OUTCOME_RECORDED) return;
      const envelope = assertInteractionOutcomeEnvelope(event);
      await receipts.ingest({
        tenantId: envelope.tenantId,
        source,
        eventId: envelope.eventId,
        outcomeType: envelope.payload.outcomeType,
        outcomeId: envelope.payload.outcomeId,
        outcomeVersion: envelope.payload.outcomeVersion,
        payloadHash: canonicalInteractionOutcomeHash(envelope.payload),
        payload: envelope.payload,
        correlationId: envelope.correlationId,
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      });
    },
  };
  return createConsumer(consumerOptions);
}
