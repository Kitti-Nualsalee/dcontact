import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Body,
  Req,
} from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const QM_DATABASE = Symbol('QM_DATABASE');
export const QM_JOB_PUBLISHER = Symbol('QM_JOB_PUBLISHER');

export interface QmJobPublisher {
  publish(input: { tenantId: string; job: QmTranscriptionJobMessage }): Promise<void>;
}

interface QmQueuePolicyBody {
  transcriptionMode?: unknown;
  transcriptionLanguage?: unknown;
  transcriptionMaxAttempts?: unknown;
  autoQmEnabled?: unknown;
}

interface PublishEvaluationBody {
  commandId?: unknown;
}

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function uuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function commandId(body: PublishEvaluationBody): string {
  if (!body || typeof body !== 'object') throw new BadRequestException('commandId is required');
  return uuid(body.commandId as string, 'commandId');
}

function pauseIntervals(value: unknown): { startMs: number; endMs: number; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((interval) => {
    if (!interval || typeof interval !== 'object') return [];
    const candidate = interval as { startMs?: unknown; endMs?: unknown; reason?: unknown };
    if (
      !Number.isInteger(candidate.startMs) ||
      !Number.isInteger(candidate.endMs) ||
      typeof candidate.reason !== 'string'
    ) {
      return [];
    }
    return [
      {
        startMs: candidate.startMs as number,
        endMs: candidate.endMs as number,
        reason: candidate.reason,
      },
    ];
  });
}

function evaluationAnswers(value: unknown): { score?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const score = (value as { score?: unknown }).score;
  return typeof score === 'number' ? { score } : {};
}

function qmPolicy(body: QmQueuePolicyBody): {
  transcriptionMode: 'OFF' | 'AUTOMATIC' | 'MANUAL';
  transcriptionLanguage: string;
  transcriptionMaxAttempts: number;
  autoQmEnabled: boolean;
} {
  if (
    body.transcriptionMode !== 'OFF' &&
    body.transcriptionMode !== 'AUTOMATIC' &&
    body.transcriptionMode !== 'MANUAL'
  ) {
    throw new BadRequestException('transcriptionMode must be OFF, AUTOMATIC or MANUAL');
  }
  if (
    typeof body.transcriptionLanguage !== 'string' ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.transcriptionLanguage)
  ) {
    throw new BadRequestException('transcriptionLanguage must be a BCP 47 language tag');
  }
  if (
    !Number.isInteger(body.transcriptionMaxAttempts) ||
    (body.transcriptionMaxAttempts as number) < 1 ||
    (body.transcriptionMaxAttempts as number) > 10
  ) {
    throw new BadRequestException('transcriptionMaxAttempts must be an integer from 1 to 10');
  }
  if (typeof body.autoQmEnabled !== 'boolean') {
    throw new BadRequestException('autoQmEnabled must be a boolean');
  }
  return {
    transcriptionMode: body.transcriptionMode,
    transcriptionLanguage: body.transcriptionLanguage,
    transcriptionMaxAttempts: body.transcriptionMaxAttempts as number,
    autoQmEnabled: body.autoQmEnabled,
  };
}

function isTeamSupervisor(
  actor: { roles: readonly string[]; userId: string },
  supervisor: { teamId: string | null } | null,
  targetTeamId: string | null | undefined,
): boolean {
  return Boolean(
    actor.roles.includes('supervisor') &&
    supervisor?.teamId &&
    targetTeamId &&
    supervisor.teamId === targetTeamId,
  );
}

@Controller('api/v1')
export class QmController {
  constructor(
    @Inject(QM_DATABASE) private readonly database: PrismaClient,
    @Inject(QM_JOB_PUBLISHER) private readonly jobs: QmJobPublisher,
  ) {}

  @Put('queues/:queueId/qm-policy')
  @GatewayRoles('admin')
  async updateQueuePolicy(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('queueId') queueId: string,
    @Body() body: QmQueuePolicyBody,
  ) {
    const actor = identity(request);
    const policy = qmPolicy(body);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const queue = await transaction.queue.findFirst({
        where: { id: uuid(queueId, 'queueId'), tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!queue) throw new NotFoundException();
      const updated = await transaction.queue.update({
        where: { id: queue.id },
        data: policy,
        select: {
          id: true,
          transcriptionMode: true,
          transcriptionLanguage: true,
          transcriptionMaxAttempts: true,
          autoQmEnabled: true,
        },
      });
      await transaction.queueAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          queueId: queue.id,
          actorUserId: actor.userId,
          action: 'QUEUE_UPDATED',
          details: { changed: 'qmPolicy', after: updated },
        },
      });
      return {
        queueId: updated.id,
        transcriptionMode: updated.transcriptionMode,
        transcriptionLanguage: updated.transcriptionLanguage,
        transcriptionMaxAttempts: updated.transcriptionMaxAttempts,
        autoQmEnabled: updated.autoQmEnabled,
      };
    });
  }

  @Post('qm/interactions/:interactionId/transcription-jobs')
  @GatewayRoles('supervisor', 'admin')
  async requestTranscription(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    const actor = identity(request);
    const result = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const interaction = await transaction.interaction.findFirst({
          where: {
            id: uuid(interactionId, 'interactionId'),
            tenantId: actor.tenantId,
            endedAt: { not: null },
          },
          select: {
            id: true,
            agent: { select: { teamId: true } },
            queue: {
              select: {
                transcriptionMode: true,
                transcriptionLanguage: true,
                transcriptionMaxAttempts: true,
              },
            },
            recordings: {
              where: { endedAt: { not: null }, deletedAt: null },
              take: 1,
              select: { id: true },
            },
          },
        });
        if (!interaction?.queue || interaction.queue.transcriptionMode === 'OFF') {
          throw new NotFoundException();
        }
        const supervisor = actor.roles.includes('supervisor')
          ? await transaction.user.findFirst({
              where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
              select: { teamId: true },
            })
          : null;
        if (
          !actor.roles.includes('admin') &&
          !isTeamSupervisor(actor, supervisor, interaction.agent?.teamId)
        ) {
          throw new ForbiddenException();
        }
        const recording = interaction.recordings[0];
        if (!recording) throw new NotFoundException();
        const existing = await transaction.qmTranscriptionJob.findFirst({
          where: { tenantId: actor.tenantId, interactionId: interaction.id },
          select: {
            id: true,
            interactionId: true,
            recordingId: true,
            status: true,
            trigger: true,
            languageHint: true,
            attempts: true,
            dispatchedAt: true,
          },
        });
        if (existing) return { job: existing, shouldDispatch: existing.dispatchedAt === null };
        const job = await transaction.qmTranscriptionJob.create({
          data: {
            tenantId: actor.tenantId,
            interactionId: interaction.id,
            recordingId: recording.id,
            trigger: 'MANUAL',
            languageHint: interaction.queue.transcriptionLanguage,
            maxAttempts: interaction.queue.transcriptionMaxAttempts,
          },
          select: {
            id: true,
            interactionId: true,
            recordingId: true,
            status: true,
            trigger: true,
            languageHint: true,
            attempts: true,
            dispatchedAt: true,
          },
        });
        await transaction.qmAuditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'TRANSCRIPTION_REQUESTED',
            resourceType: 'TRANSCRIPTION_JOB',
            resourceId: job.id,
            details: { trigger: 'MANUAL' },
          },
        });
        return { job, shouldDispatch: true };
      },
    );
    if (result.shouldDispatch) {
      await this.jobs.publish({
        tenantId: actor.tenantId,
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
      await withTenantDatabaseTransaction(this.database, actor.tenantId, (transaction) =>
        transaction.qmTranscriptionJob.updateMany({
          where: { id: result.job.id, tenantId: actor.tenantId, dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        }),
      );
    }
    return {
      jobId: result.job.id,
      status: result.job.status,
      trigger: result.job.trigger,
    };
  }

  @Get('qm/transcription-jobs/:jobId')
  @GatewayRoles('supervisor', 'admin')
  async getTranscriptionJob(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('jobId') jobId: string,
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const job = await transaction.qmTranscriptionJob.findFirst({
        where: { id: uuid(jobId, 'jobId'), tenantId: actor.tenantId },
        select: {
          id: true,
          interactionId: true,
          status: true,
          trigger: true,
          attempts: true,
          maxAttempts: true,
          failureCode: true,
          failureReason: true,
          nextAttemptAt: true,
          interaction: { select: { agent: { select: { teamId: true } } } },
        },
      });
      if (!job) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      if (
        !actor.roles.includes('admin') &&
        !isTeamSupervisor(actor, supervisor, job.interaction.agent?.teamId)
      ) {
        throw new NotFoundException();
      }
      return {
        jobId: job.id,
        interactionId: job.interactionId,
        status: job.status,
        trigger: job.trigger,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        failureCode: job.failureCode,
        failureReason: job.failureReason,
        nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
      };
    });
  }

  @Post('qm/interactions/:interactionId/console-context')
  @GatewayRoles('supervisor', 'admin')
  async createConsoleContext(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const interaction = await transaction.interaction.findFirst({
        where: { id: uuid(interactionId, 'interactionId'), tenantId: actor.tenantId },
        select: { id: true, agent: { select: { teamId: true } } },
      });
      if (!interaction) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      if (
        !actor.roles.includes('admin') &&
        !isTeamSupervisor(actor, supervisor, interaction.agent?.teamId)
      ) {
        throw new NotFoundException();
      }
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      const context = await transaction.qmConsoleContext.create({
        data: {
          tenantId: actor.tenantId,
          interactionId: interaction.id,
          issuedForUserId: actor.userId,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
      return { contextId: context.id, expiresAt: context.expiresAt.toISOString() };
    });
  }

  @Get('qm/console-contexts/:contextId')
  @GatewayRoles('supervisor', 'admin')
  async getConsoleContext(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('contextId') contextId: string,
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const issued = await transaction.qmConsoleContext.findFirst({
        where: {
          id: uuid(contextId, 'contextId'),
          tenantId: actor.tenantId,
          issuedForUserId: actor.userId,
          expiresAt: { gt: new Date() },
        },
        select: { interactionId: true },
      });
      if (!issued) throw new NotFoundException();
      const interaction = await transaction.interaction.findFirst({
        where: { id: issued.interactionId, tenantId: actor.tenantId },
        select: {
          id: true,
          channel: true,
          queue: { select: { name: true } },
          agent: { select: { teamId: true } },
          recordings: {
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { id: true, deletedAt: true, pauseIntervals: true },
          },
          qmTranscripts: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              language: true,
              segments: {
                orderBy: { startMs: 'asc' },
                select: { id: true, speaker: true, startMs: true, endMs: true, text: true },
              },
            },
          },
          qmEvaluations: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, status: true, source: true, answers: true },
          },
        },
      });
      if (!interaction) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      if (
        !actor.roles.includes('admin') &&
        !isTeamSupervisor(actor, supervisor, interaction.agent?.teamId)
      ) {
        throw new NotFoundException();
      }
      const recording = interaction.recordings[0];
      const transcript = interaction.qmTranscripts[0];
      const evaluation = interaction.qmEvaluations[0];
      return {
        interaction: {
          id: interaction.id,
          channel: interaction.channel,
          queueName: interaction.queue?.name ?? 'ไม่ระบุ queue',
        },
        recording: recording
          ? {
              id: recording.id,
              status: recording.deletedAt ? 'DELETED' : 'AVAILABLE',
              pauseIntervals: pauseIntervals(recording.pauseIntervals),
            }
          : null,
        transcript: transcript
          ? {
              id: transcript.id,
              language: transcript.language,
              segments: transcript.segments,
            }
          : null,
        evaluation: evaluation
          ? {
              id: evaluation.id,
              status: evaluation.status,
              source: evaluation.source,
              answers: evaluationAnswers(evaluation.answers),
            }
          : null,
      };
    });
  }

  @Get('qm/transcripts/:transcriptId')
  @GatewayRoles('agent', 'supervisor', 'admin')
  async getTranscript(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('transcriptId') transcriptId: string,
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const transcript = await transaction.qmTranscript.findFirst({
        where: { id: uuid(transcriptId, 'transcriptId'), tenantId: actor.tenantId },
        select: {
          id: true,
          interactionId: true,
          language: true,
          providerId: true,
          modelId: true,
          confidenceAvg: true,
          baseline: true,
          interaction: {
            select: {
              agentId: true,
              agent: { select: { teamId: true } },
              queue: { select: { recordingAgentSelfAccess: true } },
            },
          },
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
      if (!transcript) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      const ownAgent =
        actor.roles.includes('agent') &&
        transcript.interaction.agentId === actor.userId &&
        transcript.interaction.queue?.recordingAgentSelfAccess;
      if (
        !actor.roles.includes('admin') &&
        !ownAgent &&
        !isTeamSupervisor(actor, supervisor, transcript.interaction.agent?.teamId)
      ) {
        throw new NotFoundException();
      }
      await transaction.qmAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'TRANSCRIPT_ACCESSED',
          resourceType: 'QM_TRANSCRIPT',
          resourceId: transcript.id,
          details: { ip: request.socket.remoteAddress ?? null },
        },
      });
      const { interaction: _interaction, ...view } = transcript;
      return view;
    });
  }

  @Get('qm/evaluations/:evaluationId')
  @GatewayRoles('agent', 'supervisor', 'admin')
  async getEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('evaluationId') evaluationId: string,
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const evaluation = await transaction.qmEvaluation.findFirst({
        where: { id: uuid(evaluationId, 'evaluationId'), tenantId: actor.tenantId },
        select: {
          id: true,
          interactionId: true,
          agentId: true,
          evaluatorId: true,
          source: true,
          status: true,
          providerId: true,
          modelId: true,
          promptVersion: true,
          answers: true,
          publishedAt: true,
          interaction: { select: { agent: { select: { teamId: true } } } },
        },
      });
      if (!evaluation) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      const mayReview =
        actor.roles.includes('admin') ||
        isTeamSupervisor(actor, supervisor, evaluation.interaction.agent?.teamId);
      const ownPublished =
        evaluation.status === 'PUBLISHED' &&
        actor.roles.includes('agent') &&
        evaluation.agentId === actor.userId;
      if (!mayReview && !ownPublished) throw new NotFoundException();
      const { interaction: _interaction, ...view } = evaluation;
      return view;
    });
  }

  @Post('qm/evaluations/:evaluationId/publish')
  @GatewayRoles('supervisor', 'admin')
  async publishEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('evaluationId') evaluationId: string,
    @Body() body: PublishEvaluationBody,
  ) {
    const actor = identity(request);
    const receiptCommandId = commandId(body);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const requestedEvaluationId = uuid(evaluationId, 'evaluationId');
      const existingReceipt = await transaction.commandReceipt.findUnique({
        where: { tenantId_commandId: { tenantId: actor.tenantId, commandId: receiptCommandId } },
        select: { actorUserId: true, action: true, resourceId: true, result: true },
      });
      if (existingReceipt) {
        if (
          existingReceipt.actorUserId !== actor.userId ||
          existingReceipt.action !== 'QM_EVALUATION_PUBLISH' ||
          existingReceipt.resourceId !== requestedEvaluationId
        ) {
          throw new BadRequestException('commandId was already used for another command');
        }
        return existingReceipt.result;
      }
      const evaluation = await transaction.qmEvaluation.findFirst({
        where: {
          id: requestedEvaluationId,
          tenantId: actor.tenantId,
          status: 'DRAFT',
        },
        select: {
          id: true,
          interaction: { select: { agent: { select: { teamId: true } } } },
        },
      });
      if (!evaluation) throw new NotFoundException();
      const supervisor = actor.roles.includes('supervisor')
        ? await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          })
        : null;
      if (
        !actor.roles.includes('admin') &&
        !isTeamSupervisor(actor, supervisor, evaluation.interaction.agent?.teamId)
      ) {
        throw new NotFoundException();
      }
      const publishedAt = new Date();
      const result = await transaction.qmEvaluation.update({
        where: { id: evaluation.id },
        data: { status: 'PUBLISHED', evaluatorId: actor.userId, publishedAt },
        select: { id: true, status: true, evaluatorId: true },
      });
      await transaction.qmAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'EVALUATION_PUBLISHED',
          resourceType: 'QM_EVALUATION',
          resourceId: evaluation.id,
          details: { publishedAt: publishedAt.toISOString(), commandId: receiptCommandId },
        },
      });
      await transaction.commandReceipt.create({
        data: {
          tenantId: actor.tenantId,
          commandId: receiptCommandId,
          actorUserId: actor.userId,
          action: 'QM_EVALUATION_PUBLISH',
          resourceId: evaluation.id,
          result,
        },
      });
      return result;
    });
  }
}
