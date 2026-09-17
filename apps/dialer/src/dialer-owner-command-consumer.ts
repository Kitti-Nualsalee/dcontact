/**
 * J2.8 (#136) — ขารับ owner command ของ Dialer จาก `dc.dialer.commands` แล้ว publish ผลกลับ
 * `dc.dialer.events`
 *
 * คู่ตรงข้ามของ relay ฝั่ง Journey: command ที่ relay mark SENT หลัง broker ack ต้องมีคนรับจริง
 * ไม่งั้น action ค้าง DISPATCHED จน ACK_UNKNOWN escalate ทุกใบ
 *
 * ขั้นตอนต่อ message อยู่ที่ `processOwnerCommandEvent` ของ contract (ใช้ร่วมกับ Cases) — offset
 * commit หลัง handler สำเร็จเท่านั้น จึง publish ผลซ้ำได้แต่ไม่ตัดสินซ้ำ; command ที่ผิด contract
 * หรือชน IDEMPOTENCY_CONFLICT เข้า DLQ ส่วน event ชนิดอื่นบน topic เดียวกัน (เช่น
 * `dialer.reconcile_requested`) ข้ามเงียบ
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

/** receipt ของ owner คือ durable dedup boundary — ไม่ต้องมี consumer inbox ซ้อนอีกชั้น */
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
