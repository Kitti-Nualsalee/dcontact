/**
 * #566 (R2.1/R2.2): `GET /api/v1/line-pilot/inbound` — the read-only list of inbound LINE pilot messages
 *
 * mounted only in the `line-webhook` service (profile `uat-line`) and Caddy sends this path after the CIDR allowlist
 * - needs login (OIDC) + the role `admin` and the tenant in the token must be the binding's tenant — anything else is the same 403
 *   without saying whether data exists
 * - the response comes from `LinePilotInboundReader`, which has no raw LINE ID/replyToken, and audits every read
 * - `GET /api/v1/line-pilot/access` checks permission only (204) — reads no message and writes no audit, for the Console to decide
 *   whether to show the link, without making opening other pages count as reading messages
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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

@Controller('api/v1/line-pilot')
export class LinePilotInboundController {
  constructor(
    @Inject(LINE_PILOT_INBOUND_READER)
    private readonly reader: Pick<LinePilotInboundReader, 'list'>,
    @Inject(LINE_PILOT_TENANT_ID) private readonly tenantId: string,
  ) {}

  @Get('access')
  @GatewayRoles('admin')
  @HttpCode(204)
  access(@Req() request: AuthenticatedGatewayRequest): void {
    this.viewer(request);
  }

  @Get('inbound')
  @GatewayRoles('admin')
  async list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<LinePilotInboundPage> {
    const identity = this.viewer(request);
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

  private viewer(request: AuthenticatedGatewayRequest) {
    const identity = request.gatewayIdentity;
    if (!identity || identity.tenantId !== this.tenantId) throw new ForbiddenException();
    return identity;
  }
}
