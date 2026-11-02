import {
  Body,
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { withTenantDatabaseTransaction, type Prisma, type PrismaClient } from '@d-contact/db';
import {
  C360ProfileCommandError,
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
    if (retryable) response.setHeader('Retry-After', '1');
    const requestId = coreRequestId(request);
    if (requestId) response.setHeader('X-Request-Id', requestId);
    response.end(
      JSON.stringify({
        error: { code, messageKey: `customer360.errors.${code}`, retryable },
        requestId,
      }),
    );
  }
}

interface C360RequestIdentity extends TenantConfigurationIdentity {
  caller: NonNullable<TenantConfigurationIdentity['caller']>;
}

function requestIdentity(req: AuthenticatedGatewayRequest): C360RequestIdentity {
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
  constructor(@Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient) {}

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

  @Get('commands/:commandId')
  @GatewayRoles('admin')
  async command(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('commandId') commandId: string,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
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
