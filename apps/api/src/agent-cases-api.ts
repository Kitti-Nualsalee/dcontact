/**
 * #956 — HTTP ของเคสที่ Agent ดูแลในทีม (`/api/v1/workspace/agent/cases`)
 *
 * การเขียน `cs_*` ทั้งหมดผ่าน `AgentCases` ของ `@d-contact/cases` ไฟล์นี้แปลง HTTP เป็นคำสั่ง
 * แปลง error เป็น status และเติมชื่อคนกับลูกค้าสำหรับแสดงผล
 * ชื่อลูกค้าแสดงเฉพาะเมื่อทีมของผู้ดูยังมีสิทธิ์ WORK หรือ VIEW บนลูกค้ารายนั้นใน Customer 360
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
import { authorizeC360WorkContact } from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const AGENT_CASES_DATABASE = Symbol('AGENT_CASES_DATABASE');
export const AGENT_CASES_CUSTOMER_ACCESS = Symbol('AGENT_CASES_CUSTOMER_ACCESS');

/** ตอบว่าทีมของผู้ดูเห็นลูกค้ารายนี้ได้ตอนนี้หรือไม่ ไม่โยน error (ตรวจไม่ได้ = ไม่เห็น) */
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

/** แปลง error ของ Cases เป็น HTTP พร้อม code และ correlationId ให้ client ตัดสินใจได้ */
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
      const ids = new Set<string>([detail.createdByUserId]);
      if (detail.assigneeUserId) ids.add(detail.assigneeUserId);
      for (const activity of detail.activities) {
        if (activity.actorUserId) ids.add(activity.actorUserId);
        if (activity.assigneeUserId) ids.add(activity.assigneeUserId);
      }
      const [people, teamName, customers] = await Promise.all([
        this.people(actor, [...ids]),
        this.teamName(actor),
        this.customers(actor, [detail.contactId]),
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

  /** ชื่อของคนที่ปรากฏในรายการหรือไทม์ไลน์ รวมคนที่ย้ายทีมหรือปิดบัญชีแล้ว (อยู่ใน tenant เดียวกัน) */
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
   * อ่านชื่อและบริษัทของลูกค้าเฉพาะรายที่ทีมของผู้ดูมีสิทธิ์ WORK หรือ VIEW ตอนนี้
   * รายที่ไม่มีสิทธิ์หรือตรวจไม่ได้จะไม่อยู่ใน Map แล้วหน้าจอแสดง "ไม่มีข้อมูลลูกค้า"
   */
  private async customers(
    actor: AgentCaseActor,
    contactIds: string[],
  ): Promise<Map<string, CaseCustomer>> {
    const result = new Map<string, CaseCustomer>();
    const unique = [...new Set(contactIds)];
    if (unique.length === 0) return result;
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
    return result;
  }
}

/** ค่าเริ่มต้น: ใช้กฎ WORK/VIEW ของ Customer 360 ชุดเดียวกับแผงลูกค้าใน Workspace */
export const customer360Access: CaseCustomerAccess = async (transaction, actor, contactId) => {
  for (const permission of ['WORK', 'VIEW'] as const) {
    try {
      await authorizeC360WorkContact(transaction, actor, contactId, permission);
      return true;
    } catch {
      // ไม่มีสิทธิ์ระดับนี้ หรือ scope ยังตามไม่ทัน ลองระดับถัดไป
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
