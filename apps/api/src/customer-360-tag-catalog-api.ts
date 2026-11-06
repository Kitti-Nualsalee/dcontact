import {
  CUSTOMER_360_TAG_RUNTIME,
  type C360TagCatalogRuntime,
} from './customer-360-tag-runtime.js';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  C360TagNameError,
  C360ReadError,
  c360CursorCodecFromEnv,
  c360FilterDigest,
  c360ScopeDigest,
  C360_TAG_NORMALIZATION_VERSION,
  createC360CatalogTag,
  renameC360CatalogTag,
  retireC360CatalogTag,
  c360Uuid,
  executeC360ProfileCommand,
  normalizeC360TagName,
} from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  C360_RECEIPT_POLICY,
  C360_SEARCH_POLICY,
  C360_WRITE_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
  type SharedRateLimitInput,
} from './shared-rate-limiter.js';
import {
  CUSTOMER_360_DATABASE,
  Customer360Errors,
  Customer360HttpError,
  c360CurrentActor,
  commandActor,
  commandAuthorization,
  requestIdentity,
  send,
} from './customer-360-api.js';

/** M1-A catalog ของ tenant: ไม่ให้สิทธิ์อ่านหรือแก้ลูกค้าจากสิทธิ์จัดการแท็ก */
@UseFilters(Customer360Errors)
@Controller('api/v1/customer-360/tags')
@GatewayRoles('admin')
export class Customer360TagCatalogController {
  private readonly codec = c360CursorCodecFromEnv();
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private readonly limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_TAG_RUNTIME) private readonly runtime: C360TagCatalogRuntime,
  ) {}

  private ensureReady() {
    if (!this.runtime.ready) throw new Customer360HttpError(503, 'CATALOG_UNAVAILABLE', true);
  }

  private async lockActor(
    tx: Prisma.TransactionClient,
    identity: ReturnType<typeof requestIdentity>,
  ) {
    await tx.$queryRaw`SELECT id FROM users WHERE tenant_id = ${identity.tenantId}::uuid AND id = ${identity.userId}::uuid FOR SHARE NOWAIT`;
    const current = await c360CurrentActor(tx, identity);
    if (current.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
    return current;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    const identity = requestIdentity(req);
    this.ensureReady();
    if (Object.keys(query).some((key) => !['state', 'limit', 'cursor'].includes(key)))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const state = query.state === undefined ? 'ALL' : query.state;
    if (typeof state !== 'string' || !['ALL', 'ACTIVE', 'RETIRED'].includes(state))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const limitText = query.limit === undefined ? '50' : query.limit;
    if (typeof limitText !== 'string' || !/^[0-9]+$/.test(limitText))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const limit = Number(limitText);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor))
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    await this.budget(identity, C360_SEARCH_POLICY);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await this.lockActor(tx, identity);
      const context = {
        kind: 'tag-catalog',
        tenantId: identity.tenantId,
        userId: commandActor(identity).actorIdentityKey,
        filter: c360FilterDigest(['tags', state, String(limit)]),
        scope: c360ScopeDigest(actor),
      };
      let position: readonly string[] | null = null;
      if (typeof query.cursor === 'string') {
        try {
          position = this.codec.open(query.cursor, context, { distinguishScopeChange: true });
        } catch (error) {
          if (error instanceof C360ReadError) {
            const code = error.code === 'CURSOR_INVALID' ? 'INVALID_CURSOR' : error.code;
            throw new Customer360HttpError(error.code === 'CURSOR_INVALID' ? 400 : 409, code);
          }
          throw error;
        }
        if (position.length !== 2 || position[0]!.length > 512)
          throw new Customer360HttpError(400, 'INVALID_CURSOR');
        try {
          c360Uuid(position[1]);
        } catch {
          throw new Customer360HttpError(400, 'INVALID_CURSOR');
        }
      }
      const rows = await tx.$queryRaw<
        {
          id: string;
          name: string;
          name_key: string;
          state: string;
          revision: bigint;
          created_at: Date;
          retired_at: Date | null;
        }[]
      >(Prisma.sql`
        SELECT id, name, name_key, state, revision, created_at, retired_at FROM c360_tags
        WHERE tenant_id = ${identity.tenantId}::uuid
        ${state === 'ALL' ? Prisma.empty : Prisma.sql`AND state = ${state}`}
        ${position ? Prisma.sql`AND (name_key, id) > (${position[0]}, ${position[1]}::uuid)` : Prisma.empty}
        ORDER BY name_key COLLATE "C", id LIMIT ${limit + 1}`);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return {
        items: page.map((row) => ({
          id: row.id,
          name: row.name,
          state: row.state,
          revision: row.revision.toString(),
          createdAt: row.created_at,
          retiredAt: row.retired_at,
        })),
        nextCursor:
          rows.length > limit && last
            ? this.codec.seal({ ...context, position: [last.name_key, last.id] })
            : null,
        asOf: clock!.now.toISOString(),
      };
    });
  }

  private tagName(value: unknown): ReturnType<typeof normalizeC360TagName> {
    try {
      return normalizeC360TagName(value);
    } catch (error) {
      if (error instanceof C360TagNameError)
        throw new Customer360HttpError(400, 'VALIDATION_FAILED', false, undefined, [
          { field: 'name', code: error.code },
        ]);
      throw error;
    }
  }

  private async budget(
    identity: ReturnType<typeof requestIdentity>,
    policy: SharedRateLimitInput['policy'],
  ) {
    let result: { retryAfterSeconds: number } | null;
    try {
      result = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy,
      });
    } catch {
      throw new Customer360HttpError(503, 'LIMITER_UNAVAILABLE', true);
    }
    if (result) throw new Customer360HttpError(429, 'RATE_LIMITED', true, result.retryAfterSeconds);
  }

  @Post()
  async create(
    @Req() req: AuthenticatedGatewayRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureReady();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['commandId', 'name'].includes(key)))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const normalized = this.tagName(input.name);
    const actor = commandActor(identity);
    await this.budget(identity, C360_WRITE_POLICY);
    const result = await executeC360ProfileCommand(
      this.db,
      actor,
      {
        commandId: input.commandId,
        action: 'TAG_CREATE',
        resourceType: 'TAG',
        resourceId: null,
        expectedRevisions: {},
        normalizationContractVersion: C360_TAG_NORMALIZATION_VERSION,
        normalizedRequest: normalized,
      },
      commandAuthorization(identity),
      async (tx, command) => {
        await this.lockActor(tx, identity);
        return createC360CatalogTag(tx, actor, command, normalized);
      },
    );
    send(response, result);
  }

  @Patch(':tagId')
  async rename(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureReady();
    const id = c360Uuid(tagId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !['commandId', 'expectedRevision', 'name'].includes(key)) ||
      typeof input.expectedRevision !== 'string'
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const normalized = this.tagName(input.name);
    const revision = input.expectedRevision;
    await this.budget(identity, C360_WRITE_POLICY);
    const result = await executeC360ProfileCommand(
      this.db,
      commandActor(identity),
      {
        commandId: input.commandId,
        action: 'TAG_RENAME',
        resourceType: 'TAG',
        resourceId: id,
        expectedRevisions: { tag: revision },
        normalizationContractVersion: C360_TAG_NORMALIZATION_VERSION,
        normalizedRequest: normalized,
      },
      commandAuthorization(identity),
      async (tx) => {
        await this.lockActor(tx, identity);
        return renameC360CatalogTag(tx, identity.tenantId, id, revision, normalized);
      },
    );
    send(response, result);
  }

  @Post(':tagId/retire')
  async retire(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('tagId') tagId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const identity = requestIdentity(req);
    this.ensureReady();
    const id = c360Uuid(tagId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !['commandId', 'expectedRevision'].includes(key)) ||
      typeof input.expectedRevision !== 'string'
    )
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const revision = input.expectedRevision;
    await this.budget(identity, C360_WRITE_POLICY);
    const result = await executeC360ProfileCommand(
      this.db,
      commandActor(identity),
      {
        commandId: input.commandId,
        action: 'TAG_RETIRE',
        resourceType: 'TAG',
        resourceId: id,
        expectedRevisions: { tag: revision },
        normalizationContractVersion: C360_TAG_NORMALIZATION_VERSION,
        normalizedRequest: {},
      },
      commandAuthorization(identity),
      async (tx) => {
        await this.lockActor(tx, identity);
        return retireC360CatalogTag(tx, identity.tenantId, id, revision);
      },
    );
    send(response, result);
  }

  @Get(':tagId')
  @Header('Cache-Control', 'no-store')
  async detail(@Req() req: AuthenticatedGatewayRequest, @Param('tagId') tagId: string) {
    const identity = requestIdentity(req);
    this.ensureReady();
    const id = c360Uuid(tagId);
    await this.budget(identity, C360_RECEIPT_POLICY);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN') throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const tag = await tx.c360Tag.findFirst({
        where: { tenantId: identity.tenantId, id },
        select: {
          id: true,
          name: true,
          state: true,
          revision: true,
          createdAt: true,
          retiredAt: true,
        },
      });
      if (!tag) throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return { ...tag, revision: tag.revision.toString(), asOf: clock!.now.toISOString() };
    });
  }
}
