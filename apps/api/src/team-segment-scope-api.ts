import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const TEAM_SEGMENT_SCOPE_DATABASE = Symbol('TEAM_SEGMENT_SCOPE_DATABASE');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actor(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field, reason: 'UUID_REQUIRED' });
  return value;
}

function segment(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value))
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      field: 'segmentId',
      reason: 'INVALID',
    });
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 120)
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      field: 'reasonCode',
      reason: 'INVALID',
    });
  return value.trim();
}

@Controller('api/v1/tenant/team-segment-scopes')
export class TeamSegmentScopeController {
  constructor(@Inject(TEAM_SEGMENT_SCOPE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('admin')
  async list(@Req() request: AuthenticatedGatewayRequest) {
    const identity = actor(request);
    return withTenantDatabaseTransaction(this.database, identity.tenantId, async (transaction) => {
      const grants = await transaction.iamTeamSegmentScopeActiveGrant.findMany({
        where: { tenantId: identity.tenantId, permission: 'VIEW' },
        select: {
          teamId: true,
          segmentId: true,
          grantId: true,
          updatedAt: true,
        },
        orderBy: [{ teamId: 'asc' }, { segmentId: 'asc' }],
      });
      return { scopes: grants };
    });
  }

  @Post()
  @HttpCode(201)
  @GatewayRoles('admin')
  async grant(@Req() request: AuthenticatedGatewayRequest, @Body() body: Record<string, unknown>) {
    const identity = actor(request);
    const repository = new IamTeamSegmentScopeRepository(this.database);
    const result = await repository.grant({
      tenantId: identity.tenantId,
      teamId: uuid(body?.teamId, 'teamId'),
      segmentId: segment(body?.segmentId),
      permission: 'VIEW',
      correlationId: request.correlationId ?? 'unavailable',
    });
    return { outcome: result.outcome, grantId: result.grant.id };
  }

  @Delete(':grantId')
  @HttpCode(204)
  @GatewayRoles('admin')
  async revoke(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('grantId') grantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const identity = actor(request);
    const repository = new IamTeamSegmentScopeRepository(this.database);
    await repository.revoke({
      tenantId: identity.tenantId,
      grantId: uuid(grantId, 'grantId'),
      reasonCode: reason(body?.reasonCode),
      correlationId: request.correlationId ?? 'unavailable',
    });
  }
}
