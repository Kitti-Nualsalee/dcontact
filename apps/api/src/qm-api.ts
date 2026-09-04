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
  ) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const evaluation = await transaction.qmEvaluation.findFirst({
        where: {
          id: uuid(evaluationId, 'evaluationId'),
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
          details: { publishedAt: publishedAt.toISOString() },
        },
      });
      return result;
    });
  }
}
