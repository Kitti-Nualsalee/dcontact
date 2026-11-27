import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  Put,
  UnprocessableEntityException,
  Headers,
  Header,
  HttpException,
  InternalServerErrorException,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { syncAgentWebchatState } from '@d-contact/router';
import { AGENT_SIP_CREDENTIALS, type AgentSipCredentialService } from './agent-sip-credentials.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { EmbedOriginService } from './embed-origins.js';
import { saveAgentWrapup, readAgentWrapup, readAgentWrapupCommand } from './agent-wrapup-v1.js';
import {
  readAgentHistory,
  readAgentHistorySummary,
  readAgentHistoryTranscript,
} from './agent-history.js';
import {
  activeNotReadyReasons,
  isActiveNotReadyReason,
  parseAfterWork,
  parseAgentSelfState,
  recordPostWrapupState,
  stateChangedBy,
} from './agent-not-ready.js';

export const AGENT_WORKSPACE_DATABASE = Symbol('AGENT_WORKSPACE_DATABASE');
export const AGENT_WORKSPACE_CUSTOMER_AVAILABLE = Symbol('AGENT_WORKSPACE_CUSTOMER_AVAILABLE');
export const AGENT_WORKSPACE_WEBCHAT = Symbol('AGENT_WORKSPACE_WEBCHAT');

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
    @Optional()
    @Inject(AGENT_WORKSPACE_CUSTOMER_AVAILABLE)
    private readonly customerAvailable = false,
    @Optional()
    @Inject(AGENT_WORKSPACE_WEBCHAT)
    private readonly chatChannels: readonly string[] = [],
  ) {}

  @Get('history')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async history(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('disposition') disposition: unknown,
    @Query('channel') channel: unknown,
  ) {
    return wrapupOperation(request, () =>
      readAgentHistory(this.database, identity(request), {
        limit,
        cursor,
        from,
        to,
        disposition,
        channel,
      }),
    );
  }

  /** #1044 the messages of one of the Agent's own finished chats */
  @Get('history/:interactionId/transcript')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async historyTranscript(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    return wrapupOperation(request, () =>
      readAgentHistoryTranscript(this.database, identity(request), interactionId),
    );
  }

  @Get('history/summary')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async historySummary(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('period') period: unknown,
    @Query('channel') channel: unknown,
  ) {
    return wrapupOperation(request, async () => ({
      ...(await readAgentHistorySummary(
        this.database,
        identity(request),
        period,
        undefined,
        channel,
      )),
      // #1044 which channels this deployment has; the page shows channel filters only when there are two
      channels: ['VOICE', ...this.chatChannels],
    }));
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
            select: {
              state: true,
              startedAt: true,
              reasonCode: true,
              reason: true,
              actorUserId: true,
            },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      });
      if (!agent) throw new NotFoundException();
      const latestState = agent.stateLogs[0];
      const changedBy = stateChangedBy(latestState, actor.userId);
      const supervisor =
        changedBy === 'SUPERVISOR' && latestState?.actorUserId
          ? await transaction.user.findFirst({
              where: { id: latestState.actorUserId, tenantId: actor.tenantId },
              select: { displayName: true },
            })
          : null;
      const afterWork = await transaction.agentAfterWorkState.findUnique({
        where: { tenantId_userId: { tenantId: actor.tenantId, userId: actor.userId } },
        select: { reasonCode: true },
      });

      const interaction = await transaction.interaction.findFirst({
        where: {
          tenantId: actor.tenantId,
          agentId: actor.userId,
          // #1044 chats are listed by the web chat API; this is the single call in hand
          channel: 'VOICE',
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
        capabilities: {
          voiceWrapupV1: 1,
          // #938 the server supports Not Ready + reason, Offline and the after-work state (#937) — the Workspace opens the state picker
          agentStatusV1: 1,
          ...(this.customerAvailable ? { workCustomerV1: 1 } : {}),
          // #1044 the deployment has web chat on — the Workspace lists and answers chats
          ...(this.chatChannels.length ? { webchatV1: 1 } : {}),
        },
        agent: {
          id: agent.id,
          displayName: agent.displayName,
          extension: agent.extension,
          state: latestState?.state ?? 'OFFLINE',
          // #937 time in the state, the Not Ready reason and who changed it (Supervisor forced = the name and reason entered)
          stateSince: latestState?.startedAt.toISOString() ?? null,
          reasonCode: latestState?.reasonCode ?? null,
          changedBy,
          ...(changedBy === 'SUPERVISOR'
            ? {
                changedByName: supervisor?.displayName ?? null,
                changeNote: latestState?.reason ?? null,
              }
            : {}),
          afterWork: afterWork
            ? { state: 'BREAK' as const, reasonCode: afterWork.reasonCode }
            : { state: 'AVAILABLE' as const },
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
    @Body() body: unknown,
  ) {
    const actor = identity(request);
    const leaseId = requiredUuid(workSessionLeaseId ?? '', 'x-work-session-lease-id');
    // #937: AVAILABLE (original), BREAK + reasonCode (Not Ready) or OFFLINE of the Agent themselves
    const requested = parseAgentSelfState(body);
    if (!requested) throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'state' });
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
      if (requested.state === 'AVAILABLE') {
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
      }
      const busy = await transaction.interaction.groupBy({
        by: ['channel'],
        where: {
          tenantId: actor.tenantId,
          agentId: actor.userId,
          channel: { in: ['VOICE', 'WEBCHAT', 'LINE'] },
          state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
        },
        _count: true,
      });
      const chatsInHand = busy.some((row) => row.channel === 'WEBCHAT' || row.channel === 'LINE');
      // #1044 an Agent who signed in again while still holding chats continues them: the state follows the chats
      if (
        chatsInHand &&
        requested.state === 'AVAILABLE' &&
        !busy.some((row) => row.channel === 'VOICE')
      ) {
        await syncAgentWebchatState(transaction, actor.tenantId, actor.userId, { resume: true });
        const resumed = await transaction.agentStateLog.findFirst({
          where: { tenantId: actor.tenantId, userId: actor.userId },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { state: true },
        });
        if (resumed && ['RESERVED', 'BUSY', 'ACW'].includes(resumed.state))
          return { state: resumed.state };
      }
      // cannot change on their own during work — use the after-work state (PUT after-work) instead
      if (busy.length) throw new ConflictException({ code: 'WORK_SESSION_BUSY' });
      if (
        requested.reasonCode &&
        !(await isActiveNotReadyReason(transaction, actor.tenantId, requested.reasonCode))
      )
        throw new UnprocessableEntityException({ code: 'NOT_READY_REASON_INACTIVE' });
      const latest = await transaction.agentStateLog.findFirst({
        where: { tenantId: actor.tenantId, userId: actor.userId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        select: { state: true, reasonCode: true },
      });
      const reasonCode = requested.reasonCode ?? null;
      if (latest?.state !== requested.state || (latest?.reasonCode ?? null) !== reasonCode)
        await transaction.agentStateLog.create({
          data: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            state: requested.state,
            reasonCode,
            actorUserId: actor.userId,
            reason: {
              AVAILABLE: 'agent_self_available',
              BREAK: 'agent_self_not_ready',
              OFFLINE: 'agent_self_offline',
            }[requested.state],
          },
        });
      return { state: requested.state, ...(reasonCode ? { reasonCode } : {}) };
    });
  }

  /** #937 the Not Ready reasons the Agent can choose now, in the order the Admin set (#936) */
  @Get('not-ready-reasons')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async notReadyReasons(@Req() request: AuthenticatedGatewayRequest) {
    const actor = identity(request);
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => ({
      reasons: await activeNotReadyReasons(transaction, actor.tenantId),
    }));
  }

  /**
   * #937 the after-work state — used when closing work after a call (wrap-up) once; unset = Ready
   * can be set at any time; this value lives on the server so it is not lost on reload
   */
  @Put('after-work')
  @HttpCode(200)
  @GatewayRoles('agent')
  async afterWork(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const actor = identity(request);
    const requested = parseAfterWork(body);
    if (!requested) throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'state' });
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
      const agent = await transaction.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId, role: 'AGENT', isActive: true },
        select: { id: true },
      });
      if (!agent) throw new NotFoundException();
      const key = { tenantId_userId: { tenantId: actor.tenantId, userId: actor.userId } };
      if (requested.state === 'AVAILABLE') {
        await transaction.agentAfterWorkState.deleteMany({
          where: { tenantId: actor.tenantId, userId: actor.userId },
        });
        return { afterWork: { state: 'AVAILABLE' as const } };
      }
      if (!(await isActiveNotReadyReason(transaction, actor.tenantId, requested.reasonCode)))
        throw new UnprocessableEntityException({ code: 'NOT_READY_REASON_INACTIVE' });
      await transaction.agentAfterWorkState.upsert({
        where: key,
        create: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          state: 'BREAK',
          reasonCode: requested.reasonCode,
        },
        update: { reasonCode: requested.reasonCode, updatedAt: new Date() },
      });
      return { afterWork: { state: 'BREAK' as const, reasonCode: requested.reasonCode } };
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
      await recordPostWrapupState(transaction, actor.tenantId, actor.userId);
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
