/**
 * Owner: Platform API — endpoints ของ A1.6 (#411) ตาม #388 checkpoint 1
 *
 * - อ่าน = `CONTROL_PLANE_READ` (operator + auditor); เขียน = `PROVISIONING_MUTATE` (operator เท่านั้น)
 * - create/action ตอบ 202 พร้อม representation ปัจจุบัน; POST mutation บังคับ `Idempotency-Key`;
 *   PATCH/action รับ `expectedRevision`
 * - target tenant/request resolve จาก path + record ใน DB เสมอ — body ไม่มีช่องให้ส่ง tenant
 * - dependency ภายนอก (Keycloak/อีเมล) ไม่ถูกเรียกจากที่นี่: ผลหลังรับคำขอสะท้อนใน request state
 *   และ command (decision ใน #388)
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import {
  OPERATOR_ACTION_PATHS,
  PlatformCatalog,
  PlatformQueries,
  OperatorCommandIntake,
  ProvisioningControlRepository,
  ProvisioningRequestEditor,
  type PlatformActor,
} from '@d-contact/platform-control';
import {
  PLATFORM_PLAN_CODES,
  PlatformProvisioningError,
  type PlatformPlanCode,
  type ProvisioningRequestInput,
} from '@d-contact/shared';
import { RequirePlatformCapability, type AuthenticatedPlatformRequest } from './platform-auth.js';

export const PLATFORM_SERVICES = Symbol('PLATFORM_SERVICES');

export interface PlatformServices {
  queries: PlatformQueries;
  intake: OperatorCommandIntake;
  editor: ProvisioningRequestEditor;
  catalog: PlatformCatalog;
  repository: ProvisioningControlRepository;
}

function actorOf(request: AuthenticatedPlatformRequest): PlatformActor {
  const identity = request.platformIdentity!;
  return {
    kind: 'PLATFORM_OPERATOR',
    subject: identity.subject,
    role: identity.roles[0]!,
    sessionRef: identity.sessionId,
  };
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new PlatformProvisioningError('VALIDATION_FAILED', { idempotencyKey: 'REQUIRED' });
  }
  return value;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlatformProvisioningError('VALIDATION_FAILED', { body: 'INVALID' });
  }
  return body as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

@Controller('api/v1/provisioning-requests')
export class ProvisioningRequestsController {
  constructor(@Inject(PLATFORM_SERVICES) private readonly services: PlatformServices) {}

  @Post()
  @HttpCode(202)
  @RequirePlatformCapability('PROVISIONING_MUTATE')
  async create(
    @Req() request: AuthenticatedPlatformRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const body = objectBody(rawBody);
    const firstAdmin = (body.firstAdmin ?? {}) as Record<string, unknown>;
    const planCode = text(body.planCode);
    if (!(PLATFORM_PLAN_CODES as readonly string[]).includes(planCode)) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { planCode: 'INVALID' });
    }
    const input: ProvisioningRequestInput = {
      displayName: text(body.displayName),
      slug: text(body.slug),
      primaryDomain: text(body.primaryDomain),
      locale: text(body.locale),
      timezone: text(body.timezone),
      planCode: planCode as PlatformPlanCode,
      bootstrapTemplateVersion: text(body.bootstrapTemplateVersion),
      firstAdmin: { email: text(firstAdmin.email), displayName: text(firstAdmin.displayName) },
    };
    // pin plan version ที่ ACTIVE ล่าสุด ณ ตอนรับคำขอ (#392) — replay ใช้ของเดิมจาก receipt
    const plan = await this.services.catalog.activePlan(input.planCode);
    const accepted = await this.services.repository.accept({
      idempotencyKey: key,
      input,
      plan: { version: plan.version, snapshotDigest: plan.snapshotDigest },
      actor: actorOf(request),
      correlationId: request.correlationId!,
    });
    request.platformRequestId = accepted.requestId;
    response.setHeader('location', `/api/v1/provisioning-requests/${accepted.requestId}`);
    return {
      replayed: accepted.outcome === 'REPLAYED',
      request: await this.services.queries.requestView(accepted.requestId),
    };
  }

  @Get(':requestId')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  async get(@Param('requestId') requestId: string) {
    return this.services.queries.requestView(requestId);
  }

  @Patch(':requestId')
  @RequirePlatformCapability('PROVISIONING_MUTATE')
  async patch(
    @Req() request: AuthenticatedPlatformRequest,
    @Param('requestId') requestId: string,
    @Body() rawBody: unknown,
  ) {
    request.platformRequestId = requestId;
    const body = objectBody(rawBody);
    const changes = objectBody(body.changes ?? {});
    await this.services.editor.edit({
      requestId,
      expectedRevision: Number(body.expectedRevision),
      changes: Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [key, text(value)]),
      ),
      reasonCode: text(body.reasonCode),
      comment: text(body.comment),
      actor: actorOf(request),
      correlationId: request.correlationId!,
    });
    return this.services.queries.requestView(requestId);
  }

  /** preview แบบ async: worker ถาม Keycloak แล้วใส่ `previewDigest` ในผลของ command */
  @Post(':requestId/actions/:action/previews')
  @HttpCode(202)
  @RequirePlatformCapability('PROVISIONING_MUTATE')
  async preview(
    @Req() request: AuthenticatedPlatformRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('requestId') requestId: string,
    @Param('action') actionPath: string,
  ) {
    const action = OPERATOR_ACTION_PATHS[actionPath];
    if (!action) throw new PlatformProvisioningError('NOT_FOUND');
    const command = await this.services.intake.requestPreview({
      requestId,
      action,
      actor: actorOf(request),
      correlationId: request.correlationId!,
    });
    response.setHeader(
      'location',
      `/api/v1/provisioning-requests/${requestId}/actions/previews/${command.commandId}`,
    );
    return command;
  }

  @Get(':requestId/actions/previews/:previewId')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  async previewResult(
    @Param('requestId') requestId: string,
    @Param('previewId') previewId: string,
  ) {
    return this.services.intake.command(requestId, previewId, 'PREVIEW');
  }

  @Get(':requestId/commands/:commandId')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  async commandResult(
    @Param('requestId') requestId: string,
    @Param('commandId') commandId: string,
  ) {
    return this.services.intake.command(requestId, commandId);
  }

  @Post(':requestId/actions/:action')
  @HttpCode(202)
  @RequirePlatformCapability('PROVISIONING_MUTATE')
  async action(
    @Req() request: AuthenticatedPlatformRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('requestId') requestId: string,
    @Param('action') actionPath: string,
    @Body() rawBody: unknown,
  ) {
    const action = OPERATOR_ACTION_PATHS[actionPath];
    if (!action) throw new PlatformProvisioningError('NOT_FOUND');
    // error envelope ใส่ requestId ได้ (filter ตัดออกเองเมื่อเป็น 404 เพื่อไม่เผย existence)
    request.platformRequestId = requestId;
    const key = requireIdempotencyKey(idempotencyKey);
    const body = objectBody(rawBody ?? {});
    const command = await this.services.intake.submit({
      requestId,
      action,
      idempotencyKey: key,
      ...(body.expectedRevision !== undefined
        ? { expectedRevision: Number(body.expectedRevision) }
        : {}),
      ...(body.previewDigest !== undefined ? { previewDigest: text(body.previewDigest) } : {}),
      reasonCode: text(body.reasonCode),
      comment: text(body.comment),
      actor: actorOf(request),
      correlationId: request.correlationId!,
    });
    response.setHeader(
      'location',
      `/api/v1/provisioning-requests/${requestId}/commands/${command.commandId}`,
    );
    return { command, request: await this.services.queries.requestView(requestId) };
  }
}

@Controller('api/v1/tenants')
export class TenantsController {
  constructor(@Inject(PLATFORM_SERVICES) private readonly services: PlatformServices) {}

  @Get()
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  async search(
    @Query('query') query?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.services.queries.searchTenants({
      ...(query ? { query } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  @Get(':tenantId/action-history')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  async history(@Param('tenantId') tenantId: string, @Query('cursor') cursor?: string) {
    return this.services.queries.actionHistory({ tenantId, ...(cursor ? { cursor } : {}) });
  }
}
