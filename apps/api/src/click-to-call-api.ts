/**
 * E1.14 (#488): `POST /api/v1/workspace/agent/click-to-call` — agent กดโทรใน dphone ที่ถูกฝังหลัง host กรอกเบอร์
 *
 * - ต้องแนบ `x-work-session-lease-id` ของ lease `embedded` ที่ยัง current
 * - ตอบ `dphone.call.result` ที่ไม่มี PII ให้ iframe ส่งต่อ host (+ `hostOrigin` ให้ตรวจกับ origin ที่ล็อกไว้)
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import type { ClickToCallService } from './click-to-call.js';

export const CLICK_TO_CALL_SERVICE = Symbol('CLICK_TO_CALL_SERVICE');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Controller('api/v1/workspace/agent/click-to-call')
export class ClickToCallController {
  constructor(@Inject(CLICK_TO_CALL_SERVICE) private readonly clickToCall: ClickToCallService) {}

  @Post()
  @HttpCode(200)
  @GatewayRoles('agent')
  async request(
    @Req() request: AuthenticatedGatewayRequest,
    @Headers('x-work-session-lease-id') leaseId: string | undefined,
    @Body() body: { requestId?: unknown; number?: unknown } | undefined,
  ) {
    if (!request.gatewayIdentity) throw new ForbiddenException();
    const requestId = body?.requestId;
    const number = body?.number;
    if (typeof leaseId !== 'string' || !UUID.test(leaseId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        field: 'x-work-session-lease-id',
      });
    }
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'requestId' });
    }
    if (typeof number !== 'string' || number.length > 40) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'number' });
    }
    const outcome = await this.clickToCall.request(
      { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId },
      { leaseId, requestId, number },
      request.correlationId ?? 'unavailable',
    );
    if (outcome.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND' });
    return outcome;
  }
}
