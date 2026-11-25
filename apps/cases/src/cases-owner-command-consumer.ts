/**
 * J2.8 (#136) — the Cases receive path for `ENSURE_CASE` from `dc.case.commands`, publishing the result back
 * `dc.case.events`
 *
 * The per-message steps live in the contract `processOwnerCommandEvent` (shared with Dialer): the receipt
 * `cs_command_inbox` is written in the same transaction as the Case mutation and is itself the result outbox.
 * The offset is committed only after a successful publish — so redelivery republishes the earlier result but does not create a duplicate Case.
 */
import { processOwnerCommandEvent, type J2CaseOwnerPort } from '@d-contact/cxa-contracts';
import {
  createConsumer,
  quarantineConsumedEvent,
  type DcConsumer,
  type DcProducer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

/** The owner receipt is the durable dedup boundary — no extra consumer inbox layer is needed */
function ownerReceiptIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateCasesOwnerCommandConsumerOptions {
  owner: J2CaseOwnerPort;
  producer: DcProducer;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  now?: () => Date;
}

export function createCasesOwnerCommandConsumer(
  options: CreateCasesOwnerCommandConsumerOptions,
): Promise<DcConsumer> {
  const now = options.now ?? (() => new Date());
  return createConsumer({
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CASE_COMMANDS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: ownerReceiptIdempotencyStore(),
    handler: async (consumed) => {
      const processed = await processOwnerCommandEvent(consumed.event, {
        owner: options.owner,
        now,
        publish: (envelope) =>
          options.producer.send(
            KAFKA_TOPICS.CASE_EVENTS,
            envelope as unknown as Parameters<DcProducer['send']>[1],
          ),
      });
      if (processed.outcome === 'QUARANTINED') {
        await quarantineConsumedEvent(options.dlq, consumed, processed.code);
      }
    },
  });
}
