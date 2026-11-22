import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type {
  QmInteractionEndedPayload,
  QmTranscriptionJobMessage,
  QmTranscriptionStatus,
  QmTranscriptionTrigger,
} from '@d-contact/shared';

export interface QmJobPublisher {
  publish(input: { tenantId: string; job: QmTranscriptionJobMessage }): Promise<void>;
}

export interface TranscriptionJobView {
  jobId: string;
  interactionId: string;
  recordingId: string;
  status: QmTranscriptionStatus;
  trigger: QmTranscriptionTrigger;
  languageHint: string;
  attempts: number;
  maxAttempts: number;
}

const jobSelection = {
  id: true,
  interactionId: true,
  recordingId: true,
  status: true,
  trigger: true,
  languageHint: true,
  attempts: true,
  maxAttempts: true,
  dispatchedAt: true,
} as const;

function toView(job: {
  id: string;
  interactionId: string;
  recordingId: string;
  status: QmTranscriptionStatus;
  trigger: QmTranscriptionTrigger;
  languageHint: string;
  attempts: number;
  maxAttempts: number;
}): TranscriptionJobView {
  return {
    jobId: job.id,
    interactionId: job.interactionId,
    recordingId: job.recordingId,
    status: job.status,
    trigger: job.trigger,
    languageHint: job.languageHint,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
  };
}

/**
 * claim ก่อน publish: ตั้ง dispatchedAt ก่อนส่ง Kafka เพื่อไม่ให้ทับค่าที่ worker ล้างไว้ตอนเลื่อน job ที่รอ recording archive
 * job ที่มี nextAttemptAt แล้ว (รอ archive หรือรอ retry) เป็นหน้าที่ของ QmRetryDispatcher จึงไม่ publish ซ้ำ
 * ถ้า process ตายระหว่าง claim กับ publish dispatcher จะกวาด dispatchedAt ที่ค้างเกิน QM_DISPATCH_STALE_MS
 */
export async function dispatchNewTranscriptionJob(
  database: PrismaClient,
  publisher: QmJobPublisher,
  tenantId: string,
  job: {
    id: string;
    interactionId: string;
    recordingId: string;
    trigger: QmTranscriptionTrigger;
    languageHint: string;
    attempts: number;
  },
): Promise<boolean> {
  const dispatchedAt = new Date();
  const claimed = await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.qmTranscriptionJob.updateMany({
      where: {
        id: job.id,
        tenantId,
        status: 'PENDING',
        attempts: job.attempts,
        dispatchedAt: null,
        nextAttemptAt: null,
      },
      data: { dispatchedAt },
    }),
  );
  if (claimed.count !== 1) return false;
  try {
    await publisher.publish({
      tenantId,
      job: {
        kind: 'TRANSCRIBE',
        jobId: job.id,
        interactionId: job.interactionId,
        recordingId: job.recordingId,
        languageHint: job.languageHint,
        trigger: job.trigger,
        attempt: job.attempts + 1,
      },
    });
  } catch (error) {
    await withTenantDatabaseTransaction(database, tenantId, (transaction) =>
      transaction.qmTranscriptionJob.updateMany({
        where: { id: job.id, tenantId, dispatchedAt },
        data: { dispatchedAt: null },
      }),
    );
    throw error;
  }
  return true;
}

export class QmTranscriptionWorkflow {
  constructor(
    private readonly database: PrismaClient,
    private readonly publisher: QmJobPublisher,
  ) {}

  async handleInteractionEnded(
    event: KafkaEventEnvelope<QmInteractionEndedPayload>,
  ): Promise<TranscriptionJobView | undefined> {
    if (event.type !== 'interaction.ended') return undefined;
    if (event.orderingKey !== event.payload.interactionId) {
      throw new Error('interaction event tenant/order contract mismatch');
    }
    const result = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const existing = await transaction.qmTranscriptionJob.findFirst({
          where: { tenantId: event.tenantId, interactionId: event.payload.interactionId },
          select: jobSelection,
        });
        if (existing) return { job: existing, shouldDispatch: existing.dispatchedAt === null };

        const interaction = await transaction.interaction.findFirst({
          where: {
            id: event.payload.interactionId,
            tenantId: event.tenantId,
            endedAt: { not: null },
          },
          select: {
            id: true,
            queue: {
              select: {
                transcriptionMode: true,
                transcriptionLanguage: true,
                transcriptionMaxAttempts: true,
              },
            },
            recordings: {
              where: { deletedAt: null, endedAt: { not: null } },
              take: 1,
              select: { id: true },
            },
          },
        });
        if (!interaction?.queue || interaction.queue.transcriptionMode !== 'AUTOMATIC') {
          return undefined;
        }
        const recording = interaction.recordings[0];
        if (!recording) return undefined;
        try {
          const job = await transaction.qmTranscriptionJob.create({
            data: {
              tenantId: event.tenantId,
              interactionId: interaction.id,
              recordingId: recording.id,
              sourceEventId: event.eventId,
              trigger: 'AUTOMATIC',
              languageHint: interaction.queue.transcriptionLanguage,
              maxAttempts: interaction.queue.transcriptionMaxAttempts,
            },
            select: jobSelection,
          });
          await transaction.qmAuditEvent.create({
            data: {
              tenantId: event.tenantId,
              action: 'TRANSCRIPTION_REQUESTED',
              resourceType: 'TRANSCRIPTION_JOB',
              resourceId: job.id,
              details: { trigger: 'AUTOMATIC', sourceEventId: event.eventId },
            },
          });
          return { job, shouldDispatch: true };
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            throw error;
          }
          const job = await transaction.qmTranscriptionJob.findFirstOrThrow({
            where: { tenantId: event.tenantId, interactionId: interaction.id },
            select: jobSelection,
          });
          return { job, shouldDispatch: job.dispatchedAt === null };
        }
      },
    );
    if (!result) return undefined;
    if (result.shouldDispatch) {
      await dispatchNewTranscriptionJob(this.database, this.publisher, event.tenantId, result.job);
    }
    return toView(result.job);
  }

  async getJob(tenantId: string, jobId: string): Promise<TranscriptionJobView | undefined> {
    const job = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.qmTranscriptionJob.findFirst({
        where: { id: jobId, tenantId },
        select: jobSelection,
      }),
    );
    return job ? toView(job) : undefined;
  }
}
