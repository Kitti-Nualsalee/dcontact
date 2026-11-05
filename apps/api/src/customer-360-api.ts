import {
  Body,
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import {
  C360ContactPointError,
  C360_PHONE_RAW_MAX,
  C360_EMAIL_RAW_MAX,
  normalizeC360Phone,
  normalizeC360Email,
} from '@d-contact/contact-points';
import {
  C360_WRITE_POLICY,
  C360_RECEIPT_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
} from './shared-rate-limiter.js';
import { withTenantDatabaseTransaction, Prisma, type PrismaClient } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360WriteDenied,
  C360WriteNotFound,
  C360WriteScopeUnavailable,
  normalizeC360ProfilePatch,
  updateC360Profile,
  updateC360ProfileTags,
  c360ManageableContactSql,
  replaceC360ContactPoint,
  addC360ContactPoint,
  retireC360ContactPoint,
  fenceC360ContactMutation,
  C360ProfileCommandRejection,
  C360WriteValidationError,
  C360_PROFILE_WRITE_VERSION,
  C360_PROFILE_NAME_MAX,
  C360_PROFILE_COMPANY_MAX,
  C360_CONTACT_POINT_QUOTA,
  normalizeC360CreateProfile,
  createC360Profile,
  executeC360ProfileCommand,
  authorizeC360ContactCreate,
  authorizeC360ContactAccess,
  c360ActorIdentityKey,
  c360Uuid,
  lookupC360ProfileCommand,
  reconcileC360ProfileCommand,
  type C360CommandActor,
  type C360CommandAuthorization,
  type C360ProfileCommandResult,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { CUSTOMER_360_WRITE_RUNTIME, type C360WriteRuntime } from './customer-360-write-runtime.js';
import {
  findTenantConfigurationActor,
  tenantConfigurationCaller,
  type TenantConfigurationIdentity,
} from './tenant-config-identity.js';
import { coreBusy, coreRequestId } from './tenant-core-errors.js';

/**
 * Cus360 C1 (#791) S3: HTTP gates ของ generic Console routes (R1 F)
 *
 * Identity มาจาก verified gateway claims + active User + proof binding (shared identity boundary
 * เดียวกับ core settings) แล้วตรวจ resource authorization ด้วย predicate ของ customer-360.
 * Agent/Compliance ไม่มี generic route; target นอกสิทธิ์ตอบเหมือนไม่พบ (ไม่มี existence oracle)
 */
export const CUSTOMER_360_DATABASE = Symbol('CUSTOMER_360_DATABASE');

export class Customer360HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

@Catch()
export class Customer360Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthenticatedGatewayRequest>();
    const response = host.switchToHttp().getResponse<ServerResponse>();
    let status = 500;
    let code = 'REQUEST_FAILED';
    let retryable = true;
    if (error instanceof Customer360HttpError) {
      ({ status, code, retryable } = error);
    } else if (error instanceof C360WriteValidationError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      retryable = false;
    } else if (error instanceof C360WriteNotFound) {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      retryable = false;
    } else if (error instanceof C360WriteScopeUnavailable) {
      status = 503;
      code = 'SCOPE_UNAVAILABLE';
      retryable = true;
    } else if (error instanceof C360WriteDenied) {
      status = 403;
      code = 'CUSTOMER_ACCESS_DENIED';
      retryable = false;
    } else if (error instanceof C360ProfileCommandError) {
      ({ httpStatus: status, code, retryable } = error);
    } else if (coreBusy(error)) {
      status = 503;
      code = 'RESOURCE_BUSY';
    } else if (error instanceof HttpException && [401, 403].includes(error.getStatus())) {
      status = error.getStatus();
      code = status === 401 ? 'SESSION_REQUIRED' : 'CUSTOMER_ACCESS_DENIED';
      retryable = false;
    }
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (retryable)
      response.setHeader(
        'Retry-After',
        String(error instanceof Customer360HttpError ? (error.retryAfterSeconds ?? 1) : 1),
      );
    const requestId = coreRequestId(request);
    if (requestId) response.setHeader('X-Request-Id', requestId);
    response.end(
      JSON.stringify({
        error: {
          code,
          messageKey: `customer360.errors.${code}`,
          retryable,
          ...(error instanceof C360WriteValidationError ? { fieldErrors: error.fieldErrors } : {}),
        },
        requestId,
      }),
    );
  }
}

export interface C360RequestIdentity extends TenantConfigurationIdentity {
  caller: NonNullable<TenantConfigurationIdentity['caller']>;
}

export function requestIdentity(req: AuthenticatedGatewayRequest): C360RequestIdentity {
  if (!req.gatewayIdentity) throw new UnauthorizedException();
  const caller = tenantConfigurationCaller(req);
  if (!caller) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
  return {
    ...req.gatewayIdentity,
    tenantId: c360Uuid(req.gatewayIdentity.tenantId),
    userId: c360Uuid(req.gatewayIdentity.userId),
    caller,
    correlationId: coreRequestId(req),
  };
}

/** Active User + proof binding ปัจจุบันภายใน transaction; เปลี่ยน role/proof/disable = ปฏิเสธทันที */
export async function c360CurrentActor(
  tx: Prisma.TransactionClient,
  identity: C360RequestIdentity,
): Promise<C360VerifiedActor> {
  const actor = await findTenantConfigurationActor(tx, identity);
  if (!actor) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
  return { tenantId: identity.tenantId, userId: actor.id, role: actor.role, teamId: actor.teamId };
}

function commandActor(identity: C360RequestIdentity): C360CommandActor {
  return {
    tenantId: identity.tenantId,
    actorUserId: identity.userId,
    actorIdentityKey: c360ActorIdentityKey({
      issuer: identity.caller.issuer,
      subject: identity.caller.subject,
      tenantId: identity.tenantId,
      userId: identity.userId,
    }),
  };
}

/** คำสั่งโปรไฟล์เป็นของ Admin; replay ตรวจสิทธิ์ปัจจุบันและกรอง refs ตามสิทธิ์อ่านขณะนี้ */
function commandAuthorization(identity: C360RequestIdentity): C360CommandAuthorization {
  let actor: C360VerifiedActor | undefined;
  return {
    authorize: async (tx) => {
      actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
    },
    canReadRef: async (tx, ref) =>
      ref.type === 'CONTACT' &&
      !!actor &&
      (await authorizeC360ContactAccess(tx, actor, ref.id)).decision === 'ALLOW',
  };
}

function send(response: ServerResponse, result: C360ProfileCommandResult) {
  response.statusCode = result.status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(
    JSON.stringify(
      result.state === 'TERMINAL'
        ? { state: 'TERMINAL', command: result.receipt }
        : { state: result.state, commandId: result.commandId },
    ),
  );
}

@UseFilters(Customer360Errors)
@Controller('api/v1/customer-360')
@GatewayRoles('admin', 'supervisor')
export class Customer360Controller {
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_WRITE_RUNTIME) private readonly runtime: C360WriteRuntime,
  ) {}

  private ensureWriteRuntime(): void {
    if (!this.runtime.ready) throw new Customer360HttpError(503, 'WRITE_RUNTIME_UNAVAILABLE', true);
  }

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  async actorCapabilities(@Req() req: AuthenticatedGatewayRequest) {
    const identity = requestIdentity(req);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return {
        create: this.runtime.ready && (await authorizeC360ContactCreate(tx, actor)),
        runtimeReady: this.runtime.ready,
        writeReady: this.runtime.ready && actor.role === 'ADMIN',
        validation: {
          displayNameMax: C360_PROFILE_NAME_MAX,
          companyMax: C360_PROFILE_COMPANY_MAX,
          phoneRawMax: C360_PHONE_RAW_MAX,
          emailRawMax: C360_EMAIL_RAW_MAX,
          activePointsPerKind: C360_CONTACT_POINT_QUOTA,
        },
      };
    });
  }

  @Post('contacts')
  @GatewayRoles('admin')
  async create(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const payload = body as Record<string, unknown>;
    const profile = normalizeC360CreateProfile(payload);
    const actor = commandActor(identity);
    let current: C360VerifiedActor | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        current = await c360CurrentActor(tx, identity);
        if (current.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, current)))
          throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      },
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ContactAccess(tx, current, ref.id)).decision === 'ALLOW',
    };
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_WRITE_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
    const result = await executeC360ProfileCommand(
      this.db,
      actor,
      {
        commandId: payload.commandId,
        action: 'CONTACT_CREATE',
        resourceType: 'CONTACT',
        resourceId: null,
        expectedRevisions: {},
        normalizationContractVersion: C360_PROFILE_WRITE_VERSION,
        normalizedRequest: profile,
      },
      authorization,
      async (tx, command) => {
        const verified = await c360CurrentActor(tx, identity);
        return createC360Profile(tx, verified, actor, command, profile);
      },
    );
    send(response, result);
  }

  @Patch('contacts/:contactId')
  @GatewayRoles('admin')
  async update(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    const id = c360Uuid(contactId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const payload = body as Record<string, unknown>;
    const patch = normalizeC360ProfilePatch(payload);
    if (
      typeof payload.expectedProfileRevision !== 'string' ||
      typeof payload.expectedLineageRevision !== 'string'
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    let current: C360VerifiedActor | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        current = await c360CurrentActor(tx, identity);
        if (current.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        const access = await authorizeC360ContactAccess(tx, current, id);
        if (access.decision === 'DENY') throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
        if (access.decision === 'DEFER')
          throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
        if (!access.manage) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      },
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ContactAccess(tx, current, ref.id)).decision === 'ALLOW',
    };
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_WRITE_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
    const profileRevision = payload.expectedProfileRevision;
    const lineageRevision = payload.expectedLineageRevision;
    const result = await executeC360ProfileCommand(
      this.db,
      commandActor(identity),
      {
        commandId: payload.commandId,
        action: 'CONTACT_UPDATE',
        resourceType: 'CONTACT',
        resourceId: id,
        expectedRevisions: { profile: profileRevision, lineage: lineageRevision },
        normalizationContractVersion: C360_PROFILE_WRITE_VERSION,
        normalizedRequest: patch,
      },
      authorization,
      async (tx) => {
        const verified = await c360CurrentActor(tx, identity);
        return updateC360Profile(tx, verified, id, profileRevision, lineageRevision, patch);
      },
    );
    send(response, result);
  }

  @Post('contacts/:contactId/contact-points')
  @GatewayRoles('admin')
  async addPoint(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    return this.pointCommand(req, contactId, null, body, response, 'ADD');
  }

  @Post('contacts/:contactId/contact-points/:pointId/retire')
  @GatewayRoles('admin')
  async retirePoint(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Param('pointId') pointId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    return this.pointCommand(req, contactId, pointId, body, response, 'RETIRE');
  }

  @Post('contacts/:contactId/contact-points/:pointId/replace')
  @GatewayRoles('admin')
  async replacePoint(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Param('pointId') pointId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    return this.pointCommand(req, contactId, pointId, body, response, 'REPLACE');
  }

  private async pointCommand(
    req: AuthenticatedGatewayRequest,
    contactId: string,
    pointId: string | null,
    body: unknown,
    response: ServerResponse,
    operation: 'ADD' | 'RETIRE' | 'REPLACE',
  ) {
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    const id = c360Uuid(contactId);
    const pointIdValue = pointId === null ? null : c360Uuid(pointId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const payload = body as Record<string, unknown>;
    const allowed = [
      'commandId',
      'expectedProfileRevision',
      'expectedLineageRevision',
      ...(operation === 'RETIRE' ? [] : ['kind', 'value', 'explicitCountry']),
    ];
    if (
      Object.keys(payload).some((key) => !allowed.includes(key)) ||
      typeof payload.expectedProfileRevision !== 'string' ||
      typeof payload.expectedLineageRevision !== 'string'
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    let point: ReturnType<typeof normalizeC360Phone> | undefined;
    if (operation !== 'RETIRE') {
      try {
        if (payload.kind === 'PHONE')
          point = normalizeC360Phone(payload.value, payload.explicitCountry);
        else if (
          payload.kind === 'EMAIL' &&
          (payload.explicitCountry === undefined || payload.explicitCountry === null)
        )
          point = normalizeC360Email(payload.value);
        else throw new Customer360HttpError(400, 'INVALID_REQUEST');
      } catch (error) {
        if (error instanceof C360ContactPointError)
          throw new C360WriteValidationError([{ field: 'value', code: error.code }]);
        throw error;
      }
    }
    let current: C360VerifiedActor | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        current = await c360CurrentActor(tx, identity);
        if (current.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        const access = await authorizeC360ContactAccess(tx, current, id);
        if (access.decision === 'DENY') throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
        if (access.decision === 'DEFER')
          throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
        if (!access.manage) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      },
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ContactAccess(tx, current, ref.id)).decision === 'ALLOW',
    };
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_WRITE_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
    const actor = commandActor(identity);
    const profileRevision = payload.expectedProfileRevision;
    const lineageRevision = payload.expectedLineageRevision;
    const result = await executeC360ProfileCommand(
      this.db,
      actor,
      {
        commandId: payload.commandId,
        action: `CONTACT_POINT_${operation}`,
        resourceType: 'CONTACT',
        resourceId: id,
        expectedRevisions: { profile: profileRevision, lineage: lineageRevision },
        normalizationContractVersion: point
          ? `${C360_PROFILE_WRITE_VERSION}+${point.normalizationVersion}`
          : C360_PROFILE_WRITE_VERSION,
        normalizedRequest: { pointId: pointIdValue, ...(point ? { point } : {}) },
      },
      authorization,
      async (tx, command) => {
        const verified = await c360CurrentActor(tx, identity);
        const access = (await fenceC360ContactMutation(tx, verified, [id])).get(id);
        if (!access || access.decision === 'DENY')
          throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
        if (access.decision === 'DEFER')
          throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
        if (!access.manage) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        const head = await tx.c360IdentityHead.findUnique({
          where: { tenantId_contactId: { tenantId: identity.tenantId, contactId: id } },
        });
        if (head?.lineageRevision.toString() !== lineageRevision)
          throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
        const context = {
          tenantId: identity.tenantId,
          contactId: id,
          actorIdentityKey: actor.actorIdentityKey,
          commandId: command.commandId,
          expectedProfileRevision: profileRevision,
        };
        if (operation === 'RETIRE') return retireC360ContactPoint(tx, context, pointIdValue!);
        const input = {
          kind: point!.kind,
          value: point!.rawValue,
          ...(point!.explicitCountry ? { explicitCountry: point!.explicitCountry } : {}),
        };
        return operation === 'ADD'
          ? addC360ContactPoint(tx, context, input)
          : replaceC360ContactPoint(tx, context, pointIdValue!, input);
      },
    );
    send(response, result);
  }

  @Get('tags/options')
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async tagOptions(@Req() req: AuthenticatedGatewayRequest) {
    const identity = requestIdentity(req);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const [managed] = await tx.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`SELECT EXISTS(
        SELECT 1 FROM contacts c WHERE ${c360ManageableContactSql(actor)}
      ) AS allowed`);
      if (!(await authorizeC360ContactCreate(tx, actor)) && !managed?.allowed)
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const tags = await tx.c360Tag.findMany({
        where: { tenantId: identity.tenantId, state: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: [{ nameKey: 'asc' }, { id: 'asc' }],
      });
      return { items: tags };
    });
  }

  @Patch('contacts/:contactId/tags')
  @GatewayRoles('admin')
  async tags(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureWriteRuntime();
    const id = c360Uuid(contactId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const payload = body as Record<string, unknown>;
    if (
      Object.keys(payload).some(
        (key) =>
          ![
            'commandId',
            'expectedTagRevision',
            'expectedLineageRevision',
            'attachTagIds',
            'detachTagIds',
          ].includes(key),
      ) ||
      typeof payload.expectedTagRevision !== 'string' ||
      typeof payload.expectedLineageRevision !== 'string' ||
      !Array.isArray(payload.attachTagIds) ||
      !Array.isArray(payload.detachTagIds)
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const attach = payload.attachTagIds.map(c360Uuid).sort();
    const detach = payload.detachTagIds.map(c360Uuid).sort();
    if (new Set([...attach, ...detach]).size !== attach.length + detach.length)
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    let current: C360VerifiedActor | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        current = await c360CurrentActor(tx, identity);
        if (current.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        const access = await authorizeC360ContactAccess(tx, current, id);
        if (access.decision === 'DENY') throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
        if (access.decision === 'DEFER')
          throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
        if (!access.manage) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      },
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ContactAccess(tx, current, ref.id)).decision === 'ALLOW',
    };
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_WRITE_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
    const actor = commandActor(identity);
    const tagRevision = payload.expectedTagRevision;
    const lineageRevision = payload.expectedLineageRevision;
    const result = await executeC360ProfileCommand(
      this.db,
      actor,
      {
        commandId: payload.commandId,
        action: 'CONTACT_TAGS_UPDATE',
        resourceType: 'CONTACT',
        resourceId: id,
        expectedRevisions: { tag: tagRevision, lineage: lineageRevision },
        normalizationContractVersion: C360_PROFILE_WRITE_VERSION,
        normalizedRequest: { attachTagIds: attach, detachTagIds: detach },
      },
      authorization,
      async (tx, command) => {
        const verified = await c360CurrentActor(tx, identity);
        return updateC360ProfileTags(
          tx,
          verified,
          actor,
          command,
          id,
          tagRevision,
          lineageRevision,
          attach,
          detach,
        );
      },
    );
    send(response, result);
  }

  /**
   * Capability hint ของ contact หนึ่งราย (R1 F: capabilities เป็น UI hint, server ตรวจซ้ำทุก mutation)
   * DENY และไม่พบตอบ 404 เหมือนกัน; DEFER ตอบ 503 ไม่ตีความเป็นไม่มีสิทธิ์หรือมีสิทธิ์
   */
  @Get('contacts/:contactId/capabilities')
  @Header('Cache-Control', 'no-store')
  async capabilities(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
  ) {
    const identity = requestIdentity(req);
    const id = c360Uuid(contactId);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      const access = await authorizeC360ContactAccess(tx, actor, id);
      if (access.decision === 'DEFER')
        throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
      if (access.decision === 'DENY') throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      return {
        contactId: id,
        identity: access.identity,
        capabilities: { read: access.read, manage: access.manage },
      };
    });
  }

  private async receiptBudget(identity: C360RequestIdentity): Promise<void> {
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_RECEIPT_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
  }

  @Get('commands/:commandId')
  @GatewayRoles('admin')
  async command(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('commandId') commandId: string,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    try {
      await this.receiptBudget(identity);
    } catch (error) {
      if (!(error instanceof Customer360HttpError) || error.code !== 'RATE_LIMITER_UNAVAILABLE')
        throw error;
      // เมื่อ limiter ล่ม กู้ได้เฉพาะ receipt ที่ commit แล้วและยังมีสิทธิ์อ่าน
      const recovered = await lookupC360ProfileCommand(
        this.db,
        commandActor(identity),
        commandId,
        commandAuthorization(identity),
      );
      if (recovered.state !== 'TERMINAL') throw error;
      return send(response, recovered);
    }
    send(
      response,
      await lookupC360ProfileCommand(
        this.db,
        commandActor(identity),
        commandId,
        commandAuthorization(identity),
      ),
    );
  }

  @Post('commands/:commandId/reconcile')
  @GatewayRoles('admin')
  async reconcile(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('commandId') commandId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    await this.receiptBudget(identity);
    send(
      response,
      await reconcileC360ProfileCommand(
        this.db,
        commandActor(identity),
        commandId,
        body,
        commandAuthorization(identity),
      ),
    );
  }
}
