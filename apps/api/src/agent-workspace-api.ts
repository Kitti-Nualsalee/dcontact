import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  Headers,
  Header,
  HttpException,
  InternalServerErrorException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { AGENT_SIP_CREDENTIALS, type AgentSipCredentialService } from './agent-sip-credentials.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { EmbedOriginService } from './embed-origins.js';
import { saveAgentWrapup, readAgentWrapup, readAgentWrapupCommand } from './agent-wrapup-v1.js';
import { readAgentHistory } from './agent-history.js';

export const AGENT_WORKSPACE_DATABASE = Symbol('AGENT_WORKSPACE_DATABASE');

async function wrapupOperation<Result>(
  request: AuthenticatedGatewayRequest,
  operation: () => Promise<Result>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      throw new HttpException(
        {
          ...(typeof body === 'object' ? body : { code: 'WRAPUP_REQUEST_FAILED' }),
          correlationId: request.correlationId,
        },
        error.getStatus(),
      );
    }
    throw new InternalServerErrorException({
      code: 'WRAPUP_REQUEST_FAILED',
      correlationId: request.correlationId,
    });
  }
}

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function callerFrom(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const caller = (metadata as Record<string, unknown>).caller;
  return typeof caller === 'string' ? caller : null;
}

function requiredUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function wrapupBody(value: { disposition?: unknown; commandId?: unknown; note?: unknown }) {
  if (Object.hasOwn(value, 'note')) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'note' });
  }
  if (typeof value.disposition !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(value.disposition)) {
    throw new BadRequestException('disposition must be an uppercase code');
  }
  if (typeof value.commandId !== 'string')
    throw new BadRequestException('commandId must be a UUID');
  return { disposition: value.disposition, commandId: requiredUuid(value.commandId, 'commandId') };
}

@Controller('api/v1/workspace/agent')
export class AgentWorkspaceController {
  constructor(
    @Inject(AGENT_WORKSPACE_DATABASE) private readonly database: PrismaClient,
    @Inject(AGENT_SIP_CREDENTIALS)
    private readonly sipCredentialsService: AgentSipCredentialService,
  ) {}

  @Get('history')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async history(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    return wrapupOperation(request, () =>
      readAgentHistory(this.database, identity(request), limit, cursor),
    );
  }

  @Get('snapshot')
  @GatewayRoles('agent')
  async snapshot(@Req() request: AuthenticatedGatewayRequest) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const agent = await transaction.user.findFirst({
        where: {
          id: actor.userId,
          tenantId: actor.tenantId,
          role: 'AGENT',
          isActive: true,
        },
        select: {
          id: true,
          displayName: true,
          extension: true,
          stateLogs: {
            select: { state: true },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      });
      if (!agent) throw new NotFoundException();

      const interaction = await transaction.interaction.findFirst({
        where: {
          tenantId: actor.tenantId,
          agentId: actor.userId,
          state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
        },
        select: {
          id: true,
          state: true,
          direction: true,
          voiceWrapupPolicy: true,
          metadata: true,
          offerExpiresAt: true,
          answeredAt: true,
          endedAt: true,
          queue: { select: { id: true, name: true } },
          events: { select: { id: true }, orderBy: { id: 'desc' }, take: 1 },
        },
        orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }],
      });

      return {
        capabilities: { voiceWrapupV1: 1 },
        agent: {
          id: agent.id,
          displayName: agent.displayName,
          extension: agent.extension,
          state: agent.stateLogs[0]?.state ?? 'OFFLINE',
        },
        interaction: interaction
          ? {
              id: interaction.id,
              state: interaction.state,
              direction: interaction.direction,
              voiceWrapupPolicy: interaction.voiceWrapupPolicy,
              version: (interaction.events[0]?.id ?? 0n).toString(),
              caller: callerFrom(interaction.metadata),
              queue: interaction.queue,
              offerExpiresAt: interaction.offerExpiresAt?.toISOString() ?? null,
              answeredAt: interaction.answeredAt?.toISOString() ?? null,
              endedAt: interaction.endedAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  }

  @Post('availability')
  @HttpCode(200)
  @GatewayRoles('agent')
  async becomeAvailable(
    @Req() request: AuthenticatedGatewayRequest,
    @Headers('x-work-session-lease-id') workSessionLeaseId: string | undefined,
    @Body() body: { state?: unknown } | undefined,
  ) {
    const actor = identity(request);
    const leaseId = requiredUuid(workSessionLeaseId ?? '', 'x-work-session-lease-id');
    if (body?.state !== 'AVAILABLE')
      throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'state' });
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT id FROM users WHERE tenant_id = ${actor.tenantId}::uuid
          AND id = ${actor.userId}::uuid FOR NO KEY UPDATE
      `);
      const agent = await transaction.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId, role: 'AGENT', isActive: true },
        select: { id: true },
      });
      if (!agent) throw new NotFoundException();
      await transaction.$queryRaw(Prisma.sql`
        SELECT id FROM agent_work_session_leases WHERE tenant_id = ${actor.tenantId}::uuid
          AND user_id = ${actor.userId}::uuid AND id = ${leaseId}::uuid FOR UPDATE
      `);
      const lease = await transaction.agentWorkSessionLease.findFirst({
        where: {
          id: leaseId,
          tenantId: actor.tenantId,
          userId: actor.userId,
          releasedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { surface: true, hostOrigin: true },
      });
      if (!lease) throw new ForbiddenException({ code: 'WORK_SESSION_CHANGED' });
      if (lease.surface === 'embedded') {
        await transaction.$queryRaw(Prisma.sql`
          SELECT id FROM tenant_embed_origins WHERE tenant_id = ${actor.tenantId}::uuid
            AND origin = ${lease.hostOrigin} FOR SHARE
        `);
        if (
          !lease.hostOrigin ||
          !(await new EmbedOriginService(this.database).isEmbeddableInTransaction(
            transaction,
            actor.tenantId,
            lease.hostOrigin,
          ))
        )
          throw new ForbiddenException({ code: 'EMBED_ORIGIN_NOT_ALLOWED' });
      }
      const credential = await transaction.agentSipCredential.findFirst({
        where: {
          workSessionLeaseId: leaseId,
          tenantId: actor.tenantId,
          userId: actor.userId,
          revokedAt: null,
        },
        select: { workSessionLeaseId: true },
      });
      if (!credential) throw new ConflictException({ code: 'AGENT_SIP_NOT_READY' });
      const busy = await transaction.interaction.count({
        where: {
          tenantId: actor.tenantId,
          agentId: actor.userId,
          channel: 'VOICE',
          state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
        },
      });
      if (busy) throw new ConflictException({ code: 'WORK_SESSION_BUSY' });
      const latest = await transaction.agentStateLog.findFirst({
        where: { tenantId: actor.tenantId, userId: actor.userId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        select: { state: true },
      });
      if (latest?.state !== 'AVAILABLE')
        await transaction.agentStateLog.create({
          data: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            state: 'AVAILABLE',
            actorUserId: actor.userId,
            reason: 'agent_self_available',
          },
        });
      return { state: 'AVAILABLE' as const };
    });
  }

  @Post('interactions/:interactionId/wrapup')
  @GatewayRoles('agent')
  async submitWrapup(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
    @Body() body: { disposition?: unknown; commandId?: unknown },
  ) {
    const actor = identity(request);
    const input = wrapupBody(body);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const resourceId = requiredUuid(interactionId, 'interactionId');
      const receipt = await transaction.commandReceipt.findUnique({
        where: { tenantId_commandId: { tenantId: actor.tenantId, commandId: input.commandId } },
        select: { actorUserId: true, action: true, resourceId: true, result: true },
      });
      if (receipt) {
        if (
          receipt.actorUserId !== actor.userId ||
          receipt.action !== 'AGENT_WRAPUP_SUBMIT' ||
          receipt.resourceId !== resourceId
        ) {
          throw new BadRequestException('commandId was already used for another command');
        }
        return receipt.result;
      }
      const interaction = await transaction.interaction.findFirst({
        where: { id: resourceId, tenantId: actor.tenantId, agentId: actor.userId, state: 'WRAPUP' },
        select: { id: true, voiceWrapupPolicy: true },
      });
      if (!interaction) throw new NotFoundException();
      if (interaction.voiceWrapupPolicy === 'VOICE_NOTE_V1') {
        throw new ConflictException({ code: 'WRAPUP_V1_REQUIRED' });
      }
      await transaction.interaction.updateMany({
        where: {
          id: interaction.id,
          tenantId: actor.tenantId,
          agentId: actor.userId,
          state: 'WRAPUP',
        },
        data: { state: 'COMPLETED', wrapUpCode: input.disposition },
      });
      await transaction.interactionEvent.create({
        data: {
          tenantId: actor.tenantId,
          interactionId: interaction.id,
          type: 'interaction.wrapup_completed',
          payload: { disposition: input.disposition, commandId: input.commandId },
        },
      });
      await transaction.agentStateLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          state: 'AVAILABLE',
          reason: 'wrapup_completed',
        },
      });
      const result = {
        interactionId: interaction.id,
        state: 'COMPLETED',
        disposition: input.disposition,
      };
      await transaction.commandReceipt.create({
        data: {
          tenantId: actor.tenantId,
          commandId: input.commandId,
          actorUserId: actor.userId,
          action: 'AGENT_WRAPUP_SUBMIT',
          resourceId: interaction.id,
          result,
        },
      });
      return result;
    });
  }

  @Post('interactions/:interactionId/wrapup-v1')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @GatewayRoles('agent')
  async submitWrapupV1(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
    @Body() body: unknown,
  ) {
    return wrapupOperation(request, () =>
      saveAgentWrapup(this.database, identity(request), interactionId, body),
    );
  }

  @Get('interactions/:interactionId/wrapup-result')
  @Header('Cache-Control', 'no-store')
  @GatewayRoles('agent')
  async wrapupResult(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    return wrapupOperation(request, () =>
      readAgentWrapup(this.database, identity(request), interactionId),
    );
  }

  @Get('interactions/:interactionId/wrapup-commands/:commandId')
  @Header('Cache-Control', 'no-store')
  @GatewayRoles('agent')
  async wrapupCommand(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
    @Param('commandId') commandId: string,
  ) {
    return wrapupOperation(request, () =>
      readAgentWrapupCommand(this.database, identity(request), interactionId, commandId),
    );
  }

  @Get('sip-credentials')
  @GatewayRoles('agent')
  async sipCredentials(
    @Req() request: AuthenticatedGatewayRequest,
    @Headers('x-work-session-lease-id') workSessionLeaseId: string | undefined,
  ) {
    const actor = identity(request);
    return this.sipCredentialsService.issue({
      tenantId: actor.tenantId,
      userId: actor.userId,
      workSessionLeaseId: requiredUuid(workSessionLeaseId ?? '', 'x-work-session-lease-id'),
    });
  }
}
