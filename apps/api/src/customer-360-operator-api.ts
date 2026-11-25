import {
  Body,
  Get,
  Param,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { PrismaClient } from '@d-contact/db';
import {
  c360Uuid,
  readC360ServicePrincipalMetadata,
  executeC360OperatorCommand,
  lookupC360OperatorCommand,
  reconcileC360OperatorCommand,
  type C360ProfileCommandResult,
  previewC360OperatorCommand,
  type C360TrustedOperator,
} from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { tenantConfigurationCaller } from './tenant-config-identity.js';
import {
  CUSTOMER_360_DATABASE,
  Customer360Errors,
  Customer360HttpError,
} from './customer-360-api.js';

/**
 * Cus360 C1 (#791) S5: the operator command route per E1 D
 *
 * only `platform-operator` (a realm role in the tenant's org login, the same pattern as the CG4 kill switch)
 * there is no route for an Admin to grant themselves permission. body: { commandId, evidenceRef, reasonCode, dryRun?, command }
 * dryRun=true returns a PII-free preview and does not admit the command; a real run returns the receipt from the S2 engine
 */
function operator(req: AuthenticatedGatewayRequest): C360TrustedOperator {
  const identity = req.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  if (
    !identity.roles.includes('platform-operator') ||
    identity.roles.includes('service') ||
    req.gatewayServiceIdentity ||
    (typeof req.gatewayVerifiedClaims?.preferred_username === 'string' &&
      req.gatewayVerifiedClaims.preferred_username ===
        `service-account-${req.gatewayVerifiedClaims.azp}`)
  )
    throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
  const caller = tenantConfigurationCaller(req);
  if (!caller) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
  return {
    tenantId: c360Uuid(identity.tenantId),
    issuer: caller.issuer,
    subject: caller.subject,
    userId: identity.userId ? c360Uuid(identity.userId) : null,
  };
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Customer360HttpError(400, 'INVALID_REQUEST');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['commandId', 'evidenceRef', 'reasonCode', 'dryRun', 'command'].includes(key),
    ) ||
    (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
  )
    throw new Customer360HttpError(400, 'INVALID_REQUEST');
  return input;
}

function sendCommand(response: ServerResponse, result: C360ProfileCommandResult) {
  response.statusCode = result.status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(
    JSON.stringify(
      result.state === 'TERMINAL'
        ? { state: 'TERMINAL', command: result.receipt }
        : { state: result.state, commandId: result.commandId },
    ),
  );
}

@UseFilters(Customer360Errors)
@Controller('api/v1/customer-360/operator')
@GatewayRoles('platform-operator')
export class Customer360OperatorController {
  constructor(@Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient) {}

  @Get('service-principals/:principalId')
  @Header('Cache-Control', 'no-store')
  async principal(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('principalId') principalId: string,
  ) {
    const result = await readC360ServicePrincipalMetadata(this.db, operator(req), principalId);
    if (!result) throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
    return result;
  }

  @Get('commands/:commandId')
  async lookup(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('commandId') commandId: string,
    @Res() response: ServerResponse,
  ) {
    sendCommand(response, await lookupC360OperatorCommand(this.db, operator(req), commandId));
  }

  @Post('commands/:commandId/reconcile')
  async reconcile(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('commandId') commandId: string,
    @Body() payload: unknown,
    @Res() response: ServerResponse,
  ) {
    sendCommand(
      response,
      await reconcileC360OperatorCommand(
        this.db,
        operator(req),
        commandId,
        payload === undefined ? {} : payload,
      ),
    );
  }

  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async command(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() payload: unknown,
    @Res() response: ServerResponse,
  ) {
    const trusted = operator(req);
    const input = body(payload);
    const request = {
      commandId: input.commandId,
      evidenceRef: input.evidenceRef,
      reasonCode: input.reasonCode,
      command: input.command as never,
    };
    if (input.dryRun === true) {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.statusCode = 200;
      response.end(JSON.stringify(await previewC360OperatorCommand(this.db, trusted, request)));
      return;
    }
    sendCommand(response, await executeC360OperatorCommand(this.db, trusted, request));
  }
}
