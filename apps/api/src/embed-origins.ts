/**
 * Owner: Integrations — the allowlist of origins that embed dphone (E1.11 #485)
 *
 * Authority: E1.5 #461, Phase Contract E1.8 #464
 *
 * - the origin format authority is `normalizeEmbedOrigin` (shared with the Console), max 10 per tenant
 * - embedding works only when all 3 hold: entitlement `module_api_cti` (`modules.api.cti`), flag `dphone.embed.enabled`
 *   and the origin is in an `enabled` allowlist — any missing = `frame-ancestors 'none'` (fail closed)
 * - a tenant with no plan binding at all (pre-A1) uses the same rule as navigation (#451): not cut by entitlement
 *   but the per-tenant flag must still be turned on
 * - shell result cache ≤ 30 seconds; disabling/deleting an origin → clears the cache and notifies the iframe through WS at once
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  MAX_EMBED_ORIGINS_PER_TENANT,
  normalizeEmbedOrigin,
  type EmbedOriginRejection,
} from '@d-contact/shared';
import { loadEntitlements } from './navigation-api.js';

export const DPHONE_EMBED_FLAG = 'dphone.embed.enabled';
export const EMBED_ENTITLEMENT = 'module_api_cti';

export type EmbedOriginErrorCode =
  | 'VALIDATION_FAILED'
  | 'ENTITLEMENT_REQUIRED'
  | 'EMBED_ORIGIN_LIMIT_REACHED'
  | 'EMBED_ORIGIN_DUPLICATE'
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND';

export class EmbedOriginError extends Error {
  constructor(
    readonly code: EmbedOriginErrorCode,
    readonly field?: {
      field: string;
      reason: EmbedOriginRejection | 'REQUIRED' | 'INVALID' | 'UNAVAILABLE';
    },
  ) {
    super(code);
    this.name = 'EmbedOriginError';
  }
}

/** E1.14: the screen-pop levels that can be set now — `custom` waits for a system-defined field list (decision gap #464) */
export type EmbedScreenPopLevel = 'off' | 'ids' | 'contact';
const SCREEN_POP_LEVELS: readonly EmbedScreenPopLevel[] = ['off', 'ids', 'contact'];

export interface EmbedOriginView {
  id: string;
  origin: string;
  label: string;
  enabled: boolean;
  screenPopLevel: EmbedScreenPopLevel;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** dphone embedded from this origin that still holds a lease — shown before confirming disable/delete */
  activeSessions: number;
}

export interface EmbedOriginActor {
  tenantId: string;
  userId: string;
}

/** disabling/deleting an origin → an iframe locked to that origin must stop accepting postMessage at once (E1.5 item 3) */
export interface EmbedOriginRevocationSink {
  revoked(tenantId: string, origin: string): void;
}

type Tx = Prisma.TransactionClient;
type Row = Prisma.TenantEmbedOriginGetPayload<object>;

export interface EmbedShellPolicy {
  tenantId: string;
  tenantAlias: string;
  /** empty = embedding forbidden (`frame-ancestors 'none'`) */
  origins: string[];
  /** E1.14: the screen-pop level per origin — the iframe uses it to tell the host in `dphone.ready` (the server rechecks when actually sending) */
  screenPopLevels: Record<string, EmbedScreenPopLevel>;
}

export class EmbedOriginService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly shellCache = new Map<
    string,
    { policy: EmbedShellPolicy | null; until: number }
  >();

  constructor(
    private readonly database: PrismaClient,
    private readonly options: {
      now?: () => Date;
      id?: () => string;
      /** dev only: allow http://localhost and 127.0.0.1 */
      allowLocalhost?: boolean;
      /** D-Contact's own origins (Workspace/Console/API) — must not go in the allowlist */
      reservedOrigins?: readonly string[];
      cacheMs?: number;
      revocations?: EmbedOriginRevocationSink;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  normalize(value: unknown): string {
    if (typeof value !== 'string') {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'origin', reason: 'REQUIRED' });
    }
    const result = normalizeEmbedOrigin(value, {
      allowLocalhost: this.options.allowLocalhost === true,
      reservedOrigins: this.options.reservedOrigins ?? [],
    });
    if (!result.ok) {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'origin', reason: result.reason });
    }
    return result.origin;
  }

  async list(actor: EmbedOriginActor) {
    return this.transaction(actor, async (tx) => {
      const rows = await tx.tenantEmbedOrigin.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const sessions = await this.activeSessions(tx, actor.tenantId);
      return {
        entitled: await this.entitled(tx, actor.tenantId),
        flagEnabled: await this.flagEnabled(tx, actor.tenantId),
        limit: MAX_EMBED_ORIGINS_PER_TENANT,
        origins: rows.map((row) => view(row, sessions.get(row.origin) ?? 0)),
      };
    });
  }

  async create(
    actor: EmbedOriginActor,
    input: { origin: unknown; label: unknown; reason?: unknown },
    correlationId: string,
  ): Promise<EmbedOriginView> {
    const origin = this.normalize(input.origin);
    const label = requiredLabel(input.label);
    const reason = optionalReason(input.reason);
    try {
      return await this.transaction(actor, async (tx) => {
        await this.requireEntitlement(tx, actor.tenantId);
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant_embed_origins:${actor.tenantId}`}))`,
        );
        const existing = await tx.tenantEmbedOrigin.count({ where: { tenantId: actor.tenantId } });
        if (existing >= MAX_EMBED_ORIGINS_PER_TENANT) {
          throw new EmbedOriginError('EMBED_ORIGIN_LIMIT_REACHED');
        }
        const now = this.now();
        const row = await tx.tenantEmbedOrigin.create({
          data: {
            id: this.id(),
            tenantId: actor.tenantId,
            origin,
            label,
            enabled: true,
            createdBy: actor.userId,
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.audit(tx, actor, row.id, 'CREATED', null, snapshot(row), reason, correlationId);
        return view(row, 0);
      });
    } catch (error) {
      if (isUnique(error)) throw new EmbedOriginError('EMBED_ORIGIN_DUPLICATE');
      if (/EMBED_ORIGIN_LIMIT_REACHED/.test(String((error as Error)?.message))) {
        throw new EmbedOriginError('EMBED_ORIGIN_LIMIT_REACHED');
      }
      throw error;
    } finally {
      this.invalidate(actor.tenantId);
    }
  }

  async update(
    actor: EmbedOriginActor,
    id: string,
    input: {
      expectedRevision: unknown;
      label?: unknown;
      enabled?: unknown;
      screenPopLevel?: unknown;
      reason?: unknown;
    },
    correlationId: string,
  ): Promise<EmbedOriginView> {
    const expectedRevision = revisionOf(input.expectedRevision);
    const label = input.label === undefined ? undefined : requiredLabel(input.label);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'enabled', reason: 'INVALID' });
    }
    const enabled = input.enabled as boolean | undefined;
    const screenPopLevel =
      input.screenPopLevel === undefined ? undefined : screenPopLevelOf(input.screenPopLevel);
    if (label === undefined && enabled === undefined && screenPopLevel === undefined) {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'body', reason: 'REQUIRED' });
    }
    // a data-level change is a separate audit (SCREEN_POP_CHANGED) — not merged with disabling/enabling an origin
    if (screenPopLevel !== undefined && enabled !== undefined) {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'body', reason: 'INVALID' });
    }
    const reason = optionalReason(input.reason);
    let revokedOrigin: string | null = null;
    const result = await this.transaction(actor, async (tx) => {
      const before = await this.locked(tx, actor, id, expectedRevision);
      // enabling again needs the entitlement; disabling/renaming is always allowed (the rollback path)
      if (enabled === true && !before.enabled) await this.requireEntitlement(tx, actor.tenantId);
      const levelChanged = screenPopLevel !== undefined && screenPopLevel !== before.screenPopLevel;
      // enabling or changing the data level must be confirmed with a reason (E1.6 item 1)
      if (levelChanged && (reason === null || reason.length < 3)) {
        throw new EmbedOriginError('VALIDATION_FAILED', { field: 'reason', reason: 'REQUIRED' });
      }
      const row = await tx.tenantEmbedOrigin.update({
        where: { id: before.id },
        data: {
          ...(label !== undefined ? { label } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(levelChanged ? { screenPopLevel } : {}),
          updatedAt: this.now(),
          revision: { increment: 1 },
        },
      });
      const action =
        enabled === false && before.enabled
          ? 'DISABLED'
          : enabled === true && !before.enabled
            ? 'ENABLED'
            : levelChanged
              ? 'SCREEN_POP_CHANGED'
              : 'UPDATED';
      await this.audit(
        tx,
        actor,
        row.id,
        action,
        snapshot(before),
        snapshot(row),
        reason,
        correlationId,
      );
      if (action === 'DISABLED') revokedOrigin = row.origin;
      const sessions = await this.activeSessions(tx, actor.tenantId);
      return view(row, sessions.get(row.origin) ?? 0);
    });
    this.invalidate(actor.tenantId);
    if (revokedOrigin) this.options.revocations?.revoked(actor.tenantId, revokedOrigin);
    return result;
  }

  async remove(
    actor: EmbedOriginActor,
    id: string,
    input: { expectedRevision: unknown; reason?: unknown },
    correlationId: string,
  ): Promise<void> {
    const expectedRevision = revisionOf(input.expectedRevision);
    const reason = optionalReason(input.reason);
    const origin = await this.transaction(actor, async (tx) => {
      const before = await this.locked(tx, actor, id, expectedRevision);
      await tx.tenantEmbedOrigin.delete({ where: { id: before.id } });
      await this.audit(
        tx,
        actor,
        before.id,
        'DELETED',
        snapshot(before),
        null,
        reason,
        correlationId,
      );
      return before.origin;
    });
    this.invalidate(actor.tenantId);
    this.options.revocations?.revoked(actor.tenantId, origin);
  }

  /**
   * policy of `/dphone/embed?tenant=<alias>` — cache ≤ 30 seconds; a tenant that does not exist/is not ACTIVE,
   * has no entitlement, flag off or an unusable DB = no origin (embedding forbidden)
   */
  async shellPolicy(
    alias: string,
    options: { fresh?: boolean } = {},
  ): Promise<EmbedShellPolicy | null> {
    const key = alias.toLowerCase();
    const cached = this.shellCache.get(key);
    const nowMs = this.now().getTime();
    if (!options.fresh && cached && cached.until > nowMs) return cached.policy;
    let policy: EmbedShellPolicy | null = null;
    try {
      const tenant = await this.database.tenant.findUnique({
        where: { slug: key },
        select: { id: true, slug: true, lifecycleStatus: true },
      });
      if (tenant && tenant.lifecycleStatus === 'ACTIVE') {
        policy = await withTenantDatabaseTransaction(this.database, tenant.id, async (tx) => ({
          tenantId: tenant.id,
          tenantAlias: tenant.slug,
          ...(await this.enabledOrigins(tx, tenant.id)),
        }));
      }
    } catch {
      policy = null; // fail closed — failures are not cached
      return null;
    }
    this.shellCache.set(key, {
      policy,
      until: nowMs + Math.min(this.options.cacheMs ?? 30_000, 30_000),
    });
    return policy;
  }

  /**
   * E1.14: the screen-pop level of the origin at actual send time (no cache) — can no longer embed/not in the allowlist = `off`
   */
  async screenPopLevel(tenantId: string, origin: string): Promise<EmbedScreenPopLevel> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      if (!(await this.embeddable(tx, tenantId))) return 'off';
      const row = await tx.tenantEmbedOrigin.findFirst({
        where: { tenantId, origin, enabled: true },
        select: { screenPopLevel: true },
      });
      return row ? levelOf(row.screenPopLevel) : 'off';
    });
  }

  /** the lease of the `embedded` surface is used to recheck the host origin on the server side (E1.5 item 5) — no cache */
  async isEmbeddable(tenantId: string, origin: string): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      this.isEmbeddableInTransaction(tx, tenantId, origin),
    );
  }

  async isEmbeddableInTransaction(tx: Tx, tenantId: string, origin: string): Promise<boolean> {
    if (!(await this.embeddable(tx, tenantId))) return false;
    const row = await tx.tenantEmbedOrigin.findFirst({
      where: { tenantId, origin, enabled: true },
      select: { id: true },
    });
    return Boolean(row);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private transaction<T>(actor: EmbedOriginActor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, work);
  }

  private invalidate(tenantId: string) {
    for (const [key, entry] of this.shellCache) {
      if (entry.policy === null || entry.policy.tenantId === tenantId) this.shellCache.delete(key);
    }
  }

  private async entitled(tx: Tx, tenantId: string): Promise<boolean> {
    const entitlements = await loadEntitlements(tx, tenantId);
    return entitlements === null || entitlements[EMBED_ENTITLEMENT] === true;
  }

  private async flagEnabled(tx: Tx, tenantId: string): Promise<boolean> {
    const flag = await tx.tenantUiFlag.findUnique({
      where: { tenantId_flagKey: { tenantId, flagKey: DPHONE_EMBED_FLAG } },
      select: { enabled: true },
    });
    return flag?.enabled === true;
  }

  private async embeddable(tx: Tx, tenantId: string): Promise<boolean> {
    return (await this.entitled(tx, tenantId)) && (await this.flagEnabled(tx, tenantId));
  }

  private async enabledOrigins(
    tx: Tx,
    tenantId: string,
  ): Promise<Pick<EmbedShellPolicy, 'origins' | 'screenPopLevels'>> {
    if (!(await this.embeddable(tx, tenantId))) return { origins: [], screenPopLevels: {} };
    const rows = await tx.tenantEmbedOrigin.findMany({
      where: { tenantId, enabled: true },
      select: { origin: true, screenPopLevel: true },
      orderBy: { origin: 'asc' },
    });
    return {
      origins: rows.map((row) => row.origin),
      screenPopLevels: Object.fromEntries(
        rows.map((row) => [row.origin, levelOf(row.screenPopLevel)]),
      ),
    };
  }

  private async requireEntitlement(tx: Tx, tenantId: string) {
    if (!(await this.entitled(tx, tenantId))) throw new EmbedOriginError('ENTITLEMENT_REQUIRED');
  }

  private async locked(tx: Tx, actor: EmbedOriginActor, id: string, expectedRevision: number) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM tenant_embed_origins
      WHERE id = ${id}::uuid AND tenant_id = ${actor.tenantId}::uuid FOR UPDATE`);
    if (!rows[0]) throw new EmbedOriginError('NOT_FOUND');
    const row = await tx.tenantEmbedOrigin.findUniqueOrThrow({ where: { id } });
    if (row.revision !== expectedRevision) throw new EmbedOriginError('REVISION_CONFLICT');
    return row;
  }

  private async activeSessions(tx: Tx, tenantId: string): Promise<Map<string, number>> {
    const rows = await tx.agentWorkSessionLease.groupBy({
      by: ['hostOrigin'],
      where: { tenantId, surface: 'embedded', releasedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.hostOrigin ?? '', row._count._all]));
  }

  private async audit(
    tx: Tx,
    actor: EmbedOriginActor,
    originId: string,
    action: 'CREATED' | 'UPDATED' | 'DISABLED' | 'ENABLED' | 'DELETED' | 'SCREEN_POP_CHANGED',
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue | null,
    reason: string | null,
    correlationId: string,
  ) {
    await tx.tenantEmbedOriginAuditEvent.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        originId,
        action,
        before: before ?? Prisma.DbNull,
        after: after ?? Prisma.DbNull,
        actorUserId: actor.userId,
        reason,
        correlationId,
        occurredAt: this.now(),
      },
    });
  }
}

function view(row: Row, activeSessions: number): EmbedOriginView {
  return {
    id: row.id,
    origin: row.origin,
    label: row.label,
    enabled: row.enabled,
    screenPopLevel: levelOf(row.screenPopLevel),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activeSessions,
  };
}

function snapshot(row: Row): Prisma.InputJsonValue {
  return {
    origin: row.origin,
    label: row.label,
    enabled: row.enabled,
    screenPopLevel: row.screenPopLevel,
    revision: row.revision,
  };
}

/** an unknown value from the DB = off (fail closed) */
function levelOf(value: string): EmbedScreenPopLevel {
  return (SCREEN_POP_LEVELS as readonly string[]).includes(value)
    ? (value as EmbedScreenPopLevel)
    : 'off';
}

function screenPopLevelOf(value: unknown): EmbedScreenPopLevel {
  if (value === 'custom') {
    throw new EmbedOriginError('VALIDATION_FAILED', {
      field: 'screenPopLevel',
      reason: 'UNAVAILABLE',
    });
  }
  if (typeof value !== 'string' || !(SCREEN_POP_LEVELS as readonly string[]).includes(value)) {
    throw new EmbedOriginError('VALIDATION_FAILED', { field: 'screenPopLevel', reason: 'INVALID' });
  }
  return value as EmbedScreenPopLevel;
}

function requiredLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length < 1 || label.length > 80) {
    throw new EmbedOriginError('VALIDATION_FAILED', { field: 'label', reason: 'INVALID' });
  }
  return label;
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 500) {
    throw new EmbedOriginError('VALIDATION_FAILED', { field: 'reason', reason: 'INVALID' });
  }
  return value.trim() || null;
}

function revisionOf(value: unknown): number {
  const revision = typeof value === 'string' ? Number(value) : value;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new EmbedOriginError('VALIDATION_FAILED', {
      field: 'expectedRevision',
      reason: 'REQUIRED',
    });
  }
  return revision;
}

function isUnique(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}
