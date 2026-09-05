import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
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

@Controller('api/v1/workspace/agent')
export class AgentWorkspaceController {
  constructor(@Inject(AGENT_WORKSPACE_DATABASE) private readonly database: PrismaClient) {}

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
}
