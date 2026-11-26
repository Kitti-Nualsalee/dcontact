/**
 * D1.11 (#450): the tenant's default language and timezone for the Console/Workspace
 *
 * the language selection order (D1.5) is user → tenant → browser → `th`, and the timezone is user → tenant
 * the user's value is in the token (claim `locale`/`zoneinfo`) while the tenant's value is the `tenant_settings` that
 * provisioning (A1.5) creates — this route is read-only and returns the raw values for `@d-contact/i18n` to decide on the client side
 *
 * a tenant from before A1.5 has no `tenant_settings` row so it gets `null` for both (not 404) so the client
 * flows on to the next step of the order as usual; the tenant comes only from the bearer token, never from the path/query
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
