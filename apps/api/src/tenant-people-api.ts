import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { VoiceCatalogErrors } from './tenant-voice-catalog-errors.js';
import { voiceCatalogCaller } from './tenant-voice-identity.js';
import { voiceFail, voiceUuid, type VoiceActor } from './tenant-voice-catalog.js';
import {
  acceptPeopleCreate,
  readPeopleOperation,
  readPeopleExtensionPool,
} from './tenant-people-operations.js';
import { TENANT_PEOPLE_READINESS, type TenantPeopleReadiness } from './tenant-people-readiness.js';
import { readPeopleDirectory } from './tenant-people-directory.js';
import { acceptPeopleInvitationReconcile } from './tenant-people-invitation-reconcile.js';
import { acceptPeopleInvitationResend } from './tenant-people-invitation-resend.js';
import { acceptPeopleDisable } from './tenant-people-disable.js';
export { TENANT_PEOPLE_READINESS, type TenantPeopleReadiness } from './tenant-people-readiness.js';

function actor(request: AuthenticatedGatewayRequest): VoiceActor {
  if (!request.gatewayIdentity) throw new UnauthorizedException();
  const caller = voiceCatalogCaller(request);
  if (!caller) voiceFail('FORBIDDEN', 403);
  return {
    ...request.gatewayIdentity,
    caller,
    tenantId: voiceUuid(request.gatewayIdentity.tenantId, 'tenantId'),
    userId: voiceUuid(request.gatewayIdentity.userId, 'userId'),
    correlationId: request.correlationId,
  };
}

function createBody(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    voiceFail('VALIDATION_FAILED', 400, { field: 'body' });
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const allowed = ['commandId', 'displayName', 'email', 'role', 'teamId', 'extensionRef'];
  if (Object.keys(fields).some((field) => !allowed.includes(field)))
    voiceFail('VALIDATION_FAILED', 400, { field: 'body' });
  const { extensionRef, ...command } = fields;
  return { ...command, extension: extensionRef };
}

@UseFilters(VoiceCatalogErrors)
@Controller('api/v1/tenant-voice')
@GatewayRoles('admin')
export class TenantPeopleController {
  constructor(
    @Inject(TENANT_VOICE_DATABASE) private readonly database: PrismaClient,
    @Inject(TENANT_PEOPLE_READINESS) private readonly readiness: TenantPeopleReadiness,
  ) {}

  @Get('people/users')
  @Header('Cache-Control', 'no-store')
  users(@Req() request: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return readPeopleDirectory(this.database, actor(request), query);
  }

  @Get('people/users/:id')
  @Header('Cache-Control', 'no-store')
  user(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return readPeopleDirectory(this.database, actor(request), query, id);
  }

  @Post('people/users')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const identity = actor(request);
    if (!(await this.readiness.isReady(identity.tenantId))) voiceFail('CAPABILITY_NOT_READY', 503);
    const accepted = await acceptPeopleCreate(
      this.database,
      identity,
      createBody(body),
      this.readiness.nodesForTenant?.(identity.tenantId) ?? [],
    );
    response.setHeader('Location', accepted.location);
    return accepted;
  }

  @Get('operations/:id')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: AuthenticatedGatewayRequest, @Param('id') id: string) {
    return readPeopleOperation(this.database, actor(request), id);
  }

  @Post('people/users/:id/disable')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async disable(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const identity = actor(request);
    if (!(await this.readiness.canDisable?.(identity.tenantId)))
      voiceFail('CAPABILITY_NOT_READY', 503);
    const port = this.readiness.disablePortForTenant?.(identity.tenantId);
    if (!port) voiceFail('CAPABILITY_NOT_READY', 503);
    const accepted = await acceptPeopleDisable(this.database, identity, id, body, port);
    response.setHeader('Location', accepted.location);
    return accepted;
  }

  @Post('people/users/:id/reconcile')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async reconcile(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const identity = actor(request);
    if (!(await this.readiness.canReconcileInvitation?.(identity.tenantId)))
      voiceFail('CAPABILITY_NOT_READY', 503);
    const accepted = await acceptPeopleInvitationReconcile(this.database, identity, id, body);
    response.setHeader('Location', accepted.location);
    return accepted;
  }

  @Post('people/users/:id/invitation/resend')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async resend(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const identity = actor(request);
    if (!(await this.readiness.canResendInvitation?.(identity.tenantId)))
      voiceFail('CAPABILITY_NOT_READY', 503);
    const accepted = await acceptPeopleInvitationResend(this.database, identity, id, body);
    response.setHeader('Location', accepted.location);
    return accepted;
  }

  @Get('extension-pool')
  @Header('Cache-Control', 'no-store')
  pool(@Req() request: AuthenticatedGatewayRequest) {
    const identity = actor(request);
    return readPeopleExtensionPool(
      this.database,
      identity,
      this.readiness.nodesForTenant?.(identity.tenantId) ?? [],
    );
  }
}
