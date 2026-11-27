/**
 * #1061 — the HTTP of agent-scheduled callbacks (`/api/v1/workspace/agent/callbacks`)
 *
 * All `ob_callbacks` writes go through `AgentCallbacks` of `@d-contact/dialer`; this file turns HTTP into commands
 * and maps errors to a status. The customer's name and number are shown only while the viewer's team still has
 * WORK or VIEW permission on that customer in Customer 360 (the same rule as cases); dialing never needs them.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  AgentCallbackError,
  AgentCallbacks,
  type AgentCallbackActor,
  type AgentCallbackView,
} from '@d-contact/dialer';
import { customer360Access, type CaseCustomerAccess } from './agent-cases-api.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const AGENT_CALLBACKS = Symbol('AGENT_CALLBACKS');
export const AGENT_CALLBACKS_DATABASE = Symbol('AGENT_CALLBACKS_DATABASE');
export const AGENT_CALLBACKS_CUSTOMER_ACCESS = Symbol('AGENT_CALLBACKS_CUSTOMER_ACCESS');
const logger = new Logger('AgentCallbacks');

function errorSummary(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return { name: error instanceof Error ? error.name : typeof error, ...(code ? { code } : {}) };
}

function actorOf(request: AuthenticatedGatewayRequest): AgentCallbackActor {
  const identity = request.gatewayIdentity;
  if (!identity) throw new ForbiddenException();
  return { tenantId: identity.tenantId, userId: identity.userId };
}

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new AgentCallbackError('INVALID_INPUT', 'body');
  return body as Record<string, unknown>;
}

/** maps a Dialer error to HTTP with a code and correlationId so the client can decide */
export function callbackHttpError(error: unknown, correlationId?: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AgentCallbackError) {
    const body = {
      code: error.code,
      ...(error.field ? { field: error.field } : {}),
      ...(correlationId ? { correlationId } : {}),
    };
    switch (error.kind) {
      case 'FORBIDDEN':
        return new ForbiddenException(body);
      case 'INVALID':
        return new BadRequestException(body);
      case 'NOT_FOUND':
        return new NotFoundException(body);
      case 'CONFLICT':
        return new ConflictException(body);
    }
  }
  logger.error({ event: 'callback_request_failed', correlationId, ...errorSummary(error) });
  return new InternalServerErrorException({
    code: 'CALLBACK_REQUEST_FAILED',
    ...(correlationId ? { correlationId } : {}),
  });
}

export type AgentCallbackListItem = Omit<AgentCallbackView, 'contactName' | 'number'> & {
  /** null when the team may no longer see this customer */
  contactName: string | null;
  number: string | null;
  customerVisible: boolean;
};

@Controller('api/v1/workspace/agent/callbacks')
export class AgentCallbacksController {
  private readonly customerAccess: CaseCustomerAccess;

  constructor(
    @Inject(AGENT_CALLBACKS) private readonly callbacks: AgentCallbacks,
    @Inject(AGENT_CALLBACKS_DATABASE) private readonly database: PrismaClient,
    @Optional() @Inject(AGENT_CALLBACKS_CUSTOMER_ACCESS) customerAccess?: CaseCustomerAccess,
  ) {
    this.customerAccess = customerAccess ?? customer360Access;
  }

  @Get()
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: AuthenticatedGatewayRequest) {
    return this.run(request, async (actor) => {
      const page = await this.callbacks.list(actor);
      const visible = await this.visibleCustomers(
        actor,
        page.items.map((item) => item.contactId),
        request.correlationId,
      );
      const items: AgentCallbackListItem[] = page.items.map((item) => {
        const customerVisible = visible.has(item.contactId);
        return {
          ...item,
          contactName: customerVisible ? item.contactName : null,
          number: customerVisible ? item.number : null,
          customerVisible,
        };
      });
      return { items, serverTime: page.serverTime };
    });
  }

  /** what the schedule dialog shows for the work the Agent holds */
  @Get('options')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async options(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('interactionId') interactionId: unknown,
  ) {
    return this.run(request, (actor) => this.callbacks.options(actor, interactionId));
  }

  @Post()
  @HttpCode(201)
  @GatewayRoles('agent')
  async schedule(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    return this.run(request, (actor) => this.callbacks.schedule(actor, record(body)));
  }

  @Post(':callbackId/reschedule')
  @HttpCode(200)
  @GatewayRoles('agent')
  async reschedule(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('callbackId') callbackId: string,
    @Body() body: unknown,
  ) {
    return this.run(request, (actor) => this.callbacks.reschedule(actor, callbackId, record(body)));
  }

  @Post(':callbackId/cancel')
  @HttpCode(200)
  @GatewayRoles('agent')
  async cancel(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('callbackId') callbackId: string,
    @Body() body: unknown,
  ) {
    return this.run(request, (actor) => this.callbacks.cancel(actor, callbackId, record(body)));
  }

  private async run<T>(
    request: AuthenticatedGatewayRequest,
    work: (actor: AgentCallbackActor) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(actorOf(request));
    } catch (error) {
      throw callbackHttpError(error, request.correlationId);
    }
  }

  /** customers the viewer's team may see now; failing to check hides them all (fail closed) */
  private async visibleCustomers(
    actor: AgentCallbackActor,
    contactIds: string[],
    correlationId?: string,
  ): Promise<Set<string>> {
    const visible = new Set<string>();
    const unique = [...new Set(contactIds)];
    if (unique.length === 0) return visible;
    try {
      await withTenantDatabaseTransaction(this.database, actor.tenantId, async (transaction) => {
        const user = await transaction.user.findFirst({
          where: { tenantId: actor.tenantId, id: actor.userId, role: 'AGENT', isActive: true },
          select: { teamId: true },
        });
        if (!user?.teamId) return;
        const workActor = {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: 'AGENT' as const,
          teamId: user.teamId,
        };
        for (const contactId of unique)
          if (await this.customerAccess(transaction, workActor, contactId)) visible.add(contactId);
      });
    } catch (error) {
      logger.warn({
        event: 'callback_customer_unavailable',
        correlationId,
        ...errorSummary(error),
      });
      return new Set();
    }
    return visible;
  }
}

/** the background round: every active tenant, one tenant failing does not stop the others */
export async function maintainAgentCallbacks(
  database: PrismaClient,
  callbacks: AgentCallbacks,
): Promise<void> {
  const tenants = await database.tenant.findMany({
    where: { lifecycleStatus: 'ACTIVE' },
    select: { id: true },
  });
  for (const { id } of tenants) {
    try {
      const result = await callbacks.maintain(id);
      if (result.expired || result.escalated || result.connected || result.notConnected)
        logger.log({ event: 'agent_callbacks.maintained', tenantId: id, ...result });
    } catch (error) {
      logger.warn({
        event: 'agent_callbacks.maintain_failed',
        tenantId: id,
        ...errorSummary(error),
      });
    }
  }
}
