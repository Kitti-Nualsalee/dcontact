/**
 * J2.8 (#136) — Kafka transport ของ owner command
 *
 * `JourneyOwnerCommandRelay` รับ `J2OwnerPort` เข้ามาตรง ๆ จึงเปลี่ยน transport ได้โดย
 * ไม่แตะ relay เลย ก่อนหน้านี้มีแต่ port ที่เรียก Cases/Dialer แบบ in-process (J2.4–J2.6)
 * ทำให้ #136 ข้อแรก "relay `dc.case.commands`/`dc.dialer.commands` แบบ at-least-once และ
 * mark dispatch หลัง broker ack" ยังไม่เคยมีของจริง
 *
 * สองครึ่งของ port แยกหน้าที่กันชัดเจน:
 *
 *   persistCommand — publish ลง topic แล้วรอ broker ack ก่อนคืน `PERSISTED`
 *     ตรงตามสัญญาที่ `J2OwnerCommandPersistedV1` เขียนไว้เองว่า "Dispatch success confirms
 *     durable command/outbox persistence, not the business effect" — broker ack คือ durable
 *     persistence จริง ส่วน effect ฝั่ง owner เป็นคนละเรื่องที่ตามมาทีหลัง relay จึง mark
 *     SENT ได้อย่างซื่อสัตย์โดยไม่ได้อ้างว่า owner ทำงานเสร็จแล้ว
 *
 *   queryAction — publish owner action query แล้วคืน undefined ผลจริงกลับมาทาง result consumer
 *
 * ordering key ใช้ actionKey (ตาม envelope contract ของ J2.1) เพื่อให้ command ของ action เดียวกันไปอยู่ partition เดียวกัน
 * เสมอ — owner จึงเห็นลำดับ CANCEL/SUPERSEDE หลัง command ต้นเรื่องแน่นอน
 */
import { randomUUID } from 'node:crypto';
import type { DcProducer } from '@d-contact/kafka';
import type { KafkaTopic } from '@d-contact/shared';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  assertOwnerCommandEnvelope,
  createOwnerActionQueryEnvelope,
  assertOwnerRequestHash,
  J2_COMMAND_EVENT_TYPE,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPayloadV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerPort,
  type J2OwnerResultPayloadV1,
  type TenantId,
} from '@d-contact/cxa-contracts';

export interface KafkaOwnerCommandPortOptions {
  topic: KafkaTopic;
  producer: DcProducer;
  now?: () => Date;
}

export function createKafkaOwnerCommandPort<TCommand extends J2OwnerCommandPayloadV1>(
  options: KafkaOwnerCommandPortOptions,
): J2OwnerPort<TCommand> {
  const now = options.now ?? (() => new Date());

  return {
    async persistCommand(tenant: TenantId, command: TCommand): Promise<J2OwnerCommandPersistedV1> {
      // validate ก่อน publish เสมอ — payload/envelope ที่ผิด contract ต้องไม่หลุดลง topic
      // owner ตรวจด้วย assertOwnerCommandEnvelope ตัวเดียวกัน (J2.1): eventId = commandId เพื่อให้
      // retry ของ command เดิมเป็น event เดิม, orderingKey = actionKey เพื่อให้ CANCEL/SUPERSEDE
      // ซึ่งใช้ actionKey เดิมตาม contract ตกอยู่ partition เดียวกับ command ต้นเรื่องเสมอ
      const validated = assertOwnerRequestHash(tenant, command);
      const envelope = assertOwnerCommandEnvelope({
        schemaVersion: 2,
        eventKind: 'COMMAND',
        eventId: validated.commandId,
        type: J2_COMMAND_EVENT_TYPE[validated.commandType],
        tenantId: tenant,
        occurredAt: now().toISOString(),
        correlationId: validated.commandId,
        orderingKey: validated.actionKey,
        aggregateType: 'journey_action',
        aggregateId: validated.actionKey,
        aggregateVersion: 0,
        payload: validated as unknown as Record<string, unknown>,
      });

      await options.producer.send(
        options.topic,
        envelope as unknown as Parameters<DcProducer['send']>[1],
      );

      return {
        status: 'PERSISTED',
        commandId: toCommandId(validated.commandId),
        actionKey: toActionKey(validated.actionKey),
        requestHash: validated.requestHash,
      };
    },

    /**
     * ถาม owner แบบ async: publish `journey.owner_action_query_requested` ไปยัง topic ของ owner แล้ว
     * คืน `undefined` ทันที ("ยังไม่มีผลในมือ") — owner ตอบจาก receipt ที่มีอยู่ด้วย result event เดิม
     * ซึ่งไหลกลับมาทาง result consumer และ apply แบบ idempotent เหมือนผลปกติ
     *
     * ไม่ synthesize ผลจาก `jr_owner_result_inbox` ในบ้าน และไม่ retry command เดิมแทนการถาม: owner
     * ที่ไม่เคยได้รับ command จะไม่ตอบอะไร ปล่อยให้ bounded escalation ส่งต่อให้คนตัดสินผ่าน replay
     * ที่ audit ไว้ (#123)
     */
    async queryAction(
      tenant: TenantId,
      query: J2OwnerActionQueryV1,
    ): Promise<J2OwnerResultPayloadV1 | undefined> {
      const envelope = createOwnerActionQueryEnvelope(tenant, query, {
        eventId: `query:${randomUUID()}`,
        correlationId: query.actionKey,
        occurredAt: now().toISOString(),
      });
      await options.producer.send(
        options.topic,
        envelope as unknown as Parameters<DcProducer['send']>[1],
      );
      return undefined;
    },
  };
}
