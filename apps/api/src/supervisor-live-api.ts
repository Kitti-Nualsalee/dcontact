import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const SUPERVISOR_LIVE_DATABASE = Symbol('SUPERVISOR_LIVE_DATABASE');

type ForceableAgentState = 'OFFLINE' | 'AVAILABLE' | 'BREAK';

interface ForceAgentStateBody {
  state?: unknown;
  reason?: unknown;
  commandId?: unknown;
}

interface SetQueueAvailabilityBody {
  isActive?: unknown;
  reason?: unknown;
  commandId?: unknown;
}

interface SupervisorScope {
  kind: 'ADMIN' | 'TEAM';
  teamId?: string;
}

export interface SupervisorLiveEvent {
  type: 'workspace.live';
  tenantId: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export class SupervisorLiveEventStream {
  private readonly sequenceByTenant = new Map<string, number>();
  private readonly subscribers = new Set<
    (event: SupervisorLiveEvent, recipientUserIds: readonly string[]) => void | Promise<void>
  >();

  sequence(tenantId: string): number {
    return this.sequenceByTenant.get(tenantId) ?? 0;
  }

  subscribe(
    subscriber: (
      event: SupervisorLiveEvent,
      recipientUserIds: readonly string[],
    ) => void | Promise<void>,
  ): void {
    this.subscribers.add(subscriber);
  }

  publish(
    tenantId: string,
    payload: Record<string, unknown>,
    recipientUserIds: readonly string[],
  ): SupervisorLiveEvent {
    const event: SupervisorLiveEvent = {
      type: 'workspace.live',
      tenantId,
      sequence: this.sequence(tenantId) + 1,
      payload,
    };
    this.sequenceByTenant.set(tenantId, event.sequence);
    for (const subscriber of this.subscribers) void subscriber(event, recipientUserIds);
    return event;
  }
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

function forceableState(value: unknown): ForceableAgentState {
  if (value === 'OFFLINE' || value === 'AVAILABLE' || value === 'BREAK') return value;
  throw new BadRequestException('state must be OFFLINE, AVAILABLE or BREAK');
}

function queueAvailability(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException('isActive must be a boolean');
  return value;
}

function requiredCommandId(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('commandId must be a UUID');
  return requiredIdentifier(value, 'commandId');
}

@Controller('api/v1/workspace/supervisor')
export class SupervisorLiveController {
  constructor(
    @Inject(SUPERVISOR_LIVE_DATABASE) private readonly database: PrismaClient,
    @Inject(SupervisorLiveEventStream) private readonly events: SupervisorLiveEventStream,
  ) {}

  @Get('snapshot')
  @GatewayRoles('supervisor', 'admin')
  async snapshot(@Req() request: AuthenticatedGatewayRequest) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const scope = await this.resolveScope(transaction, actor.tenantId, actor.userId, actor.roles);
      return this.snapshotFor(transaction, actor.tenantId, scope);
    });
  }

  @Put('agents/:agentId/state')
  @GatewayRoles('supervisor', 'admin')
  async forceAgentState(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('agentId') agentId: string,
    @Body() body: ForceAgentStateBody,
  ) {
    const actor = identity(request);
    const state = forceableState(body.state);
    const reason = requiredReason(body.reason);
    const changed = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const scope = await this.resolveScope(
          transaction,
          actor.tenantId,
          actor.userId,
          actor.roles,
        );
        const target = await transaction.user.findFirst({
          where: {
            id: requiredIdentifier(agentId, 'agentId'),
            tenantId: actor.tenantId,
            role: 'AGENT',
          },
          select: { id: true, teamId: true },
        });
        if (!target) throw new NotFoundException();
        this.assertInScope(scope, target.teamId);
        const receiptCommandId = requiredCommandId(body.commandId);
        const existingReceipt = await transaction.commandReceipt.findUnique({
          where: { tenantId_commandId: { tenantId: actor.tenantId, commandId: receiptCommandId } },
          select: { actorUserId: true, action: true, resourceId: true, result: true },
        });
        if (existingReceipt) {
          if (
            existingReceipt.actorUserId !== actor.userId ||
            existingReceipt.action !== 'SUPERVISOR_FORCE_AGENT_STATE' ||
            existingReceipt.resourceId !== target.id
          ) {
            throw new BadRequestException('commandId was already used for another command');
          }
          return {
            result: existingReceipt.result as {
              agentId: string;
              state: ForceableAgentState;
              reason: string;
            },
            recipients: [],
          };
        }
        const unsafeInteraction = await transaction.interaction.findFirst({
          where: {
            tenantId: actor.tenantId,
            agentId: target.id,
            state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
          },
          select: { id: true },
        });
        if (unsafeInteraction) {
          throw new ConflictException(
            'agent has an active Interaction; force-safe boundary rejected',
          );
        }
        await transaction.agentStateLog.create({
          data: {
            tenantId: actor.tenantId,
            userId: target.id,
            state,
            reason,
            actorUserId: actor.userId,
          },
        });
        const result = { agentId: target.id, state, reason };
        await transaction.commandReceipt.create({
          data: {
            tenantId: actor.tenantId,
            commandId: receiptCommandId,
            actorUserId: actor.userId,
            action: 'SUPERVISOR_FORCE_AGENT_STATE',
            resourceId: target.id,
            result,
          },
        });
        return {
          result,
          recipients: await this.recipients(transaction, actor.tenantId, target.teamId),
        };
      },
    );
    if (changed.recipients.length > 0) {
      this.events.publish(
        actor.tenantId,
        { event: 'agent.state_changed', agentId: changed.result.agentId, state, reason },
        changed.recipients,
      );
    }
    return changed.result;
  }

  @Put('queues/:queueId/availability')
  @GatewayRoles('supervisor', 'admin')
  async setQueueAvailability(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('queueId') queueId: string,
    @Body() body: SetQueueAvailabilityBody,
  ) {
    const actor = identity(request);
    const isActive = queueAvailability(body.isActive);
    const reason = requiredReason(body.reason);
    const changed = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (transaction) => {
        const scope = await this.resolveScope(
          transaction,
          actor.tenantId,
          actor.userId,
          actor.roles,
        );
        const queue = await transaction.queue.findFirst({
          where: { id: requiredIdentifier(queueId, 'queueId'), tenantId: actor.tenantId },
          select: { id: true, teamId: true, isActive: true },
        });
        if (!queue) throw new NotFoundException();
        this.assertInScope(scope, queue.teamId);
        const receiptCommandId = requiredCommandId(body.commandId);
        const existingReceipt = await transaction.commandReceipt.findUnique({
          where: { tenantId_commandId: { tenantId: actor.tenantId, commandId: receiptCommandId } },
          select: { actorUserId: true, action: true, resourceId: true, result: true },
        });
        if (existingReceipt) {
          if (
            existingReceipt.actorUserId !== actor.userId ||
            existingReceipt.action !== 'SUPERVISOR_QUEUE_AVAILABILITY' ||
            existingReceipt.resourceId !== queue.id
          ) {
            throw new BadRequestException('commandId was already used for another command');
          }
          return {
            result: existingReceipt.result as { id: string; isActive: boolean },
            recipients: [],
          };
        }
        await transaction.queue.update({ where: { id: queue.id }, data: { isActive } });
        await transaction.queueAuditEvent.create({
          data: {
            tenantId: actor.tenantId,
            queueId: queue.id,
            actorUserId: actor.userId,
            action: isActive ? 'QUEUE_ENABLED' : 'QUEUE_DISABLED',
            details: {
              reason,
              commandId: receiptCommandId,
              before: { isActive: queue.isActive },
              after: { isActive },
            },
          },
        });
        const result = { id: queue.id, isActive };
        await transaction.commandReceipt.create({
          data: {
            tenantId: actor.tenantId,
            commandId: receiptCommandId,
            actorUserId: actor.userId,
            action: 'SUPERVISOR_QUEUE_AVAILABILITY',
            resourceId: queue.id,
            result,
          },
        });
        return {
          result,
          recipients: await this.recipients(transaction, actor.tenantId, queue.teamId),
        };
      },
    );
    if (changed.recipients.length > 0) {
      this.events.publish(
        actor.tenantId,
        { event: 'queue.availability_changed', queueId: changed.result.id, isActive, reason },
        changed.recipients,
      );
    }
    return changed.result;
  }

  private async snapshotFor(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    scope: SupervisorScope,
  ) {
    const agentWhere = {
      tenantId,
      role: 'AGENT' as const,
      ...(scope.kind === 'TEAM' ? { teamId: scope.teamId } : {}),
    };
    const queueWhere = { tenantId, ...(scope.kind === 'TEAM' ? { teamId: scope.teamId } : {}) };
    const [agents, queues] = await Promise.all([
      transaction.user.findMany({
        where: agentWhere,
        select: {
          id: true,
          displayName: true,
          extension: true,
          teamId: true,
          stateLogs: {
            select: { state: true },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
        orderBy: { id: 'asc' },
      }),
      transaction.queue.findMany({
        where: queueWhere,
        select: { id: true, name: true, teamId: true, isActive: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    const agentIds = agents.map((agent) => agent.id);
    const queueIds = queues.map((queue) => queue.id);
    const [interactions, agentAudits, queueAudits] = await Promise.all([
      transaction.interaction.findMany({
        where: {
          tenantId,
          state: { in: ['QUEUED', 'ASSIGNED', 'ACTIVE', 'WRAPUP'] },
          OR: [{ agentId: { in: agentIds } }, { queueId: { in: queueIds } }],
        },
        select: { id: true, state: true },
        orderBy: { id: 'asc' },
      }),
      transaction.agentStateLog.findMany({
        where: { tenantId, userId: { in: agentIds }, actorUserId: { not: null } },
        select: { userId: true, state: true, reason: true, actorUserId: true, startedAt: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      }),
      transaction.queueAuditEvent.findMany({
        where: { tenantId, queueId: { in: queueIds } },
        select: { action: true, createdAt: true, details: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      sequence: this.events.sequence(tenantId),
      agents: agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        extension: agent.extension,
        teamId: agent.teamId,
        state: agent.stateLogs[0]?.state ?? 'OFFLINE',
      })),
      queues,
      interactions,
      audit: [
        ...agentAudits.map((audit) => ({
          action: 'AGENT_STATE_FORCED',
          userId: audit.userId,
          state: audit.state,
          reason: audit.reason ?? undefined,
          actorUserId: audit.actorUserId,
          occurredAt: audit.startedAt,
        })),
        ...queueAudits.map((audit) => ({
          action: audit.action,
          occurredAt: audit.createdAt,
          ...(this.queueAuditReason(audit.details)
            ? { reason: this.queueAuditReason(audit.details) }
            : {}),
        })),
      ],
    };
  }

  private async resolveScope(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    roles: readonly string[],
  ): Promise<SupervisorScope> {
    if (roles.includes('admin')) return { kind: 'ADMIN' };
    if (!roles.includes('supervisor')) throw new ForbiddenException();
    const supervisor = await transaction.user.findFirst({
      where: { id: userId, tenantId, role: 'SUPERVISOR' },
      select: { teamId: true },
    });
    if (!supervisor?.teamId) throw new ForbiddenException('supervisor must belong to a team');
    return { kind: 'TEAM', teamId: supervisor.teamId };
  }

  private assertInScope(scope: SupervisorScope, teamId: string | null): void {
    if (scope.kind === 'TEAM' && scope.teamId !== teamId) throw new ForbiddenException();
  }

  private async recipients(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    teamId: string | null,
  ): Promise<string[]> {
    const users = await transaction.user.findMany({
      where: {
        tenantId,
        OR: [{ role: 'ADMIN' }, { role: 'SUPERVISOR', teamId }],
      },
      select: { id: true },
    });
    return users.map((user) => user.id);
  }

  private queueAuditReason(details: unknown): string | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
    const reason = (details as Record<string, unknown>).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
}
