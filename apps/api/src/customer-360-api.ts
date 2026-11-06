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
  C360_RECEIPT_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
} from './shared-rate-limiter.js';
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
// จำกัด DB recovery ต่อ process เมื่อ Redis ไม่พร้อม; ไม่สร้างคิวที่โตไม่จำกัด
export class ReceiptRecoveryGate {
  private inFlight = 0;
  async run<T>(work: () => Promise<T>, unavailable: () => never): Promise<T> {
    if (this.inFlight >= 4) return unavailable();
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
    }
  }
}
const receiptRecoveryGate = new ReceiptRecoveryGate();

export class Customer360HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly fieldErrors?: readonly { field: string; code: string }[],
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
          ...(error instanceof Customer360HttpError && error.fieldErrors
            ? { fieldErrors: error.fieldErrors }
            : {}),
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

export function commandActor(identity: C360RequestIdentity): C360CommandActor {
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
export function commandAuthorization(identity: C360RequestIdentity): C360CommandAuthorization {
  let actor: C360VerifiedActor | undefined;
  return {
    authorize: async (tx) => {
      actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
    },
    canReadRef: async (tx, ref) =>
      !!actor &&
      (ref.type === 'CONTACT'
        ? (await authorizeC360ContactAccess(tx, actor, ref.id)).decision === 'ALLOW'
        : ref.type === 'TAG' &&
          !!(await tx.c360Tag.findFirst({
            where: { tenantId: identity.tenantId, id: ref.id },
            select: { id: true },
          }))),
  };
}

export function send(response: ServerResponse, result: C360ProfileCommandResult) {
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
  ) {}

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
    try {
      await this.receiptBudget(identity);
    } catch (error) {
      if (!(error instanceof Customer360HttpError) || error.code !== 'RATE_LIMITER_UNAVAILABLE')
        throw error;
      return receiptRecoveryGate.run(
        async () => {
          const recovered = await lookupC360ProfileCommand(
            this.db,
            commandActor(identity),
            commandId,
            commandAuthorization(identity),
            { boundedRecovery: true },
          );
          if (recovered.state !== 'TERMINAL') throw error;
          return send(response, recovered);
        },
        () => {
          throw error;
        },
      );
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

  @Post('commands')
  @GatewayRoles('admin')
  async submit(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    const correlationId = coreRequestId(req);
    await this.receiptBudget(identity);
    const { executeC360ProfileCommand, c360ProfileCommandPerform } = await import(
      '@d-contact/customer-360'
    );
    send(
      response,
      await executeC360ProfileCommand(
        this.db,
        commandActor(identity),
        body,
        commandAuthorization(identity),
        c360ProfileCommandPerform,
        { correlationId },
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
