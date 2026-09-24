/**
 * Owner: Platform edge — session ของ Platform Console (A1.2 #407)
 *
 * คืนเฉพาะสิ่งที่ UI ต้องใช้ตัดสินใจแสดงผล (roles/capabilities/หมดอายุ) ไม่คืน token หรือ claim ดิบ
 * UI ใช้ capabilities เพื่อซ่อนปุ่มเท่านั้น — authority จริงอยู่ที่ guard ทุก request
 */
import { Controller, Get, Header, Req } from '@nestjs/common';
import {
  PlatformPublic,
  RequirePlatformCapability,
  type AuthenticatedPlatformRequest,
} from './platform-auth.js';

@Controller()
export class PlatformSessionController {
  @Get('api/v1/session')
  @Header('cache-control', 'no-store')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  session(@Req() request: AuthenticatedPlatformRequest) {
    const identity = request.platformIdentity!;
    return {
      subject: identity.subject,
      roles: identity.roles,
      capabilities: identity.capabilities,
      expiresAt: identity.expiresAt.toISOString(),
    };
  }

  @Get('health/live')
  @PlatformPublic()
  live() {
    return { status: 'ok' };
  }
}
