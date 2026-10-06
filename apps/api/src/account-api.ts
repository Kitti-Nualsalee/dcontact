/**
 * AC4 (#597): `/api/v1/me/account/*` — self-service บัญชีของผู้ใช้ทุก role ของ tenant (#589)
 *
 * tenant และผู้ใช้มาจาก token เสมอ (ไม่มี user id ใน path/body); envelope คงที่ `{ code, ...details }`
 * และไม่บอกชื่อระบบ identity (`IDENTITY_UNAVAILABLE`)
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { AccountError, type AccountErrorCode } from './account-identity.js';
import type { AccountSelfService } from './account-self-service.js';

export const ACCOUNT_SELF_SERVICE = Symbol('ACCOUNT_SELF_SERVICE');

const STATUS: Record<AccountErrorCode, number> = {
  VALIDATION_FAILED: 400,
  PASSWORD_POLICY_VIOLATION: 400,
  INVALID_OTP_CODE: 400,
  EMAIL_CHANGE_NOT_ALLOWED: 403,
  DEVICE_NOT_FOUND: 404,
  EMAIL_IN_USE: 409,
  MFA_REQUIRED_LAST_DEVICE: 409,
  EMAIL_CHANGE_EXPIRED: 410,
  ENROLMENT_EXPIRED: 410,
  RATE_LIMITED: 429,
  IDENTITY_UNAVAILABLE: 503,
};

type Body = Record<string, unknown> | undefined;

@Controller('api/v1/me/account')
@GatewayRoles('agent', 'supervisor', 'admin', 'compliance')
export class AccountController {
  constructor(@Inject(ACCOUNT_SELF_SERVICE) private readonly accounts: AccountSelfService | null) {}

  @Get()
  get(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    return this.run(response, (service) => service.get(actor(request)));
  }

  @Patch('profile')
  updateProfile(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() body: Body,
  ) {
    return this.run(response, (service) =>
      service.updateProfile(actor(request), body ?? {}, correlation(request)),
    );
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() body: Body,
  ) {
    await this.run(response, (service) =>
      service.changePassword(actor(request), body ?? {}, correlation(request)),
    );
  }

  @Post('email-change')
  async requestEmailChange(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() body: Body,
  ) {
    const result = await this.run(response, (service) =>
      service.requestEmailChange(actor(request), body ?? {}, correlation(request)),
    );
    response.statusCode = result.status === 'PENDING' ? 202 : 200;
    return result;
  }

  @Post('email-change/confirm')
  @HttpCode(200)
  confirmEmailChange(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() body: Body,
  ) {
    return this.run(response, (service) =>
      service.confirmEmailChange(actor(request), body ?? {}, correlation(request)),
    );
  }

  @Delete('email-change')
  @HttpCode(204)
  async cancelEmailChange(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    await this.run(response, (service) =>
      service.cancelEmailChange(actor(request), correlation(request)),
    );
  }

  @Post('mfa/totp/enrolments')
  @HttpCode(201)
  startTotpEnrolment(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    response.setHeader('cache-control', 'no-store');
    return this.run(response, (service) => service.startTotpEnrolment(actor(request)));
  }

  @Post('mfa/totp/enrolments/:enrolmentId/confirm')
  @HttpCode(201)
  confirmTotpEnrolment(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('enrolmentId', new ParseUUIDPipe()) enrolmentId: string,
    @Body() body: Body,
  ) {
    return this.run(response, (service) =>
      service.confirmTotpEnrolment(actor(request), enrolmentId, body ?? {}, correlation(request)),
    );
  }

  @Delete('mfa/totp/:credentialId')
  @HttpCode(204)
  async removeTotpDevice(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
  ) {
    await this.run(response, (service) =>
      service.removeTotpDevice(actor(request), credentialId, correlation(request)),
    );
  }

  private async run<T>(
    response: ServerResponse,
    work: (service: AccountSelfService) => Promise<T>,
  ) {
    if (!this.accounts) throw failure(new AccountError('IDENTITY_UNAVAILABLE'), response);
    try {
      return await work(this.accounts);
    } catch (error) {
      if (error instanceof AccountError) throw failure(error, response);
      throw error;
    }
  }
}

function actor(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

const correlation = (request: AuthenticatedGatewayRequest) =>
  request.correlationId ?? 'unavailable';

function failure(error: AccountError, response: ServerResponse) {
  const retryAfter = error.details.retryAfterSeconds;
  if (error.code === 'RATE_LIMITED' && typeof retryAfter === 'number') {
    response.setHeader('retry-after', String(retryAfter));
  }
  return new HttpException({ code: error.code, ...error.details }, STATUS[error.code]);
}
