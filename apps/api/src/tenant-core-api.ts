import {
  Controller,
  Get,
  Header,
  Inject,
  Req,
  Param,
  Query,
  Res,
  Post,
  Patch,
  Body,
  UseFilters,
  UnauthorizedException,
} from '@nestjs/common';
import { type PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { coreOrganizationSnapshot, updateCoreOrganization } from './tenant-core-organization.js';
import {
  createCoreTeam,
  readCoreTeam,
  renameCoreTeam,
  listCoreTeams,
  deactivateCoreTeam,
} from './tenant-core-teams.js';
import { tenantConfigurationCaller } from './tenant-config-identity.js';

import type { ServerResponse } from 'node:http';
import {
  coreUuid,
  coreActor,
  coreTransaction,
  lookupCoreCommand,
  reconcileCoreCommand,
} from './tenant-core-command.js';
import { coreFail, coreRequestId, TenantCoreErrors } from './tenant-core-errors.js';

export const TENANT_CORE_DATABASE = Symbol('TENANT_CORE_DATABASE');
export function coreRequestIdentity(req: AuthenticatedGatewayRequest) {
  if (!req.gatewayIdentity) throw new UnauthorizedException();
  const caller = tenantConfigurationCaller(req);
  if (!caller) coreFail('CORE_ACCESS_DENIED', 403);
  return {
    ...req.gatewayIdentity,
    tenantId: coreUuid(req.gatewayIdentity.tenantId),
    userId: coreUuid(req.gatewayIdentity.userId),
    caller,
    correlationId: coreRequestId(req),
  };
}

@UseFilters(TenantCoreErrors)
@Controller('api/v1/tenant/core-settings')
@GatewayRoles('admin', 'supervisor')
export class TenantCoreSettingsController {
  constructor(@Inject(TENANT_CORE_DATABASE) private readonly db: PrismaClient) {}

  @Get('teams')
  @Header('Cache-Control', 'no-store')
  teams(
    @Req() req: AuthenticatedGatewayRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const identity = coreRequestIdentity(req);
    if (identity.correlationId) response.setHeader('X-Request-Id', identity.correlationId);
    return listCoreTeams(this.db, identity, query);
  }

  @Get('teams/:id')
  @Header('Cache-Control', 'no-store')
  team(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const identity = coreRequestIdentity(req);
    if (identity.correlationId) response.setHeader('X-Request-Id', identity.correlationId);
    return readCoreTeam(this.db, identity, id);
  }

  @Post('teams')
  @GatewayRoles('admin')
  async createTeam(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    sendCoreResponse(
      response,
      await createCoreTeam(this.db, coreRequestIdentity(req), body),
      coreRequestId(req),
    );
  }

  @Patch('teams/:id')
  @GatewayRoles('admin')
  async renameTeam(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    sendCoreResponse(
      response,
      await renameCoreTeam(this.db, coreRequestIdentity(req), id, body),
      coreRequestId(req),
    );
  }

  @Post('teams/:id/deactivate')
  @GatewayRoles('admin')
  async deactivateTeam(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    sendCoreResponse(
      response,
      await deactivateCoreTeam(this.db, coreRequestIdentity(req), id, body),
      coreRequestId(req),
    );
  }

  @Get('organization')
  @Header('Cache-Control', 'no-store')
  organization(
    @Req() req: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const identity = coreRequestIdentity(req);
    if (identity.correlationId) response.setHeader('X-Request-Id', identity.correlationId);
    return coreTransaction(this.db, identity.tenantId, async (tx) => {
      await coreActor(tx, identity, false);
      return { organization: await coreOrganizationSnapshot(tx, identity.tenantId) };
    });
  }

  @Patch('organization')
  @GatewayRoles('admin')
  async updateOrganization(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const result = await updateCoreOrganization(this.db, coreRequestIdentity(req), body);
    sendCoreResponse(response, result, coreRequestId(req));
  }

  @Post('commands/:id/reconcile')
  @GatewayRoles('admin')
  async reconcile(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const result = await reconcileCoreCommand(this.db, coreRequestIdentity(req), id, body);
    sendCoreResponse(response, result, coreRequestId(req));
  }

  @Get('commands/:id')
  @GatewayRoles('admin')
  async command(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Res() response: ServerResponse,
  ) {
    const result = await lookupCoreCommand(this.db, coreRequestIdentity(req), id);
    sendCoreResponse(response, result, coreRequestId(req));
  }

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  capabilities(
    @Req() req: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const identity = coreRequestIdentity(req);
    if (identity.correlationId) response.setHeader('X-Request-Id', identity.correlationId);
    return coreTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await coreActor(tx, identity, false);
      const write = actor.role === 'ADMIN';
      return {
        organization: { read: true, write },
        teams: { read: true, create: write, rename: write, deactivate: write },
        teamScope: write ? 'TENANT' : 'OWN',
        schemaVersion: 1,
      };
    });
  }
}

function sendCoreResponse(
  response: ServerResponse,
  result: { status: number; body: unknown },
  requestId?: string,
) {
  if (requestId) response.setHeader('X-Request-Id', requestId);
  response.statusCode = result.status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json');
  if (result.status === 202) response.setHeader('Retry-After', '1');
  response.end(JSON.stringify(result.body));
}
