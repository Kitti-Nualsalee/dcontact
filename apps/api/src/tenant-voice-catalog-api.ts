import { voiceCatalogCaller } from './tenant-voice-identity.js';
import { VoiceCatalogErrors } from './tenant-voice-catalog-errors.js';
import {
  UseFilters,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  Header,
  Optional,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import { TENANT_PEOPLE_READINESS, type TenantPeopleReadiness } from './tenant-people-readiness.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  catalogCapabilities,
  catalogCommand,
  catalogTeams,
  createCatalog,
  readCatalog,
  type VoiceActor,
  voiceUuid,
  voiceFail,
} from './tenant-voice-catalog.js';
export const TENANT_VOICE_DATABASE = Symbol('TENANT_VOICE_DATABASE');
function actor(req: AuthenticatedGatewayRequest): VoiceActor {
  if (!req.gatewayIdentity) throw new UnauthorizedException();
  const identity = req.gatewayIdentity;
  const caller = voiceCatalogCaller(req);
  if (!caller) voiceFail('FORBIDDEN', 403);
  return {
    ...identity,
    caller,
    tenantId: voiceUuid(identity.tenantId, 'tenantId'),
    userId: voiceUuid(identity.userId, 'userId'),
    correlationId: req.correlationId,
  };
}
@UseFilters(VoiceCatalogErrors)
@Controller('api/v1/tenant-voice')
@GatewayRoles('admin', 'supervisor')
export class TenantVoiceCatalogController {
  constructor(
    @Inject(TENANT_VOICE_DATABASE) private readonly db: PrismaClient,
    @Optional() @Inject(TENANT_PEOPLE_READINESS) private readonly people?: TenantPeopleReadiness,
  ) {}
  @Get('capabilities') @Header('Cache-Control', 'no-store') async capabilities(
    @Req() r: AuthenticatedGatewayRequest,
  ) {
    const identity = actor(r);
    const result = await catalogCapabilities(this.db, identity);
    if (
      result.canWrite &&
      result.configuration.ready &&
      (await this.people?.isReady(identity.tenantId))
    )
      result.peopleProvisioning = { ready: true, reasons: [] };
    if (
      result.canWrite &&
      result.configuration.ready &&
      (await this.people?.canReconcileInvitation?.(identity.tenantId)) &&
      (await this.people?.canResendInvitation?.(identity.tenantId))
    )
      result.invitation = { ready: true, reasons: [] };
    return result;
  }
  @Get('teams') @Header('Cache-Control', 'no-store') teams(@Req() r: AuthenticatedGatewayRequest) {
    return catalogTeams(this.db, actor(r));
  }
  @Get('queues') @Header('Cache-Control', 'no-store') queues(
    @Req() r: AuthenticatedGatewayRequest,
    @Query() q: Record<string, unknown>,
  ) {
    return readCatalog(this.db, actor(r), 'queues', q);
  }
  @Get('skills') @Header('Cache-Control', 'no-store') skills(
    @Req() r: AuthenticatedGatewayRequest,
    @Query() q: Record<string, unknown>,
  ) {
    return readCatalog(this.db, actor(r), 'skills', q);
  }
  @Get('queues/:id') @Header('Cache-Control', 'no-store') queue(
    @Req() r: AuthenticatedGatewayRequest,
    @Param('id') id: string,
  ) {
    return readCatalog(this.db, actor(r), 'queues', {}, id);
  }
  @Get('skills/:id') @Header('Cache-Control', 'no-store') skill(
    @Req() r: AuthenticatedGatewayRequest,
    @Param('id') id: string,
  ) {
    return readCatalog(this.db, actor(r), 'skills', {}, id);
  }
  @Post('queues') @GatewayRoles('admin') @Header('Cache-Control', 'no-store') createQueue(
    @Req() r: AuthenticatedGatewayRequest,
    @Body() b: unknown,
  ) {
    return createCatalog(this.db, actor(r), 'queues', b);
  }
  @Post('skills') @GatewayRoles('admin') @Header('Cache-Control', 'no-store') createSkill(
    @Req() r: AuthenticatedGatewayRequest,
    @Body() b: unknown,
  ) {
    return createCatalog(this.db, actor(r), 'skills', b);
  }
  @Get('commands/:id') @GatewayRoles('admin') @Header('Cache-Control', 'no-store') command(
    @Req() r: AuthenticatedGatewayRequest,
    @Param('id') id: string,
  ) {
    return catalogCommand(this.db, actor(r), id);
  }
}
