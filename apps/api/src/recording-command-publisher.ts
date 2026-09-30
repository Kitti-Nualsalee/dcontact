import { randomUUID } from 'node:crypto';
import { createProducer, type DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCommand } from '@d-contact/shared';
import type { TelephonyCommandPublisher } from './recording-api.js';

function orderingKeyFor(command: TelephonyCommand): string {
  if ('callUuid' in command && typeof command.callUuid === 'string') return command.callUuid;
  if (command.type === 'sip.registration.flush') return command.workSessionLeaseId;
  if (command.type === 'call.originate') return command.deliveryId;
  throw new Error(`telephony command ${command.type} has no ordering key`);
}

/** ส่งคำสั่ง recording หลัง transaction commit โดยใช้ contract เดียวกับ Router */
export class KafkaTelephonyCommandPublisher implements TelephonyCommandPublisher {
  private producer?: Promise<DcProducer>;

  async publish(input: Parameters<TelephonyCommandPublisher['publish']>[0]): Promise<void> {
    this.producer ??= createProducer('dcontact-api-recording-control-v1');
    const producer = await this.producer;
    const orderingKey = orderingKeyFor(input.command);
    await producer.send(KAFKA_TOPICS.TELEPHONY_COMMANDS, {
      eventId: randomUUID(),
      type: input.command.type,
      tenantId: input.tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: orderingKey,
      orderingKey,
      payload: input.command,
    });
  }

  async disconnect(): Promise<void> {
    await this.producer?.then((producer) => producer.disconnect());
  }
}
