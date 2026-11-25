/**
 * E1.14 (#488): `POST /api/v1/workspace/agent/screen-pop` — the iframe requests the screen-pop payload before passing it to the host
 *
 * - must attach the `x-work-session-lease-id` of a still-current `embedded` lease — the host's origin comes from this lease
 * - answers `hostOrigin` back so the iframe checks it against the locked origin (mismatch = not sent)
 * - an origin with screen-pop off answers `{ status: 'off' }` with no call data
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
import type { ScreenPopService } from './screen-pop.js';

export const SCREEN_POP_SERVICE = Symbol('SCREEN_POP_SERVICE');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Controller('api/v1/workspace/agent/screen-pop')
export class ScreenPopController {
  constructor(@Inject(SCREEN_POP_SERVICE) private readonly screenPop: ScreenPopService) {}

  @Post()
  @HttpCode(200)
  @GatewayRoles('agent')
  async build(
    @Req() request: AuthenticatedGatewayRequest,
    @Headers('x-work-session-lease-id') leaseId: string | undefined,
    @Body() body: { interactionId?: unknown; requestId?: unknown } | undefined,
  ) {
    if (!request.gatewayIdentity) throw new ForbiddenException();
    const interactionId = body?.interactionId;
    const requestId = body?.requestId;
    if (typeof leaseId !== 'string' || !UUID.test(leaseId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        field: 'x-work-session-lease-id',
      });
    }
    if (typeof interactionId !== 'string' || !UUID.test(interactionId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'interactionId' });
    }
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'requestId' });
    }
    const outcome = await this.screenPop.build(
      { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId },
      { leaseId, interactionId, requestId },
    );
    if (outcome.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND' });
    return outcome;
  }
}
