/**
 * #566 (R2.1/R2.2): `GET /api/v1/line-pilot/inbound` — รายการข้อความขาเข้าของ LINE pilot แบบ read-only
 *
 * mount ใน service `line-webhook` (profile `uat-line`) เท่านั้น และ Caddy ส่ง path นี้มาหลัง CIDR allowlist
 * - ต้อง login (OIDC) + role `admin` และ tenant ใน token ต้องเป็น tenant ของ binding — อื่น ๆ 403 เหมือนกันหมด
 *   ไม่บอกว่ามีข้อมูลหรือไม่
 * - response มาจาก `LinePilotInboundReader` ที่ไม่มี LINE ID ดิบ/replyToken และ audit ทุกการอ่าน
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Req,
} from '@nestjs/common';
import {
  LinePilotInboundCursorError,
  type LinePilotInboundPage,
  type LinePilotInboundReader,
} from '@d-contact/delivery';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const LINE_PILOT_INBOUND_READER = Symbol('LINE_PILOT_INBOUND_READER');
export const LINE_PILOT_TENANT_ID = Symbol('LINE_PILOT_TENANT_ID');

@Controller('api/v1/line-pilot/inbound')
export class LinePilotInboundController {
  constructor(
    @Inject(LINE_PILOT_INBOUND_READER)
    private readonly reader: Pick<LinePilotInboundReader, 'list'>,
    @Inject(LINE_PILOT_TENANT_ID) private readonly tenantId: string,
  ) {}

  @Get()
  @GatewayRoles('admin')
  async list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<LinePilotInboundPage> {
    const identity = request.gatewayIdentity;
    if (!identity || identity.tenantId !== this.tenantId) throw new ForbiddenException();
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new BadRequestException({ code: 'INVALID_LIMIT' });
    }
    try {
      return await this.reader.list({
        actorRef: identity.userId,
        limit: parsed,
        ...(before ? { before } : {}),
      });
    } catch (error) {
      if (error instanceof LinePilotInboundCursorError) {
        throw new BadRequestException({ code: 'INVALID_CURSOR' });
      }
      throw error;
    }
  }
}
