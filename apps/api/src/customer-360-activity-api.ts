import { Controller, Get, Header, Inject, Query, Req, UseFilters } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  C360ReadError,
  c360CursorCodecFromEnv,
  parseC360ActivityEvidence,
  readC360Activity,
} from '@d-contact/customer-360';
import {
  CUSTOMER_360_DATABASE,
  Customer360HttpError,
  c360CurrentActor,
  commandActor,
  requestIdentity,
} from './customer-360-api.js';
import { Customer360ReadErrors } from './customer-360-read-api.js';
import {
  CUSTOMER_360_TAG_RUNTIME,
  type C360TagCatalogRuntime,
} from './customer-360-tag-runtime.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  CUSTOMER_360_SEARCH_LIMITER,
  C360_SEARCH_POLICY,
  type SharedRateLimiter,
} from './shared-rate-limiter.js';

@UseFilters(Customer360ReadErrors)
@Controller('api/v1/customer-360')
@GatewayRoles('admin')
export class Customer360ActivityController {
  private readonly codec = c360CursorCodecFromEnv();
  private readonly evidence = parseC360ActivityEvidence(
    process.env.C360_ACTIVITY_EVIDENCE_MANIFEST,
  );
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_TAG_RUNTIME) private readonly runtime: C360TagCatalogRuntime,
  ) {}

  @Get('activity')
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    const identity = requestIdentity(req);
    let rejected;
    try {
      rejected = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy: C360_SEARCH_POLICY,
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
        const actor = await c360CurrentActor(tx, identity);
        if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
        if (!this.runtime.ready) throw new Customer360HttpError(503, 'AUDIT_UNAVAILABLE', true);
        try {
          await tx.$queryRaw`SELECT set_config('jit', 'off', true), set_config('statement_timeout', '2s', true)`;
          return await readC360Activity(
            tx,
            actor,
            commandActor(identity).actorIdentityKey,
            query,
            this.codec,
            this.evidence,
            new Date(),
          );
        } catch (error) {
          if (error instanceof C360ReadError) throw error;
          throw new Customer360HttpError(503, 'AUDIT_UNAVAILABLE', true);
        }
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
