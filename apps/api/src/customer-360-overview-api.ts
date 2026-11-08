import { Controller, Get, Header, Inject, Query, Req, UseFilters } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  countC360AccessibleDirectory,
  countC360CatalogTags,
  c360ProfileFieldRules,
} from '@d-contact/customer-360';
import { Customer360ReadErrors } from './customer-360-read-api.js';
import {
  CUSTOMER_360_DATABASE,
  c360CurrentActor,
  requestIdentity,
  Customer360HttpError,
} from './customer-360-api.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  CUSTOMER_360_SEARCH_LIMITER,
  C360_RECEIPT_POLICY,
  type SharedRateLimiter,
} from './shared-rate-limiter.js';
import { CUSTOMER_360_WRITE_RUNTIME, type C360WriteRuntime } from './customer-360-write-runtime.js';
import {
  CUSTOMER_360_TAG_RUNTIME,
  type C360TagCatalogRuntime,
} from './customer-360-tag-runtime.js';

@UseFilters(Customer360ReadErrors)
@Controller('api/v1/customer-360')
@GatewayRoles('admin')
export class Customer360OverviewController {
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_WRITE_RUNTIME) private readonly writer: C360WriteRuntime,
    @Inject(CUSTOMER_360_TAG_RUNTIME) private readonly catalog: C360TagCatalogRuntime,
  ) {}
  private async read<T>(
    req: AuthenticatedGatewayRequest,
    query: Record<string, unknown>,
    fn: (
      tx: Parameters<typeof c360CurrentActor>[0],
      actor: Awaited<ReturnType<typeof c360CurrentActor>>,
    ) => Promise<T>,
  ) {
    if (Object.keys(query).length) throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const identity = requestIdentity(req);
    let rejected;
    try {
      rejected = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_RECEIPT_POLICY,
      });
    } catch {
      throw new Customer360HttpError(503, 'LIMITER_UNAVAILABLE', true);
    }
    if (rejected)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, rejected.retryAfterSeconds);
    return withTenantDatabaseTransaction(
      this.db,
      identity.tenantId,
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('jit', 'off', true)`;
        const actor = await c360CurrentActor(tx, identity);
        if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        return fn(tx, actor);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Get('overview/customers')
  @Header('Cache-Control', 'no-store')
  customers(@Req() req: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return this.read(req, query, (tx, actor) => countC360AccessibleDirectory(tx, actor));
  }
  @Get('overview/tags')
  @Header('Cache-Control', 'no-store')
  tags(@Req() req: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return this.read(req, query, async (tx, actor) => {
      if (!this.catalog.ready) throw new Customer360HttpError(503, 'CATALOG_UNAVAILABLE', true);
      return countC360CatalogTags(tx, actor.tenantId);
    });
  }
  @Get('field-rules')
  @Header('Cache-Control', 'no-store')
  rules(@Req() req: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return this.read(req, query, async () => {
      if (!this.writer.ready) throw new Customer360HttpError(503, 'RULES_UNAVAILABLE', true);
      return { ...c360ProfileFieldRules(), asOf: new Date().toISOString() };
    });
  }
}
