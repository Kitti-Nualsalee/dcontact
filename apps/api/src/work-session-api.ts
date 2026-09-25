/**
 * E1.9 (#483): REST ของ work-session lease — `POST|DELETE /api/v1/me/work-session`, `POST .../takeover`
 *
 * error envelope คงที่ `{ code, holder? }`: 400 VALIDATION_FAILED, 404 AGENT_NOT_FOUND,
 * 409 WORK_SESSION_HELD (+holder) / WORK_SESSION_BUSY / WORK_SESSION_CHANGED
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  parseWorkSessionRequest,
  WorkSessionError,
  type WorkSessionLeases,
} from './work-session.js';

export const WORK_SESSION_LEASES = Symbol('WORK_SESSION_LEASES');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

function leaseIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new WorkSessionError('VALIDATION_FAILED');
  }
  return value;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof WorkSessionError)) throw error;
    const body = { code: error.code, ...(error.holder ? { holder: error.holder } : {}) };
    if (error.code === 'VALIDATION_FAILED') throw new BadRequestException(body);
    if (error.code === 'AGENT_NOT_FOUND') throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}

@Controller('api/v1/me/work-session')
export class WorkSessionController {
  constructor(@Inject(WORK_SESSION_LEASES) private readonly leases: WorkSessionLeases) {}

  @Post()
  @HttpCode(201)
  @GatewayRoles('agent')
  acquire(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    return mapped(() =>
      this.leases.acquire(
        actorOf(request),
        parseWorkSessionRequest(body),
        request.correlationId ?? 'unavailable',
      ),
    );
  }

  @Post('takeover')
  @HttpCode(201)
  @GatewayRoles('agent')
  takeover(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    return mapped(() => {
      const input = parseWorkSessionRequest(body);
      const expectedLeaseId = leaseIdFrom((body as { expectedLeaseId?: unknown })?.expectedLeaseId);
      return this.leases.takeover(
        actorOf(request),
        { ...input, expectedLeaseId },
        request.correlationId ?? 'unavailable',
      );
    });
  }

  /** ปล่อย lease ของ surface นี้ — ต้องแนบ `x-work-session-lease-id` กันแท็บเก่าปล่อย lease ของที่ใหม่ */
  @Delete()
  @HttpCode(204)
  @GatewayRoles('agent')
  release(
    @Req() request: AuthenticatedGatewayRequest,
    @Headers('x-work-session-lease-id') leaseId: string | undefined,
  ) {
    return mapped(() =>
      this.leases.release(
        actorOf(request),
        leaseIdFrom(leaseId),
        request.correlationId ?? 'unavailable',
      ),
    );
  }
}
