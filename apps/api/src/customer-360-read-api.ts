import {
  Body,
  Catch,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  C360ReadError,
  c360CursorCodecFromEnv,
  c360Uuid,
  readC360Profile,
  readC360Timeline,
  searchC360Contacts,
  type C360CursorCodec,
} from '@d-contact/customer-360';
import {
  CUSTOMER_360_DATABASE,
  Customer360Errors,
  c360CurrentActor,
  requestIdentity,
} from './customer-360-api.js';
import { readC360GovernanceSummary } from './customer-360-read-governance.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  C360_SEARCH_POLICY,
  C360_RECEIPT_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
  type SharedRateLimitInput,
} from './shared-rate-limiter.js';
import { coreRequestId } from './tenant-core-errors.js';

/**
 * Cus360 C2 (#792) S1: Console read routes (R1 F/G)
 *
 * - POST /contacts/search และ GET /contacts/:contactId เป็น read-only: ไม่รับ commandId, ไม่สร้าง head/receipt/audit
 * - search body/ค่า query ไม่ลง log: ไม่มีการ log ใน controller นี้ และ error body ไม่สะท้อนค่าที่ผู้ใช้กรอก
 * - rate (R1 G): search 60/นาที/actor และ 600/นาที/tenant ผ่าน shared limiter
 */
export const C360_SEARCH_LIMIT_PER_ACTOR = C360_SEARCH_POLICY.actorLimit;
export const C360_SEARCH_LIMIT_PER_TENANT = C360_SEARCH_POLICY.tenantLimit;

/** ตอบ C360ReadError ในรูป error family เดียวกับ C1 (เพิ่ม fieldErrors ที่ไม่มีค่า PII) แล้วส่งที่เหลือให้ filter ของ C1 */
@Catch()
export class Customer360ReadErrors implements ExceptionFilter {
  private readonly fallback = new Customer360Errors();

  catch(error: unknown, host: ArgumentsHost) {
    if (!(error instanceof C360ReadError)) return this.fallback.catch(error, host);
    const request = host.switchToHttp().getRequest<AuthenticatedGatewayRequest>();
    const response = host.switchToHttp().getResponse<ServerResponse>();
    response.statusCode = error.status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (error.retryable) response.setHeader('Retry-After', String(error.retryAfterSeconds ?? 1));
    const requestId = coreRequestId(request);
    if (requestId) response.setHeader('X-Request-Id', requestId);
    response.end(
      JSON.stringify({
        error: {
          code: error.code,
          messageKey: `customer360.errors.${error.code}`,
          retryable: error.retryable,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
        requestId,
      }),
    );
  }
}

/** path ที่ไม่ใช่ UUID ตอบเหมือน resource ที่ไม่พบ (ไม่มี oracle) */
function pathContactId(value: string): string {
  try {
    return c360Uuid(value);
  } catch {
    throw new C360ReadError(404, 'RESOURCE_NOT_FOUND');
  }
}

@UseFilters(Customer360ReadErrors)
@Controller('api/v1/customer-360')
@GatewayRoles('admin', 'supervisor')
export class Customer360ReadController {
  private readonly codec: C360CursorCodec = c360CursorCodecFromEnv();
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
  ) {}

  private async throttle(
    tenantId: string,
    userId: string,
    policy: SharedRateLimitInput['policy'] = C360_SEARCH_POLICY,
  ) {
    let rejected: { retryAfterSeconds: number } | null;
    try {
      rejected = await this.limiter.consume({
        tenantId,
        actorId: userId,
        policy,
      });
    } catch {
      throw new C360ReadError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (rejected) {
      throw new C360ReadError(429, 'RATE_LIMITED', true, undefined, rejected.retryAfterSeconds);
    }
  }

  @Post('contacts/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async search(@Req() req: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const identity = requestIdentity(req);
    await this.throttle(identity.tenantId, identity.userId);
    return withTenantDatabaseTransaction(
      this.db,
      identity.tenantId,
      async (tx) => {
        // Search ใช้ query สั้นหลายครั้ง ค่า compile JIT อาจสูงกว่าเวลาประมวลผลจริง
        await tx.$queryRaw`SELECT set_config('jit', 'off', true)`;
        const actor = await c360CurrentActor(tx, identity);
        return searchC360Contacts(tx, actor, body, this.codec);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  @Get('contacts/:contactId')
  @Header('Cache-Control', 'no-store')
  async profile(@Req() req: AuthenticatedGatewayRequest, @Param('contactId') contactId: string) {
    const identity = requestIdentity(req);
    const id = pathContactId(contactId);
    await this.throttle(identity.tenantId, identity.userId, C360_RECEIPT_POLICY);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return readC360Profile(tx, actor, id);
    });
  }

  /**
   * Voice timeline: section แยกจาก core profile — owner ล้ม = 200 พร้อม state UNAVAILABLE (ไม่ใช่ list ว่าง)
   * ส่วน DENY/ไม่พบ/DEFER ของลูกค้ายังเป็น 404/503 และไม่ส่งข้อมูลเสริมใด ๆ
   */
  @Get('contacts/:contactId/timeline')
  @Header('Cache-Control', 'no-store')
  async timeline(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const identity = requestIdentity(req);
    const id = pathContactId(contactId);
    if (limit !== undefined && !/^\d{1,3}$/.test(limit))
      throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
        { field: 'limit', code: 'LIMIT_INVALID' },
      ]);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0))
      throw new C360ReadError(400, 'CURSOR_INVALID');
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return readC360Timeline(
        tx,
        actor,
        id,
        { ...(limit ? { limit: Number(limit) } : {}), ...(cursor ? { cursor } : {}) },
        this.codec,
      );
    });
  }

  /** read-only (POST เพราะรับ context ใน body): ไม่รับ commandId, ไม่ authorize/reserve, ไม่มี side effect */
  @Post('contacts/:contactId/governance-summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async governanceSummary(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
  ) {
    const identity = requestIdentity(req);
    const id = pathContactId(contactId);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return readC360GovernanceSummary(tx, actor, id, body);
    });
  }
}
