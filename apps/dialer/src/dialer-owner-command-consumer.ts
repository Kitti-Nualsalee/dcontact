/**
 * J2.8 (#136) — the Dialer owner command receive path from `dc.dialer.commands`, publishing the result back
 * `dc.dialer.events`
 *
 * The counterpart of the Journey-side relay: a command the relay marks SENT after the broker ack must really be received
 * otherwise actions stay DISPATCHED until every one escalates to ACK_UNKNOWN.
 *
 * The per-message steps live in the contract `processOwnerCommandEvent` (shared with Cases) — the offset
 * is committed only after the handler succeeds, so a result can be republished but not decided twice; a command violating the contract
 * or hitting IDEMPOTENCY_CONFLICT goes to the DLQ, while an event of another kind on the same topic (e.g.
 * `dialer.reconcile_requested`) is skipped silently
 */
import { processOwnerCommandEvent, type J2DialerOwnerPort } from '@d-contact/cxa-contracts';
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
export function createOwnerReceiptIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateDialerOwnerCommandConsumerOptions {
  owner: J2DialerOwnerPort;
  producer: DcProducer;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  now?: () => Date;
}

export function createDialerOwnerCommandConsumer(
  options: CreateDialerOwnerCommandConsumerOptions,
): Promise<DcConsumer> {
  const now = options.now ?? (() => new Date());
  return createConsumer({
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.DIALER_COMMANDS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createOwnerReceiptIdempotencyStore(),
    handler: async (consumed) => {
      const processed = await processOwnerCommandEvent(consumed.event, {
        owner: options.owner,
        now,
        publish: (envelope) =>
          options.producer.send(
            KAFKA_TOPICS.DIALER_EVENTS,
            envelope as unknown as Parameters<DcProducer['send']>[1],
          ),
      });
      if (processed.outcome === 'QUARANTINED') {
        await quarantineConsumedEvent(options.dlq, consumed, processed.code);
      }
    },
  });
}
