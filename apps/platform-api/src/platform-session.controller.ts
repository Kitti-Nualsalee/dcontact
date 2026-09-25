/**
 * Owner: Platform edge — session ของ Platform Console (A1.2 #407)
 *
 * คืนเฉพาะสิ่งที่ UI ต้องใช้ตัดสินใจแสดงผล (roles/capabilities/หมดอายุ) ไม่คืน token หรือ claim ดิบ
 * UI ใช้ capabilities เพื่อซ่อนปุ่มเท่านั้น — authority จริงอยู่ที่ guard ทุก request
 */
import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import type { PlatformRollout } from '@d-contact/platform-control';
import {
  PLATFORM_ROLLOUT,
  PlatformPublic,
  RequirePlatformCapability,
  type AuthenticatedPlatformRequest,
} from './platform-auth.js';

@Controller()
export class PlatformSessionController {
  constructor(@Inject(PLATFORM_ROLLOUT) private readonly rollout: PlatformRollout) {}

  @Get('api/v1/session')
  @Header('cache-control', 'no-store')
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  session(@Req() request: AuthenticatedPlatformRequest) {
    const identity = request.platformIdentity!;
    // A1.8: rollout ปิด/ไม่อยู่ใน canary = ตัด mutation ออกจาก capabilities เพื่อให้ UI เป็นอ่านอย่างเดียว
    const mutations = identity.capabilities.includes('PROVISIONING_MUTATE')
      ? this.rollout.mutationFor(identity.subject)
      : 'NOT_GRANTED';
    return {
      subject: identity.subject,
      roles: identity.roles,
      capabilities: identity.capabilities.filter(
        (capability) => capability !== 'PROVISIONING_MUTATE' || mutations === 'ALLOWED',
      ),
      mutations,
      expiresAt: identity.expiresAt.toISOString(),
    };
  }

  @Get('health/live')
  @PlatformPublic()
  live() {
    return { status: 'ok' };
  }
}
