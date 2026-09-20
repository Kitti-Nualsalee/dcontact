import { Buffer } from 'node:buffer';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  Cg5AlertRepository,
  Cg5AlertVersionConflictError,
  Cg5ProjectionNotReadyError,
  Cg5QueryService,
  type Cg5PageCursor,
  type Cg5QueryScope,
} from '@d-contact/contact-governance';
import type { Cg5Granularity } from '@d-contact/cxa-contracts';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-api.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

const GRANULARITIES = new Set<Cg5Granularity>(['FIVE_MIN', 'HOUR', 'DAY']);
const ALERT_STATES = new Set(['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED']);
const ALERT_SEVERITIES = new Set(['WARNING', 'CRITICAL']);

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function requiredUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ต้องเป็น UUID` });
  }
  return value;
}

function granularity(value: unknown): Cg5Granularity {
  if (typeof value !== 'string' || !GRANULARITIES.has(value as Cg5Granularity)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'granularity ไม่ถูกต้อง' });
  }
  return value as Cg5Granularity;
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} ต้องเป็น ISO date`,
    });
  }
  return date;
}

function limit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 50;
  const number = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'limit ต้องอยู่ระหว่าง 1-100',
    });
  }
  return number;
}

function decodeCursor(value: unknown): Cg5PageCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('invalid');
    const candidate = decoded as { occurredAt?: unknown; id?: unknown };
    if (typeof candidate.occurredAt !== 'string' || typeof candidate.id !== 'string')
      throw new Error('invalid');
    const occurredAt = new Date(candidate.occurredAt);
    if (Number.isNaN(occurredAt.valueOf()) || !/^[0-9a-f-]{36}$/i.test(candidate.id)) {
      throw new Error('invalid');
    }
    return { occurredAt, id: candidate.id };
  } catch {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'cursor ไม่ถูกต้อง' });
  }
}

function encodeCursor(cursor: Cg5PageCursor | null): string | null {
  return cursor
    ? Buffer.from(
        JSON.stringify({ occurredAt: cursor.occurredAt.toISOString(), id: cursor.id }),
      ).toString('base64url')
    : null;
}

function enumList(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  const values = value.split(',').filter(Boolean);
  if (values.length === 0 || values.some((item) => !allowed.has(item))) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ไม่ถูกต้อง` });
  }
  return values;
}

@Controller('api/v1/contact-governance')
export class ContactGovernanceCg5QueryController {
  private readonly queries: Cg5QueryService;
  private readonly alerts: Cg5AlertRepository;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient) {
    this.queries = new Cg5QueryService(database);
    this.alerts = new Cg5AlertRepository(database);
  }

  @Get('metrics')
  @GatewayRoles('supervisor', 'admin', 'compliance')
  async metrics(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('granularity') requestedGranularity: unknown,
    @Query('metricKey') metricKey: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('channel') channel: unknown,
    @Query('purpose') purpose: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') requestedLimit: unknown,
  ) {
    const actor = identity(request);
    try {
      const result = await this.queries.metrics(actor.tenantId, await this.scope(actor), {
        granularity: granularity(requestedGranularity),
        ...(typeof metricKey === 'string' ? { metricKey: metricKey as never } : {}),
        ...(optionalDate(from, 'from') ? { from: optionalDate(from, 'from') } : {}),
        ...(optionalDate(to, 'to') ? { to: optionalDate(to, 'to') } : {}),
        ...(typeof channel === 'string' ? { channel } : {}),
        ...(typeof purpose === 'string' ? { purpose } : {}),
        ...(decodeCursor(cursor) ? { cursor: decodeCursor(cursor) } : {}),
        limit: limit(requestedLimit),
      });
      return { ...result, nextCursor: encodeCursor(result.nextCursor) };
    } catch (error) {
      this.mapError(error);
    }
  }

  @Get('metrics/policy-impact')
  @GatewayRoles('supervisor', 'admin', 'compliance')
  async policyImpact(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('granularity') requestedGranularity: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') requestedLimit: unknown,
  ) {
    const actor = identity(request);
    try {
      const result = await this.queries.policyImpact(actor.tenantId, await this.scope(actor), {
        granularity: granularity(requestedGranularity),
        ...(optionalDate(from, 'from') ? { from: optionalDate(from, 'from') } : {}),
        ...(optionalDate(to, 'to') ? { to: optionalDate(to, 'to') } : {}),
        ...(decodeCursor(cursor) ? { cursor: decodeCursor(cursor) } : {}),
        limit: limit(requestedLimit),
      });
      return { ...result, nextCursor: encodeCursor(result.nextCursor) };
    } catch (error) {
      this.mapError(error);
    }
  }

  @Get('alerts')
  @GatewayRoles('supervisor', 'admin', 'compliance')
  async alertsList(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('state') state: unknown,
    @Query('severity') severity: unknown,
    @Query('cursor') cursor: unknown,
    @Query('limit') requestedLimit: unknown,
  ) {
    const actor = identity(request);
    try {
      const result = await this.queries.alerts(actor.tenantId, await this.scope(actor), {
        ...(enumList(state, ALERT_STATES, 'state')
          ? { states: enumList(state, ALERT_STATES, 'state') as never }
          : {}),
        ...(enumList(severity, ALERT_SEVERITIES, 'severity')
          ? { severities: enumList(severity, ALERT_SEVERITIES, 'severity') as never }
          : {}),
        ...(decodeCursor(cursor) ? { cursor: decodeCursor(cursor) } : {}),
        limit: limit(requestedLimit),
      });
      return { ...result, nextCursor: encodeCursor(result.nextCursor) };
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post('alerts/:alertId/ack')
  @GatewayRoles('supervisor', 'admin', 'compliance')
  async acknowledge(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('alertId') alertId: string,
    @Body() body: { version?: unknown },
  ) {
    const actor = identity(request);
    const expectedVersion = body?.version;
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'version ต้องเป็น positive integer',
      });
    }
    try {
      await this.alerts.acknowledge({
        tenantId: actor.tenantId,
        alertId: requiredUuid(alertId, 'alertId'),
        expectedVersion,
        actorRef: `workspace:${actor.userId}`,
      });
      return { alertId, version: expectedVersion + 1 };
    } catch (error) {
      this.mapError(error);
    }
  }

  private async scope(actor: {
    tenantId: string;
    userId: string;
    roles: readonly string[];
  }): Promise<Cg5QueryScope> {
    if (actor.roles.includes('admin') || actor.roles.includes('compliance'))
      return { kind: 'TENANT' };
    if (!actor.roles.includes('supervisor')) throw new ForbiddenException();
    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      const supervisor = await tx.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR' },
        select: { teamId: true },
      });
      if (!supervisor?.teamId) throw new ForbiddenException('supervisor must belong to a team');
      return { kind: 'TEAM', teamId: supervisor.teamId };
    });
  }

  private mapError(error: unknown): never {
    if (error instanceof Cg5ProjectionNotReadyError) {
      throw new ServiceUnavailableException({ code: error.code, state: error.state });
    }
    if (error instanceof Cg5AlertVersionConflictError) {
      throw new ConflictException({
        code: 'CG5_ALERT_VERSION_CONFLICT',
        expectedVersion: error.expectedVersion,
        actualVersion: error.actualVersion,
      });
    }
    if (error instanceof ForbiddenException || error instanceof BadRequestException) throw error;
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: error.message });
    }
    throw error;
  }
}
