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
  searchC360Contacts,
  type C360CursorCodec,
} from '@d-contact/customer-360';
import {
  CUSTOMER_360_DATABASE,
  Customer360Errors,
  c360CurrentActor,
  requestIdentity,
} from './customer-360-api.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';
import { coreRequestId } from './tenant-core-errors.js';

/**
 * Cus360 C2 (#792) S1: Console read routes (R1 F/G)
 *
 * - POST /contacts/search และ GET /contacts/:contactId เป็น read-only: ไม่รับ commandId, ไม่สร้าง head/receipt/audit
 * - search body/ค่า query ไม่ลง log: ไม่มีการ log ใน controller นี้ และ error body ไม่สะท้อนค่าที่ผู้ใช้กรอก
 * - rate (R1 G): search 60/นาที/actor และ 600/นาที/tenant; limiter ปัจจุบันเป็น in-memory ต่อ instance
 *   (ยังไม่ใช่ shared limiter ข้าม instance ตามที่ R1 G ต้องการ — ดูหมายเหตุใน PR)
 */
export const C360_SEARCH_LIMIT_PER_ACTOR = 60;
export const C360_SEARCH_LIMIT_PER_TENANT = 600;

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

@UseFilters(Customer360ReadErrors)
@Controller('api/v1/customer-360')
@GatewayRoles('admin', 'supervisor')
export class Customer360ReadController {
  private readonly codec: C360CursorCodec = c360CursorCodecFromEnv();
  private readonly limiter = new TenantClientRateLimiter();

  constructor(@Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient) {}

  private throttle(tenantId: string, userId: string) {
    const rejected =
      this.limiter.consume({
        tenantId,
        clientId: `c360-search-actor:${userId}`,
        limitPerMinute: C360_SEARCH_LIMIT_PER_ACTOR,
      }) ??
      this.limiter.consume({
        tenantId,
        clientId: 'c360-search-tenant',
        limitPerMinute: C360_SEARCH_LIMIT_PER_TENANT,
      });
    if (rejected) {
      throw new C360ReadError(429, 'RATE_LIMITED', true, undefined, rejected.retryAfterSeconds);
    }
  }

  @Post('contacts/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async search(@Req() req: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const identity = requestIdentity(req);
    this.throttle(identity.tenantId, identity.userId);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return searchC360Contacts(tx, actor, body, this.codec);
    });
  }

  @Get('contacts/:contactId')
  @Header('Cache-Control', 'no-store')
  async profile(@Req() req: AuthenticatedGatewayRequest, @Param('contactId') contactId: string) {
    const identity = requestIdentity(req);
    let id: string;
    try {
      id = c360Uuid(contactId);
    } catch {
      // path ที่ไม่ใช่ UUID ตอบเหมือน resource ที่ไม่พบ (ไม่มี oracle)
      throw new C360ReadError(404, 'RESOURCE_NOT_FOUND');
    }
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      return readC360Profile(tx, actor, id);
    });
  }
}
