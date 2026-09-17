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
 *   queryAction — ยังคืน undefined เสมอ จนกว่าจะมี result consumer (ข้อสองของ #136)
 *     เหตุผลเต็มอยู่ที่ตัว method — สรุปคือยอมบอกว่า "ยังไม่มีผล" ดีกว่าแต่งฟิลด์ที่
 *     ตาราง projection ไม่ได้เก็บไว้ขึ้นมาเองให้ reconciler ใช้ตัดสิน state
 *
 * ordering key ใช้ actionKey (ตาม envelope contract ของ J2.1) เพื่อให้ command ของ action เดียวกันไปอยู่ partition เดียวกัน
 * เสมอ — owner จึงเห็นลำดับ CANCEL/SUPERSEDE หลัง command ต้นเรื่องแน่นอน
 */
import type { DcProducer } from '@d-contact/kafka';
import type { KafkaTopic } from '@d-contact/shared';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  assertOwnerCommandEnvelope,
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
     * ยังคืน `undefined` เสมอ — และนั่นคือคำตอบที่ซื่อสัตย์ที่สุดตอนนี้
     *
     * ผลจาก owner ฝั่ง Kafka ต้องเดินทางกลับมาเป็น `J2OwnerResultPayloadV1` เต็มใบผ่าน
     * result consumer (ข้อสองของ #136 ที่ยังไม่ได้ทำ) ตาราง `jr_owner_result_inbox` เก็บ
     * แค่ projection ย่อสำหรับ idempotency ไม่มี `commandType`, `code`, `category`,
     * `failureClass` หรือ `retryDisposition` ให้ประกอบกลับ
     *
     * ถ้าจะ synthesize ฟิลด์ที่หายไปเองก็เท่ากับป้อนค่าที่แต่งขึ้นให้ reconciler ใช้ตัดสิน
     * state ของ action ซึ่งอันตรายกว่าการบอกว่า "ยังไม่มีผล" มาก — reconciler ตีความ
     * undefined เป็น "ยังรออยู่" (ACK_UNKNOWN) ซึ่งเป็น fail-safe และตรงกับความจริงว่า
     * ยังไม่มีใครส่งผลกลับมา
     */
    async queryAction(
      _tenant: TenantId,
      _query: J2OwnerActionQueryV1,
    ): Promise<J2OwnerResultPayloadV1 | undefined> {
      return undefined;
    },
  };
}
