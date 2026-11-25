/**
 * Owner: Platform edge — session of the Platform Console (A1.2 #407)
 *
 * Returns only what the UI needs to decide what to show (roles/capabilities/expiry), never a token or raw claims
 * The UI uses capabilities only to hide buttons — the real authority is the guard on every request
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
    // A1.8: rollout off / not in the canary = strip the mutations from capabilities so the UI is read-only
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
