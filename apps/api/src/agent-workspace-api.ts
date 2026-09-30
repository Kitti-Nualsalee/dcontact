import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { AGENT_SIP_CREDENTIALS, type AgentSipCredentialService } from './agent-sip-credentials.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const AGENT_WORKSPACE_DATABASE = Symbol('AGENT_WORKSPACE_DATABASE');

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

function wrapupBody(value: { disposition?: unknown; commandId?: unknown }) {
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
        select: { id: true },
      });
      if (!interaction) throw new NotFoundException();
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
