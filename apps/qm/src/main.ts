import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore } from '@d-contact/kafka';
import {
  KAFKA_TOPICS,
  type QmInteractionEndedPayload,
  type QmTranscriptionJobMessage,
  readS3Bucket,
  readS3Configuration,
} from '@d-contact/shared';
import { HttpScoringProvider } from './http-scoring-provider.js';
import { HttpTranscriptionProvider } from './http-transcription-provider.js';
import { S3QmMediaSource } from './s3-qm-media-source.js';
import { createQmJobPublisher } from './qm-kafka.js';
import { QmRetryDispatcher } from './qm-retry-dispatcher.js';
import { QmTranscriptionWorker } from './qm-transcription-worker.js';
import { QmTranscriptionWorkflow } from './qm-transcription-workflow.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const database = new PrismaClient();
  const { publisher, producer } = await createQmJobPublisher();
  const workflow = new QmTranscriptionWorkflow(database, publisher);
  // QM ส่ง media ออกนอกเครือข่ายภายในได้จึงบังคับ HTTPS; QM_MEDIA_ENDPOINT ใช้ override endpoint เฉพาะ QM
  const s3 = readS3Configuration({ requireExplicit: true, purpose: 'for QM media source' });
  const media = new S3QmMediaSource({
    s3: { ...s3, endpoint: process.env.QM_MEDIA_ENDPOINT?.trim() || s3.endpoint },
    bucket: readS3Bucket('RECORDINGS'),
  });
  const transcription = new HttpTranscriptionProvider({
    id: required('QM_TRANSCRIPTION_PROVIDER_ID'),
    endpoint: required('QM_TRANSCRIPTION_ENDPOINT'),
    apiKey: process.env.QM_TRANSCRIPTION_API_KEY,
  });
  const scorer = process.env.QM_SCORING_ENDPOINT
    ? new HttpScoringProvider({
        id: required('QM_SCORING_PROVIDER_ID'),
        endpoint: process.env.QM_SCORING_ENDPOINT,
        modelId: required('QM_SCORING_MODEL_ID'),
        promptVersion: required('QM_SCORING_PROMPT_VERSION'),
        apiKey: process.env.QM_SCORING_API_KEY,
      })
    : undefined;
  const worker = new QmTranscriptionWorker(database, media, transcription, undefined, scorer);
  const retries = new QmRetryDispatcher(database, publisher);
  const interactionConsumer = await createConsumer<QmInteractionEndedPayload>({
    clientId: 'dcontact-qm-interaction-events-v1',
    groupId: 'dcontact-qm-interaction-ended-v1',
    topics: [KAFKA_TOPICS.INTERACTION_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => {
      if (event.type === 'interaction.ended') await workflow.handleInteractionEnded(event);
    },
  });
  const jobConsumer = await createConsumer<QmTranscriptionJobMessage>({
    clientId: 'dcontact-qm-worker-v1',
    groupId: 'dcontact-qm-transcription-worker-v1',
    topics: [KAFKA_TOPICS.QM_JOBS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => {
      if (event.type === 'qm.transcription.requested') {
        await worker.process(event.tenantId, event.payload);
      }
    },
  });
  const retryTimer = setInterval(() => {
    void retries.dispatchDue().catch((error: unknown) => {
      console.error('[qm] retry dispatch failed', error);
    });
  }, 5_000);
  retryTimer.unref();

  const shutdown = async () => {
    clearInterval(retryTimer);
    await Promise.all([
      interactionConsumer.disconnect(),
      jobConsumer.disconnect(),
      producer.disconnect(),
      database.$disconnect(),
    ]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
