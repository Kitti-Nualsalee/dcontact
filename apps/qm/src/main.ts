import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore } from '@d-contact/kafka';
import {
  KAFKA_TOPICS,
  type QmInteractionEndedPayload,
  type QmTranscriptionJobMessage,
  readS3Bucket,
  readS3Configuration,
} from '@d-contact/shared';
import { DEFAULT_SCORING_TIMEOUT_MS, HttpScoringProvider } from './http-scoring-provider.js';
import {
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  HttpTranscriptionProvider,
} from './http-transcription-provider.js';
import { jobRebalanceTimeoutMs, whileHeartbeating } from './kafka-heartbeat.js';
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

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const database = new PrismaClient();
  const { publisher, producer } = await createQmJobPublisher();
  const workflow = new QmTranscriptionWorkflow(database, publisher);
  // QM may send media outside the internal network, so HTTPS is required; QM_MEDIA_ENDPOINT overrides the endpoint for QM only
  const s3 = readS3Configuration({ requireExplicit: true, purpose: 'for QM media source' });
  const media = new S3QmMediaSource({
    s3: { ...s3, endpoint: process.env.QM_MEDIA_ENDPOINT?.trim() || s3.endpoint },
    bucket: readS3Bucket('RECORDINGS'),
  });
  const transcriptionTimeoutMs =
    optionalPositiveInteger('QM_TRANSCRIPTION_TIMEOUT_MS') ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  const transcription = new HttpTranscriptionProvider({
    id: required('QM_TRANSCRIPTION_PROVIDER_ID'),
    endpoint: required('QM_TRANSCRIPTION_ENDPOINT'),
    apiKey: process.env.QM_TRANSCRIPTION_API_KEY,
    timeoutMs: transcriptionTimeoutMs,
  });
  const scoringTimeoutMs =
    optionalPositiveInteger('QM_SCORING_TIMEOUT_MS') ?? DEFAULT_SCORING_TIMEOUT_MS;
  const scorer = process.env.QM_SCORING_ENDPOINT
    ? new HttpScoringProvider({
        id: required('QM_SCORING_PROVIDER_ID'),
        endpoint: process.env.QM_SCORING_ENDPOINT,
        modelId: required('QM_SCORING_MODEL_ID'),
        promptVersion: required('QM_SCORING_PROMPT_VERSION'),
        apiKey: process.env.QM_SCORING_API_KEY,
        timeoutMs: scoringTimeoutMs,
      })
    : undefined;
  // the longest a job may legitimately run: every provider call it makes plus headroom
  const jobTimeoutMs = jobRebalanceTimeoutMs([
    transcriptionTimeoutMs,
    ...(scorer ? [scoringTimeoutMs] : []),
  ]);
  const worker = new QmTranscriptionWorker(database, media, transcription, undefined, scorer);
  // a PROCESSING job older than the longest a live job can run lost its worker
  const retries = new QmRetryDispatcher(database, publisher, {
    processingStaleMs: jobTimeoutMs + 120_000,
  });
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
    // a job waits for the provider far longer than the 30 s session timeout: heartbeat while it runs
    // and let a rebalance wait for the job to finish instead of evicting this worker
    rebalanceTimeoutMs: jobTimeoutMs,
    handler: async ({ event, heartbeat }) => {
      if (event.type === 'qm.transcription.requested') {
        await whileHeartbeating(heartbeat, () => worker.process(event.tenantId, event.payload), {
          maxMs: jobTimeoutMs,
          onError: (error) => console.warn('[qm] heartbeat failed during a job', error),
        });
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
