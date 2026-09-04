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
      await this.publisher.publish({
        tenantId: event.tenantId,
        job: {
          kind: 'TRANSCRIBE',
          jobId: result.job.id,
          interactionId: result.job.interactionId,
          recordingId: result.job.recordingId,
          languageHint: result.job.languageHint,
          trigger: result.job.trigger,
          attempt: result.job.attempts + 1,
        },
      });
      await withTenantDatabaseTransaction(this.database, event.tenantId, (transaction) =>
        transaction.qmTranscriptionJob.updateMany({
          where: { id: result.job.id, tenantId: event.tenantId, dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        }),
      );
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
