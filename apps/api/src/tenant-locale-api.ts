/**
 * D1.11 (#450): ค่าเริ่มต้นด้านภาษาและ timezone ของ tenant สำหรับ Console/Workspace
 *
 * ลำดับการเลือกภาษา (D1.5) คือ ผู้ใช้ → tenant → browser → `th` และ timezone คือ ผู้ใช้ → tenant
 * ค่าของผู้ใช้อยู่ใน token (claim `locale`/`zoneinfo`) ส่วนค่าของ tenant คือ `tenant_settings` ที่
 * provisioning (A1.5) สร้าง — route นี้อ่านอย่างเดียว และคืนค่าดิบให้ `@d-contact/i18n` ตัดสินฝั่ง client
 *
 * tenant เดิมก่อน A1.5 ไม่มีแถว `tenant_settings` จึงได้ `null` ทั้งคู่ (ไม่ใช่ 404) เพื่อให้ client
 * ไหลไปขั้นถัดไปของลำดับได้ตามปกติ; tenant มาจาก bearer token เท่านั้น ไม่รับจาก path/query
 */
import { Controller, Get, Inject, Req, UnauthorizedException } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

export const TENANT_LOCALE_DATABASE = Symbol('TENANT_LOCALE_DATABASE');

export interface TenantLocaleDefaultsV1 {
  locale: string | null;
  timeZone: string | null;
}

@Controller('api/v1/tenant/locale-defaults')
export class TenantLocaleDefaultsController {
  constructor(@Inject(TENANT_LOCALE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  async get(@Req() request: AuthenticatedGatewayRequest): Promise<TenantLocaleDefaultsV1> {
    const tenantId = request.gatewayIdentity?.tenantId;
    if (!tenantId) throw new UnauthorizedException();
    const settings = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.tenantSettings.findUnique({
        where: { tenantId },
        select: { locale: true, timezone: true },
      }),
    );
    return { locale: settings?.locale ?? null, timeZone: settings?.timezone ?? null };
  }
}
