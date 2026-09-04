import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage, QmTranscriptionStatus } from '@d-contact/shared';

export type TranscriptSpeaker = 'AGENT' | 'CONTACT' | 'SYSTEM' | 'IVR';

export interface TranscriptionSegmentResult {
  speaker: TranscriptSpeaker;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

export interface TranscriptionProviderResult {
  modelId: string;
  language: string;
  confidenceAvg: number;
  segments: TranscriptionSegmentResult[];
}

export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: {
    mediaUrl: string;
    mediaUrlExpiresAt: string;
    channelLayout: 'PER_LEG' | 'STEREO';
    languageHint: string;
    dataUse: 'NO_TRAINING';
  }): Promise<TranscriptionProviderResult>;
}

export interface QmRecordingMediaSource {
  createEncryptedReadUrl(input: {
    tenantId: string;
    storageKey: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
}

export interface QmWorkerClock {
  now(): Date;
}

export interface QmEvidence {
  segmentIds: string[];
  startMs: number;
  endMs: number;
  quote: string;
}

export interface QmAutoScoreAnswer {
  questionId: string;
  value: string;
  confidence: number;
  evidence: QmEvidence[];
}

export interface QmScoringProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: string;
  score(input: {
    segments: Array<TranscriptionSegmentResult & { id: string }>;
    context: { interactionId: string; queueName: string; durationSec: number };
  }): Promise<{ answers: QmAutoScoreAnswer[] }>;
}

export interface QmWorkerResult {
  jobId: string;
  status: QmTranscriptionStatus;
  attempts: number;
  nextAttemptAt?: string;
}

function retryDelayMs(attempts: number): number {
  return 30_000 * 2 ** (attempts - 1);
}

function failure(error: unknown): { code: string; reason: string } {
  if (error instanceof Error) {
    return { code: error.name || 'TRANSCRIPTION_ERROR', reason: error.message.slice(0, 500) };
  }
  return { code: 'TRANSCRIPTION_ERROR', reason: 'unknown transcription failure' };
}

function validateTranscription(result: TranscriptionProviderResult): void {
  if (!result.modelId.trim() || !result.language.trim()) {
    throw new Error('transcription provider result requires model and language');
  }
  if (result.confidenceAvg < 0 || result.confidenceAvg > 1 || result.segments.length === 0) {
    throw new Error('transcription provider result is invalid');
  }
  for (const segment of result.segments) {
    if (
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs ||
      !segment.text.trim() ||
      (segment.confidence !== undefined && (segment.confidence < 0 || segment.confidence > 1))
    ) {
      throw new Error('transcription segment is invalid');
    }
  }
}

function normalizeAnswers(
  answers: QmAutoScoreAnswer[],
  segments: Array<TranscriptionSegmentResult & { id: string }>,
): QmAutoScoreAnswer[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return answers.map((answer) => {
    const validEvidence =
      answer.value !== 'INSUFFICIENT_EVIDENCE' &&
      answer.evidence.length > 0 &&
      answer.evidence.every((evidence) => {
        if (
          evidence.segmentIds.length === 0 ||
          evidence.startMs < 0 ||
          evidence.endMs <= evidence.startMs ||
          !evidence.quote.trim()
        ) {
          return false;
        }
        const referenced = evidence.segmentIds.map((id) => byId.get(id));
        return (
          referenced.every(Boolean) &&
          referenced.some((segment) => segment!.text.includes(evidence.quote.trim()))
        );
      });
    if (!validEvidence) {
      return { ...answer, value: 'INSUFFICIENT_EVIDENCE', evidence: [] };
    }
    return answer;
  });
}

export class QmTranscriptionWorker {
  constructor(
    private readonly database: PrismaClient,
    private readonly media: QmRecordingMediaSource,
    private readonly provider: TranscriptionProvider,
    private readonly clock: QmWorkerClock = { now: () => new Date() },
    private readonly scorer?: QmScoringProvider,
  ) {}

  async process(tenantId: string, message: QmTranscriptionJobMessage): Promise<QmWorkerResult> {
    const startedAt = this.clock.now();
    const claimed = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const job = await transaction.qmTranscriptionJob.findFirst({
          where: { id: message.jobId, tenantId },
          select: {
            id: true,
            interactionId: true,
            recordingId: true,
            languageHint: true,
            attempts: true,
            maxAttempts: true,
            nextAttemptAt: true,
            status: true,
            recording: {
              select: {
                storageKey: true,
                channelLayout: true,
                durationSec: true,
                deletedAt: true,
              },
            },
            interaction: {
              select: {
                agentId: true,
                queue: { select: { name: true, autoQmEnabled: true } },
              },
            },
          },
        });
        if (!job) throw new Error('transcription job not found in tenant');
        if (
          job.interactionId !== message.interactionId ||
          job.recordingId !== message.recordingId
        ) {
          throw new Error('transcription job message does not match persisted job');
        }
        if (message.attempt <= job.attempts) return { ...job, duplicate: true as const };
        if (message.attempt !== job.attempts + 1) {
          throw new Error('transcription job attempt is out of sequence');
        }
        if (job.status !== 'PENDING') throw new Error(`transcription job is ${job.status}`);
        if (job.nextAttemptAt && job.nextAttemptAt.getTime() > startedAt.getTime()) {
          throw new Error('transcription retry is not due yet');
        }
        if (job.recording.deletedAt) throw new Error('recording was deleted');
        await transaction.qmTranscriptionJob.update({
          where: { id: job.id },
          data: {
            status: 'PROCESSING',
            attempts: { increment: 1 },
            providerId: this.provider.id,
            startedAt,
            nextAttemptAt: null,
          },
        });
        await transaction.qmAuditEvent.create({
          data: {
            tenantId,
            action: 'TRANSCRIPTION_STARTED',
            resourceType: 'TRANSCRIPTION_JOB',
            resourceId: job.id,
            details: { attempt: message.attempt, providerId: this.provider.id },
          },
        });
        return { ...job, duplicate: false as const };
      },
    );

    if (claimed.duplicate) {
      return {
        jobId: claimed.id,
        status: claimed.status,
        attempts: claimed.attempts,
        ...(claimed.nextAttemptAt ? { nextAttemptAt: claimed.nextAttemptAt.toISOString() } : {}),
      };
    }

    let transcription: TranscriptionProviderResult;
    try {
      const signed = await this.media.createEncryptedReadUrl({
        tenantId,
        storageKey: claimed.recording.storageKey,
        expiresInSeconds: 300,
      });
      const url = new URL(signed.url);
      if (url.protocol !== 'https:') throw new Error('transcription media URL must use HTTPS');
      if (signed.expiresAt.getTime() <= startedAt.getTime()) {
        throw new Error('transcription media URL is expired');
      }
      transcription = await this.provider.transcribe({
        mediaUrl: signed.url,
        mediaUrlExpiresAt: signed.expiresAt.toISOString(),
        channelLayout: claimed.recording.channelLayout,
        languageHint: claimed.languageHint,
        dataUse: 'NO_TRAINING',
      });
      validateTranscription(transcription);
    } catch (error) {
      const failedAt = this.clock.now();
      const problem = failure(error);
      return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
        const current = await transaction.qmTranscriptionJob.findFirstOrThrow({
          where: { id: claimed.id, tenantId },
          select: { attempts: true, maxAttempts: true },
        });
        const exhausted = current.attempts >= current.maxAttempts;
        const nextAttemptAt = exhausted
          ? undefined
          : new Date(failedAt.getTime() + retryDelayMs(current.attempts));
        const job = await transaction.qmTranscriptionJob.update({
          where: { id: claimed.id },
          data: {
            status: exhausted ? 'FAILED' : 'PENDING',
            failureCode: problem.code,
            failureReason: problem.reason,
            dispatchedAt: null,
            nextAttemptAt: nextAttemptAt ?? null,
            ...(exhausted ? { completedAt: failedAt } : {}),
          },
          select: { id: true, status: true, attempts: true, nextAttemptAt: true },
        });
        await transaction.qmAuditEvent.create({
          data: {
            tenantId,
            action: exhausted ? 'TRANSCRIPTION_FAILED' : 'TRANSCRIPTION_RETRY_SCHEDULED',
            resourceType: 'TRANSCRIPTION_JOB',
            resourceId: claimed.id,
            details: {
              attempt: job.attempts,
              maxAttempts: current.maxAttempts,
              failureCode: problem.code,
              ...(job.nextAttemptAt ? { nextAttemptAt: job.nextAttemptAt.toISOString() } : {}),
            },
          },
        });
        return {
          jobId: job.id,
          status: job.status,
          attempts: job.attempts,
          ...(job.nextAttemptAt ? { nextAttemptAt: job.nextAttemptAt.toISOString() } : {}),
        };
      });
    }

    const completedAt = this.clock.now();
    const audioDurationMs = (claimed.recording.durationSec ?? 0) * 1_000;
    const processingLatencyMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const baseline = {
      audioDurationMs,
      processingLatencyMs,
      realTimeFactor:
        audioDurationMs === 0
          ? 0
          : Math.round((processingLatencyMs / audioDurationMs) * 1_000) / 1_000,
      segmentCount: transcription.segments.length,
    };
    const ready = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const transcript = await transaction.qmTranscript.create({
          data: {
            tenantId,
            interactionId: claimed.interactionId,
            recordingId: claimed.recordingId,
            jobId: claimed.id,
            providerId: this.provider.id,
            modelId: transcription.modelId,
            language: transcription.language,
            confidenceAvg: transcription.confidenceAvg,
            baseline,
            segments: {
              create: transcription.segments.map((segment) => ({
                tenantId,
                speaker: segment.speaker,
                startMs: segment.startMs,
                endMs: segment.endMs,
                text: segment.text.trim(),
                ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
              })),
            },
          },
          select: {
            segments: {
              orderBy: { startMs: 'asc' },
              select: {
                id: true,
                speaker: true,
                startMs: true,
                endMs: true,
                text: true,
                confidence: true,
              },
            },
          },
        });
        const completed = await transaction.qmTranscriptionJob.update({
          where: { id: claimed.id },
          data: {
            status: 'READY',
            completedAt,
            failureCode: null,
            failureReason: null,
          },
          select: { id: true, status: true, attempts: true },
        });
        await transaction.qmAuditEvent.create({
          data: {
            tenantId,
            action: 'TRANSCRIPTION_READY',
            resourceType: 'TRANSCRIPTION_JOB',
            resourceId: claimed.id,
            details: { attempt: completed.attempts, providerId: this.provider.id, baseline },
          },
        });
        return { completed, segments: transcript.segments };
      },
    );

    if (this.scorer && claimed.interaction.queue?.autoQmEnabled && claimed.interaction.agentId) {
      const segments = ready.segments.map((segment) => ({
        ...segment,
        confidence: segment.confidence ?? undefined,
      }));
      const scored = await this.scorer.score({
        segments,
        context: {
          interactionId: claimed.interactionId,
          queueName: claimed.interaction.queue.name,
          durationSec: claimed.recording.durationSec ?? 0,
        },
      });
      const answers = normalizeAnswers(scored.answers, segments);
      await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
        const evaluation = await transaction.qmEvaluation.create({
          data: {
            tenantId,
            interactionId: claimed.interactionId,
            agentId: claimed.interaction.agentId!,
            source: 'AUTO_DRAFT',
            status: 'DRAFT',
            providerId: this.scorer!.id,
            modelId: this.scorer!.modelId,
            promptVersion: this.scorer!.promptVersion,
            answers: answers as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await transaction.qmAuditEvent.create({
          data: {
            tenantId,
            action: 'AUTO_QM_DRAFT_CREATED',
            resourceType: 'QM_EVALUATION',
            resourceId: evaluation.id,
            details: {
              providerId: this.scorer!.id,
              modelId: this.scorer!.modelId,
              promptVersion: this.scorer!.promptVersion,
            },
          },
        });
      });
    }
    return {
      jobId: ready.completed.id,
      status: ready.completed.status,
      attempts: ready.completed.attempts,
    };
  }

  async getTranscript(tenantId: string, interactionId: string) {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.qmTranscript.findFirst({
        where: { tenantId, interactionId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          providerId: true,
          modelId: true,
          language: true,
          confidenceAvg: true,
          baseline: true,
          segments: {
            orderBy: { startMs: 'asc' },
            select: {
              id: true,
              speaker: true,
              startMs: true,
              endMs: true,
              text: true,
              confidence: true,
            },
          },
        },
      }),
    );
  }

  async getDraftEvaluation(tenantId: string, interactionId: string) {
    const evaluation = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.qmEvaluation.findFirst({
        where: { tenantId, interactionId, status: 'DRAFT' },
        select: {
          id: true,
          status: true,
          evaluatorId: true,
          providerId: true,
          modelId: true,
          promptVersion: true,
          answers: true,
        },
      }),
    );
    return evaluation
      ? { ...evaluation, answers: evaluation.answers as unknown as QmAutoScoreAnswer[] }
      : undefined;
  }

  async getAuditTrail(tenantId: string, jobId: string) {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.qmAuditEvent.findMany({
        where: { tenantId, resourceType: 'TRANSCRIPTION_JOB', resourceId: jobId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, details: true, createdAt: true },
      }),
    );
  }
}
