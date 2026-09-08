import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const AGENT_WORKSPACE_DATABASE = Symbol('AGENT_WORKSPACE_DATABASE');
export const AGENT_SIP_LEASE_PROVIDER = Symbol('AGENT_SIP_LEASE_PROVIDER');

export interface AgentSipLeaseRequest {
  tenantId: string;
  userId: string;
  extension: string;
  authorizationPassword: string;
  sipDomain: string;
}

export interface AgentSipCredentialLease {
  leaseId: string;
  extension: string;
  authorizationUsername: string;
  authorizationPassword: string;
  sipDomain: string;
  wssUrl: string;
  telephonyNodeId: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  expiresAt: string;
}

export interface AgentSipLeaseProvider {
  issue(input: AgentSipLeaseRequest): Promise<AgentSipCredentialLease>;
}

interface BrowserTelephonyNode {
  telephonyNodeId: string;
  wssUrl: string;
}

export class ConfiguredAgentSipLeaseProvider implements AgentSipLeaseProvider {
  private cursor = 0;

  constructor(
    private readonly nodes: readonly BrowserTelephonyNode[],
    private readonly iceServers: AgentSipCredentialLease['iceServers'],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: AgentSipLeaseRequest): Promise<AgentSipCredentialLease> {
    if (this.nodes.length === 0) {
      throw new ServiceUnavailableException('browser telephony nodes are not configured');
    }
    const node = this.nodes[this.cursor % this.nodes.length]!;
    this.cursor += 1;
    return {
      leaseId: randomUUID(),
      extension: input.extension,
      authorizationUsername: input.extension,
      authorizationPassword: input.authorizationPassword,
      sipDomain: input.sipDomain,
      wssUrl: node.wssUrl,
      telephonyNodeId: node.telephonyNodeId,
      iceServers: this.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
      expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(),
    };
  }
}

export function configuredAgentSipLeaseProvider(
  environment: NodeJS.ProcessEnv = process.env,
): ConfiguredAgentSipLeaseProvider {
  const nodes = parseJson<BrowserTelephonyNode[]>(environment.SIP_BROWSER_NODES_JSON, []);
  const iceServers = parseJson<AgentSipCredentialLease['iceServers']>(
    environment.SIP_ICE_SERVERS_JSON,
    [],
  );
  if (
    !nodes.every(
      (node) =>
        typeof node.telephonyNodeId === 'string' &&
        node.telephonyNodeId.length > 0 &&
        typeof node.wssUrl === 'string' &&
        isBrowserSipWebSocketUrl(node.wssUrl),
    )
  ) {
    throw new Error(
      'SIP_BROWSER_NODES_JSON requires telephonyNodeId and a wss:// endpoint or localhost ws:// endpoint',
    );
  }
  return new ConfiguredAgentSipLeaseProvider(nodes, iceServers);
}

function isBrowserSipWebSocketUrl(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol === 'wss:') return true;
    return (
      endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
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
    @Inject(AGENT_SIP_LEASE_PROVIDER) private readonly sipLeases: AgentSipLeaseProvider,
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
  async sipCredentials(@Req() request: AuthenticatedGatewayRequest) {
    const actor = identity(request);
    const credential = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const agent = await transaction.user.findFirst({
          where: {
            id: actor.userId,
            tenantId: actor.tenantId,
            role: 'AGENT',
            isActive: true,
          },
          select: {
            id: true,
            extension: true,
            sipPassword: true,
            tenant: { select: { sipDomain: true } },
          },
        });
        if (!agent?.extension || !agent.sipPassword) throw new NotFoundException();
        return {
          tenantId: actor.tenantId,
          userId: agent.id,
          extension: agent.extension,
          authorizationPassword: agent.sipPassword,
          sipDomain: agent.tenant.sipDomain,
        };
      },
    );
    return this.sipLeases.issue(credential);
  }
}
