import { randomUUID } from 'node:crypto';
import { createProducer, type DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { QmJobPublisher } from './qm-transcription-workflow.js';
import type { QmRetryPublisher } from './qm-retry-dispatcher.js';

export class KafkaQmJobPublisher implements QmJobPublisher, QmRetryPublisher {
  constructor(private readonly producer: DcProducer) {}

  async publish(
    input: Parameters<QmJobPublisher['publish']>[0] | Parameters<QmRetryPublisher['publish']>[0],
  ): Promise<void> {
    const tenantId = input.tenantId;
    const job = input.job;
    await this.producer.send(KAFKA_TOPICS.QM_JOBS, {
      eventId: randomUUID(),
      type: 'qm.transcription.requested',
      tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: job.interactionId,
      orderingKey: job.jobId,
      payload: job,
    });
  }
}

export async function createQmJobPublisher(): Promise<{
  publisher: KafkaQmJobPublisher;
  producer: DcProducer;
}> {
  const producer = await createProducer('dcontact-qm-jobs-v1');
  return { publisher: new KafkaQmJobPublisher(producer), producer };
}
