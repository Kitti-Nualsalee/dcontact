/**
 * AC1 (#594): `GET/PUT /api/v1/tenant/account-policy` — admin ของ tenant เท่านั้น (#589)
 *
 * tenant และผู้แก้มาจาก token เสมอ ไม่รับจาก path/body; envelope คงที่ `{ code, field?, reason? }`
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Put,
  Req,
} from '@nestjs/common';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { AccountPolicyError, type AccountPolicyService } from './account-policy.js';

export const ACCOUNT_POLICY_SERVICE = Symbol('ACCOUNT_POLICY_SERVICE');

function actorOf(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AccountPolicyError)) throw error;
    const body = { code: error.code, ...(error.field ?? {}) };
    if (error.code === 'VALIDATION_FAILED') throw new BadRequestException(body);
    throw new ConflictException(body);
  }
}

@Controller('api/v1/tenant/account-policy')
export class AccountPolicyController {
  constructor(@Inject(ACCOUNT_POLICY_SERVICE) private readonly policies: AccountPolicyService) {}

  @Get()
  @GatewayRoles('admin')
  get(@Req() request: AuthenticatedGatewayRequest) {
    return mapped(() => this.policies.get(actorOf(request)));
  }

  @Put()
  @GatewayRoles('admin')
  update(@Req() request: AuthenticatedGatewayRequest, @Body() body: Record<string, unknown>) {
    return mapped(() =>
      this.policies.update(
        actorOf(request),
        body ?? {},
        request.correlationId ?? 'unavailable',
      ),
    );
  }
}
