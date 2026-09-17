/**
 * J2.8 (#136) — ขารับ `ENSURE_CASE` ของ Cases จาก `dc.case.commands` แล้ว publish ผลกลับ
 * `dc.case.events`
 *
 * ขั้นตอนต่อ message อยู่ที่ `processOwnerCommandEvent` ของ contract (ใช้ร่วมกับ Dialer): receipt
 * `cs_command_inbox` ถูกเขียนใน transaction เดียวกับ Case mutation และเป็น result outbox โดยตรง
 * offset commit หลัง publish สำเร็จเท่านั้น — redelivery จึง publish ผลเดิมซ้ำแต่ไม่สร้าง Case ซ้ำ
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

/** receipt ของ owner คือ durable dedup boundary — ไม่ต้องมี consumer inbox ซ้อนอีกชั้น */
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
