import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { TelephonyCommand, TelephonyVendor } from '@d-contact/shared';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const RECORDING_DATABASE = Symbol('RECORDING_DATABASE');
export const TELEPHONY_COMMAND_PUBLISHER = Symbol('TELEPHONY_COMMAND_PUBLISHER');
export const RECORDING_STORAGE = Symbol('RECORDING_STORAGE');

export interface TelephonyCommandPublisher {
  publish(input: { tenantId: string; command: TelephonyCommand }): Promise<void>;
}

export interface RecordingStorage {
  presignPlayback(input: {
    tenantId: string;
    storageKey: string;
    expiresInSeconds: number;
    download: boolean;
  }): Promise<{ url: string; expiresAt: Date }>;
  deleteObject(storageKey: string): Promise<void>;
}

interface RecordingControlBody {
  reason?: unknown;
}

interface RecordingPlaybackBody {
  download?: unknown;
}

interface LegalHoldBody {
  reason?: unknown;
}

interface RetentionRunBody {
  now?: unknown;
}

interface PauseInterval {
  startedAt: string;
  endedAt?: string;
  actorUserId: string;
  pauseReason: string;
  resumeReason?: string;
}

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function requiredIdentifier(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 240) {
    throw new BadRequestException('reason must contain 1-240 characters');
  }
  return value.trim();
}

function retentionNow(value: unknown): Date {
  if (typeof value !== 'string') throw new BadRequestException('now must be an ISO-8601 timestamp');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new BadRequestException('now must be an ISO-8601 timestamp');
  return parsed;
}

function pauseIntervals(value: Prisma.JsonValue): PauseInterval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.startedAt !== 'string' ||
      typeof candidate.actorUserId !== 'string' ||
      typeof candidate.pauseReason !== 'string'
    ) {
      return [];
    }
    return [
      {
        startedAt: candidate.startedAt,
        ...(typeof candidate.endedAt === 'string' ? { endedAt: candidate.endedAt } : {}),
        actorUserId: candidate.actorUserId,
        pauseReason: candidate.pauseReason,
        ...(typeof candidate.resumeReason === 'string'
          ? { resumeReason: candidate.resumeReason }
          : {}),
      },
    ];
  });
}

function telephonyCommand(
  interaction: { externalId: string | null; metadata: Prisma.JsonValue | null },
  recordingPath: string,
  type: 'recording.pause' | 'recording.resume',
): TelephonyCommand {
  if (
    !interaction.externalId ||
    !interaction.metadata ||
    typeof interaction.metadata !== 'object'
  ) {
    throw new ConflictException('recording has no active telephony call');
  }
  const metadata = interaction.metadata as Record<string, unknown>;
  const vendor = metadata.vendor;
  const telephonyNodeId = metadata.telephonyNodeId;
  if (
    (vendor !== 'freeswitch' && vendor !== 'asterisk') ||
    typeof telephonyNodeId !== 'string' ||
    telephonyNodeId.length === 0 ||
    recordingPath.length === 0
  ) {
    throw new ConflictException('recording has no telephony control path');
  }
  return {
    callUuid: interaction.externalId,
    vendor: vendor as TelephonyVendor,
    telephonyNodeId,
    type,
    recordingPath,
  };
}

@Controller('api/v1/recordings')
export class RecordingController {
  constructor(
    @Inject(RECORDING_DATABASE) private readonly database: PrismaClient,
    @Inject(TELEPHONY_COMMAND_PUBLISHER)
    private readonly commandPublisher: TelephonyCommandPublisher,
    @Inject(RECORDING_STORAGE) private readonly storage: RecordingStorage,
  ) {}

  @Post('retention/run')
  @GatewayRoles('admin')
  async runRetention(@Req() request: AuthenticatedGatewayRequest, @Body() body: RetentionRunBody) {
    const actor = identity(request);
    const now = retentionNow(body.now);
    const candidates = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      (transaction) =>
        transaction.recording.findMany({
          where: { tenantId: actor.tenantId, deletedAt: null, endedAt: { not: null } },
          select: {
            id: true,
            storageKey: true,
            endedAt: true,
            interaction: { select: { queue: { select: { recordingRetentionDays: true } } } },
            legalHolds: { where: { releasedAt: null }, select: { id: true } },
          },
        }),
    );
    const due = candidates.filter((recording) => {
      if (!recording.endedAt || recording.legalHolds.length > 0) return false;
      const retentionDays = recording.interaction.queue?.recordingRetentionDays ?? 90;
      return recording.endedAt.getTime() <= now.getTime() - retentionDays * 86_400_000;
    });
    const deletedRecordingIds: string[] = [];
    for (const recording of due) {
      await this.storage.deleteObject(recording.storageKey);
      const deleted = await withTenantDatabaseTransaction(
        this.database,
        actor.tenantId,
        async (transaction) => {
          const result = await transaction.recording.updateMany({
            where: {
              id: recording.id,
              tenantId: actor.tenantId,
              deletedAt: null,
              legalHolds: { none: { releasedAt: null } },
            },
            data: { deletedAt: now },
          });
          if (result.count !== 1) return false;
          await transaction.recordingAuditEvent.create({
            data: {
              tenantId: actor.tenantId,
              recordingId: recording.id,
              actorUserId: actor.userId,
              action: 'RETENTION_DELETED',
              details: { retentionRunAt: now.toISOString() },
            },
          });
          return true;
        },
      );
      if (deleted) deletedRecordingIds.push(recording.id);
    }
    return { deletedRecordingIds };
  }

  @Post(':recordingId/legal-holds')
  @GatewayRoles('admin')
  async placeLegalHold(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') recordingId: string,
    @Body() body: LegalHoldBody,
  ) {
    const actor = identity(request);
    const reason = requiredReason(body.reason);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const recording = await transaction.recording.findFirst({
        where: { id: requiredIdentifier(recordingId, 'recordingId'), tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!recording) throw new NotFoundException();
      const hold = await transaction.recordingLegalHold.create({
        data: {
          tenantId: actor.tenantId,
          recordingId: recording.id,
          reason,
          placedByUserId: actor.userId,
        },
        select: { id: true },
      });
      await transaction.recordingAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          recordingId: recording.id,
          actorUserId: actor.userId,
          action: 'LEGAL_HOLD_PLACED',
          reason,
          details: { legalHoldId: hold.id },
        },
      });
      return hold;
    });
  }

  @Delete(':recordingId/legal-holds/:legalHoldId')
  @HttpCode(204)
  @GatewayRoles('admin')
  async releaseLegalHold(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') recordingId: string,
    @Param('legalHoldId') legalHoldId: string,
  ) {
    const actor = identity(request);
    await withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const hold = await transaction.recordingLegalHold.findFirst({
        where: {
          id: requiredIdentifier(legalHoldId, 'legalHoldId'),
          recordingId: requiredIdentifier(recordingId, 'recordingId'),
          tenantId: actor.tenantId,
          releasedAt: null,
        },
        select: { id: true, recordingId: true },
      });
      if (!hold) throw new NotFoundException();
      const releasedAt = new Date();
      await transaction.recordingLegalHold.update({
        where: { id: hold.id },
        data: { releasedAt, releasedByUserId: actor.userId },
      });
      await transaction.recordingAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          recordingId: hold.recordingId,
          actorUserId: actor.userId,
          action: 'LEGAL_HOLD_RELEASED',
          details: { legalHoldId: hold.id, releasedAt: releasedAt.toISOString() },
        },
      });
    });
  }

  @Post(':recordingId/playback')
  @GatewayRoles('agent', 'supervisor', 'admin')
  async playback(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') recordingId: string,
    @Body() body: RecordingPlaybackBody,
  ) {
    if (typeof body.download !== 'boolean')
      throw new BadRequestException('download must be a boolean');
    const download = body.download;
    const actor = identity(request);
    const recording = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const selected = await transaction.recording.findFirst({
          where: {
            id: requiredIdentifier(recordingId, 'recordingId'),
            tenantId: actor.tenantId,
            deletedAt: null,
          },
          select: {
            id: true,
            storageKey: true,
            interaction: {
              select: {
                agentId: true,
                agent: { select: { teamId: true } },
                queue: {
                  select: { recordingAgentSelfAccess: true, recordingDownloadAllowed: true },
                },
              },
            },
          },
        });
        if (!selected) throw new NotFoundException();
        const isAdmin = actor.roles.includes('admin');
        const isOwnAgent =
          actor.roles.includes('agent') &&
          selected.interaction.agentId === actor.userId &&
          selected.interaction.queue?.recordingAgentSelfAccess;
        let isTeamSupervisor = false;
        if (!isAdmin && !isOwnAgent && actor.roles.includes('supervisor')) {
          const supervisor = await transaction.user.findFirst({
            where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
            select: { teamId: true },
          });
          isTeamSupervisor = Boolean(
            supervisor?.teamId && supervisor.teamId === selected.interaction.agent?.teamId,
          );
        }
        if (!isAdmin && !isOwnAgent && !isTeamSupervisor) throw new ForbiddenException();
        if (download && !selected.interaction.queue?.recordingDownloadAllowed) {
          await transaction.recordingAuditEvent.create({
            data: {
              tenantId: actor.tenantId,
              recordingId: selected.id,
              actorUserId: actor.userId,
              action: 'DOWNLOAD_DENIED',
              details: { requestedDownload: true },
            },
          });
          return { denied: true as const };
        }
        return {
          denied: false as const,
          recordingId: selected.id,
          storageKey: selected.storageKey,
        };
      },
    );
    if (recording.denied) throw new ForbiddenException('recording download is not permitted');
    const signed = await this.storage.presignPlayback({
      tenantId: actor.tenantId,
      storageKey: recording.storageKey,
      expiresInSeconds: 300,
      download,
    });
    await withTenantDatabaseTransaction(this.database, actor.tenantId, (transaction) =>
      transaction.recordingAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          recordingId: recording.recordingId,
          actorUserId: actor.userId,
          action: 'PLAYBACK_URL_ISSUED',
          details: {
            expiresAt: signed.expiresAt.toISOString(),
            download,
          },
        },
      }),
    );
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  @Post(':recordingId/pause')
  @GatewayRoles('agent')
  async pause(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') recordingId: string,
    @Body() body: RecordingControlBody,
  ) {
    return this.control(request, recordingId, requiredReason(body.reason), 'pause');
  }

  @Post(':recordingId/resume')
  @GatewayRoles('agent')
  async resume(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') recordingId: string,
    @Body() body: RecordingControlBody,
  ) {
    return this.control(request, recordingId, requiredReason(body.reason), 'resume');
  }

  private async control(
    request: AuthenticatedGatewayRequest,
    recordingId: string,
    reason: string,
    operation: 'pause' | 'resume',
  ) {
    const actor = identity(request);
    const changed = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const recording = await transaction.recording.findFirst({
          where: {
            id: requiredIdentifier(recordingId, 'recordingId'),
            tenantId: actor.tenantId,
            deletedAt: null,
          },
          select: {
            id: true,
            telephonyPath: true,
            pauseIntervals: true,
            interaction: {
              select: {
                agentId: true,
                externalId: true,
                metadata: true,
                state: true,
                queue: {
                  select: { recordingPauseResumeEnabled: true, recordingAgentSelfAccess: true },
                },
              },
            },
          },
        });
        if (!recording) throw new NotFoundException();
        if (
          recording.interaction.agentId !== actor.userId ||
          recording.interaction.state !== 'ACTIVE' ||
          !recording.interaction.queue?.recordingPauseResumeEnabled ||
          !recording.interaction.queue.recordingAgentSelfAccess
        ) {
          throw new ForbiddenException();
        }
        const intervals = pauseIntervals(recording.pauseIntervals);
        const now = new Date().toISOString();
        let nextIntervals: PauseInterval[];
        let action: 'PAUSED' | 'RESUMED';
        let status: 'PAUSED' | 'RECORDING';
        if (operation === 'pause') {
          if (intervals.some((interval) => !interval.endedAt))
            throw new ConflictException('recording is paused');
          nextIntervals = [
            ...intervals,
            { startedAt: now, actorUserId: actor.userId, pauseReason: reason },
          ];
          action = 'PAUSED';
          status = 'PAUSED';
        } else {
          const last = intervals.at(-1);
          if (!last || last.endedAt) throw new ConflictException('recording is not paused');
          nextIntervals = [
            ...intervals.slice(0, -1),
            { ...last, endedAt: now, resumeReason: reason },
          ];
          action = 'RESUMED';
          status = 'RECORDING';
        }
        await transaction.recording.update({
          where: { id: recording.id },
          data: { pauseIntervals: nextIntervals as unknown as Prisma.InputJsonValue },
        });
        await transaction.recordingAuditEvent.create({
          data: {
            tenantId: actor.tenantId,
            recordingId: recording.id,
            actorUserId: actor.userId,
            action,
            reason,
            details: { operation, occurredAt: now },
          },
        });
        return {
          recordingId: recording.id,
          status,
          command: telephonyCommand(
            recording.interaction,
            recording.telephonyPath,
            operation === 'pause' ? 'recording.pause' : 'recording.resume',
          ),
        };
      },
    );
    await this.commandPublisher.publish({ tenantId: actor.tenantId, command: changed.command });
    return { recordingId: changed.recordingId, status: changed.status };
  }
}
