import { randomUUID } from 'node:crypto';
import { createProducer, type DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { QmJobPublisher } from './qm-api.js';

export class KafkaQmJobPublisher implements QmJobPublisher {
  private producer?: Promise<DcProducer>;

  async publish(input: Parameters<QmJobPublisher['publish']>[0]): Promise<void> {
    this.producer ??= createProducer('dcontact-api-qm-jobs-v1');
    const producer = await this.producer;
    await producer.send(KAFKA_TOPICS.QM_JOBS, {
      eventId: randomUUID(),
      type: 'qm.transcription.requested',
      tenantId: input.tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: input.job.interactionId,
      orderingKey: input.job.jobId,
      payload: input.job,
    });
  }

  async disconnect(): Promise<void> {
    await this.producer?.then((producer) => producer.disconnect());
  }
}
