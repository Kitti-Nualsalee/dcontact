/**
 * #567 (T1/T5): API ของ LINE team trial ใน service `line-webhook` — mount เฉพาะเมื่อ `LINE_TEAM_TRIAL=on`
 *
 * - `GET  /api/v1/line-pilot/trial`                สถานะ trial (เหลือกี่วัน/ใช้ไปเท่าไร/ถูก kill หรือไม่)
 * - `POST /api/v1/line-pilot/inbound/:id/reply`     ตอบกลับข้อความขาเข้าหนึ่งรายการ `{ text, idempotencyKey }`
 * - `POST /api/v1/line-pilot/kill`                  kill ทันที — ไม่มี endpoint ยก kill (CLI + approval เท่านั้น)
 *
 * ทุก route: OIDC + role `admin` + tenant ใน token = tenant ของ pilot; ตอบเฉพาะ machine code ไม่มี text/LINE ID
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type {
  LineTeamTrialReplies,
  LineTeamTrialReplyCode,
  LineTeamTrialReplyResult,
} from '@d-contact/delivery';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { LINE_PILOT_TENANT_ID } from './line-pilot-inbound-api.js';

export const LINE_TEAM_TRIAL = Symbol('LINE_TEAM_TRIAL');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** HTTP status ของแต่ละ code — หน้าจอแปลข้อความจาก code ไม่ใช่จาก status */
const FAILURE_STATUS: Readonly<Record<LineTeamTrialReplyCode, number>> = Object.freeze({
  TEXT_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  INBOUND_NOT_FOUND: 404,
  RECIPIENT_NOT_ALLOWLISTED: 403,
  TRIAL_NOT_ACTIVE: 409,
  KILLED: 409,
  CAP_EXCEEDED: 429,
  CONSENT_DENIED: 403,
  PROVIDER_UNAVAILABLE: 503,
  REJECTED: 502,
  DENIED: 403,
});

export function lineTrialHttpStatus(result: LineTeamTrialReplyResult): number {
  if (result.status !== 'FAILED') return result.status === 'SENT' ? 200 : 202;
  return FAILURE_STATUS[result.code];
}

@Controller('api/v1/line-pilot')
export class LinePilotTrialController {
  constructor(
    @Inject(LINE_TEAM_TRIAL)
    private readonly trial: Pick<LineTeamTrialReplies, 'reply' | 'status' | 'kill'>,
    @Inject(LINE_PILOT_TENANT_ID) private readonly tenantId: string,
  ) {}

  @Get('trial')
  @GatewayRoles('admin')
  status(@Req() request: AuthenticatedGatewayRequest) {
    this.viewer(request);
    return this.trial.status();
  }

  @Post('inbound/:id/reply')
  @GatewayRoles('admin')
  @HttpCode(200)
  async reply(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) http: { status(code: number): unknown },
  ) {
    const identity = this.viewer(request);
    if (!UUID.test(id)) throw new NotFoundException({ code: 'INBOUND_NOT_FOUND' });
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const result = await this.trial.reply({
      inboxEntryId: id,
      text: input.text,
      idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '',
      actorRef: identity.userId,
    });
    const status = lineTrialHttpStatus(result);
    const response =
      result.status === 'FAILED'
        ? { status: result.status, code: result.code }
        : { status: result.status, deliveryId: result.deliveryId };
    if (status >= 400) throw new HttpException(response, status);
    http.status(status);
    return response;
  }

  @Post('kill')
  @GatewayRoles('admin')
  @HttpCode(200)
  kill(@Req() request: AuthenticatedGatewayRequest) {
    const identity = this.viewer(request);
    return this.trial.kill(identity.userId);
  }

  private viewer(request: AuthenticatedGatewayRequest) {
    const identity = request.gatewayIdentity;
    if (!identity || identity.tenantId !== this.tenantId) throw new ForbiddenException();
    return identity;
  }
}
