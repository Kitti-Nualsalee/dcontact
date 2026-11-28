/**
 * #956 — the HTTP of the cases an Agent handles in the team (`/api/v1/workspace/agent/cases`)
 *
 * all `cs_*` writes go through `AgentCases` of `@d-contact/cases`; this file turns HTTP into commands,
 * maps errors to a status and fills in person and customer names for display
 * a customer name is shown only when the viewer's team still has WORK or VIEW permission on that customer in Customer 360
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
import { type Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  AgentCaseError,
  AgentCases,
  type AgentCaseActor,
  type AgentCaseStatusFilter,
} from '@d-contact/cases';
import { C360WorkError, authorizeC360WorkContact } from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const AGENT_CASES_DATABASE = Symbol('AGENT_CASES_DATABASE');
const logger = new Logger('AgentCases');

/** logs only the kind and code of the error, never the body or a message that may contain customer data */
function errorSummary(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return { name: error instanceof Error ? error.name : typeof error, ...(code ? { code } : {}) };
}
export const AGENT_CASES_CUSTOMER_ACCESS = Symbol('AGENT_CASES_CUSTOMER_ACCESS');

/** answers whether the viewer's team can see this customer right now, without throwing (cannot check = cannot see) */
export type CaseCustomerAccess = (
  transaction: Prisma.TransactionClient,
  actor: { tenantId: string; userId: string; role: 'AGENT'; teamId: string },
  contactId: string,
) => Promise<boolean>;

export interface CaseCustomer {
  displayName: string | null;
  company: string | null;
}

function actorOf(request: AuthenticatedGatewayRequest): AgentCaseActor {
  const identity = request.gatewayIdentity;
  if (!identity) throw new ForbiddenException();
  return { tenantId: identity.tenantId, userId: identity.userId };
}

/** maps a Cases error to HTTP with a code and correlationId so the client can decide */
export function caseHttpError(error: unknown, correlationId?: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AgentCaseError) {
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
  logger.error({ event: 'case_request_failed', correlationId, ...errorSummary(error) });
  return new InternalServerErrorException({
    code: 'CASE_REQUEST_FAILED',
    ...(correlationId ? { correlationId } : {}),
  });
}

@Controller('api/v1/workspace/agent/cases')
export class AgentCasesController {
  private readonly cases: AgentCases;

  private readonly customerAccess: CaseCustomerAccess;

  constructor(
    @Inject(AGENT_CASES_DATABASE) private readonly database: PrismaClient,
    @Optional() @Inject(AGENT_CASES_CUSTOMER_ACCESS) customerAccess?: CaseCustomerAccess,
  ) {
    this.cases = new AgentCases(database);
    this.customerAccess = customerAccess ?? customer360Access;
  }

  @Get()
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('status') status: unknown,
    @Query('mine') mine: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    return this.run(request, async (actor) => {
      const page = await this.cases.list(actor, {
        ...(status !== undefined ? { status: status as AgentCaseStatusFilter } : {}),
        assignedToMe: mine === '1' || mine === 'true',
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(typeof cursor === 'string' ? { cursor } : {}),
      });
      const [people, teamName, customers] = await Promise.all([
        this.people(
          actor,
          page.items.flatMap((item) => (item.assigneeUserId ? [item.assigneeUserId] : [])),
        ),
        this.teamName(actor),
        this.customers(
          actor,
          page.items.map((item) => item.contactId),
          request.correlationId,
        ),
      ]);
      return {
        items: page.items.map((item) => ({
          ...item,
          ...(customers.has(item.contactId)
            ? { contactDisplayName: customers.get(item.contactId)!.displayName }
            : {}),
        })),
        nextCursor: page.nextCursor,
        people,
        teamName,
      };
    });
  }

  @Get('team-agents')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async teamAgents(@Req() request: AuthenticatedGatewayRequest) {
    return this.run(request, async (actor) => ({ items: await this.cases.teamAgents(actor) }));
  }

  @Get(':caseId')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async detail(@Req() request: AuthenticatedGatewayRequest, @Param('caseId') caseId: string) {
    return this.run(request, async (actor) => {
      const detail = await this.cases.detail(actor, caseId);
      const ids = new Set<string>();
      if (detail.createdByUserId) ids.add(detail.createdByUserId);
      if (detail.assigneeUserId) ids.add(detail.assigneeUserId);
      for (const activity of detail.activities) {
        if (activity.actorUserId) ids.add(activity.actorUserId);
        if (activity.assigneeUserId) ids.add(activity.assigneeUserId);
      }
      const [people, teamName, customers] = await Promise.all([
        this.people(actor, [...ids]),
        this.teamName(actor),
        this.customers(actor, [detail.contactId], request.correlationId),
      ]);
      const customer = customers.get(detail.contactId) ?? null;
      return {
        case: {
          ...detail,
          ...(customer ? { contactDisplayName: customer.displayName } : {}),
        },
        people,
        teamName,
        customer,
      };
    });
  }

  @Post()
  @HttpCode(201)
  @GatewayRoles('agent')
  async open(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    return this.run(request, (actor) => this.cases.open(actor, record(body)));
  }

  @Post(':caseId/notes')
  @HttpCode(200)
  @GatewayRoles('agent')
  async addNote(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ) {
    return this.run(request, (actor) => this.cases.addNote(actor, caseId, record(body)));
  }

  @Post(':caseId/assignment')
  @HttpCode(200)
  @GatewayRoles('agent')
  async assign(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ) {
    return this.run(request, (actor) => this.cases.assign(actor, caseId, record(body)));
  }

  @Post(':caseId/status')
  @HttpCode(200)
  @GatewayRoles('agent')
  async changeStatus(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ) {
    return this.run(request, (actor) => this.cases.changeStatus(actor, caseId, record(body)));
  }

  private async run<T>(
    request: AuthenticatedGatewayRequest,
    work: (actor: AgentCaseActor) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(actorOf(request));
    } catch (error) {
      throw caseHttpError(error, request.correlationId);
    }
  }

  /** the names of people appearing in the list or timeline, including those who moved team or whose account is closed (in the same tenant) */
  private async people(actor: AgentCaseActor, ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const rows = await withTenantDatabaseTransaction(this.database, actor.tenantId, (transaction) =>
      transaction.user.findMany({
        where: { tenantId: actor.tenantId, id: { in: [...new Set(ids)] } },
        select: { id: true, displayName: true },
      }),
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.displayName]));
  }

  private async teamName(actor: AgentCaseActor): Promise<string> {
    const user = await withTenantDatabaseTransaction(this.database, actor.tenantId, (transaction) =>
      transaction.user.findFirst({
        where: { tenantId: actor.tenantId, id: actor.userId },
        select: { team: { select: { name: true } } },
      }),
    );
    return user?.team?.name ?? '';
  }

  /**
   * reads the name and company of a customer only for the ones the viewer's team has WORK or VIEW permission on right now
   * ones without permission or that cannot be checked are not in the Map and the screen shows "no customer data"
   */
  private async customers(
    actor: AgentCaseActor,
    contactIds: string[],
    correlationId?: string,
  ): Promise<Map<string, CaseCustomer>> {
    const result = new Map<string, CaseCustomer>();
    const unique = [...new Set(contactIds)];
    if (unique.length === 0) return result;
    try {
      await this.readCustomers(actor, unique, result);
    } catch (error) {
      // failing to load the customers does not stop the case from opening, the screen shows no customer data instead (fail closed)
      logger.warn({ event: 'case_customer_unavailable', correlationId, ...errorSummary(error) });
      return new Map();
    }
    return result;
  }

  private async readCustomers(
    actor: AgentCaseActor,
    unique: string[],
    result: Map<string, CaseCustomer>,
  ): Promise<void> {
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
      for (const contactId of unique) {
        if (!(await this.customerAccess(transaction, workActor, contactId))) continue;
        const contact = await transaction.contact.findFirst({
          where: { tenantId: actor.tenantId, id: contactId },
          select: { displayName: true, company: true },
        });
        if (contact) result.set(contactId, contact);
      }
    });
  }
}

/** the default: uses the same Customer 360 WORK/VIEW rules as the customer panel in the Workspace */
export const customer360Access: CaseCustomerAccess = async (transaction, actor, contactId) => {
  for (const permission of ['WORK', 'VIEW'] as const) {
    try {
      await authorizeC360WorkContact(transaction, actor, contactId, permission);
      return true;
    } catch (error) {
      // no permission at this level or the scope has not caught up, try the next level; a DB error makes the transaction
      // unusable, so it is rethrown for customers() to answer with no customer data for the whole set
      if (!(error instanceof C360WorkError)) throw error;
    }
  }
  return false;
};

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentCaseError('INVALID_INPUT', 'body');
  }
  return body as Record<string, unknown>;
}
