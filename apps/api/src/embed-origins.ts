/**
 * Owner: Integrations — allowlist ของ origin ที่ฝัง dphone (E1.11 #485)
 *
 * Authority: E1.5 #461, Phase Contract E1.8 #464
 *
 * - ตัวตัดสินรูปแบบ origin คือ `normalizeEmbedOrigin` (ใช้ร่วมกับ Console) สูงสุด 10 ต่อ tenant
 * - ฝังได้เมื่อครบทั้ง 3: entitlement `module_api_cti` (`modules.api.cti`), flag `dphone.embed.enabled`
 *   และ origin อยู่ใน allowlist ที่ `enabled` — ขาดข้อใด = `frame-ancestors 'none'` (fail closed)
 * - tenant ที่ไม่มี plan binding เลย (ก่อน A1) ใช้กติกาเดียวกับ navigation (#451): ไม่ถูกตัดด้วย entitlement
 *   แต่ยังต้องเปิด flag ต่อ tenant เอง
 * - cache ผลของ shell ≤ 30 วินาที; ปิด/ลบ origin → ล้าง cache และแจ้ง iframe ผ่าน WS ทันที
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
    readonly field?: { field: string; reason: EmbedOriginRejection | 'REQUIRED' | 'INVALID' },
  ) {
    super(code);
    this.name = 'EmbedOriginError';
  }
}

export interface EmbedOriginView {
  id: string;
  origin: string;
  label: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** dphone ที่ฝังจาก origin นี้และยังถือ lease อยู่ — แสดงก่อนยืนยันปิด/ลบ */
  activeSessions: number;
}

export interface EmbedOriginActor {
  tenantId: string;
  userId: string;
}

/** ปิด/ลบ origin → iframe ที่ล็อก origin นั้นไว้ต้องหยุดรับ postMessage ทันที (E1.5 ข้อ 3) */
export interface EmbedOriginRevocationSink {
  revoked(tenantId: string, origin: string): void;
}

type Tx = Prisma.TransactionClient;
type Row = Prisma.TenantEmbedOriginGetPayload<object>;

export interface EmbedShellPolicy {
  tenantId: string;
  tenantAlias: string;
  /** ว่าง = ห้ามฝัง (`frame-ancestors 'none'`) */
  origins: string[];
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
      /** dev เท่านั้น: อนุญาต http://localhost และ 127.0.0.1 */
      allowLocalhost?: boolean;
      /** origin ของ D-Contact เอง (Workspace/Console/API) — ห้ามใส่ใน allowlist */
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
    input: { expectedRevision: unknown; label?: unknown; enabled?: unknown; reason?: unknown },
    correlationId: string,
  ): Promise<EmbedOriginView> {
    const expectedRevision = revisionOf(input.expectedRevision);
    const label = input.label === undefined ? undefined : requiredLabel(input.label);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'enabled', reason: 'INVALID' });
    }
    const enabled = input.enabled as boolean | undefined;
    if (label === undefined && enabled === undefined) {
      throw new EmbedOriginError('VALIDATION_FAILED', { field: 'body', reason: 'REQUIRED' });
    }
    const reason = optionalReason(input.reason);
    let revokedOrigin: string | null = null;
    const result = await this.transaction(actor, async (tx) => {
      const before = await this.locked(tx, actor, id, expectedRevision);
      // เปิดใหม่ต้องมี entitlement; ปิด/เปลี่ยนชื่อทำได้เสมอ (ทาง rollback)
      if (enabled === true && !before.enabled) await this.requireEntitlement(tx, actor.tenantId);
      const row = await tx.tenantEmbedOrigin.update({
        where: { id: before.id },
        data: {
          ...(label !== undefined ? { label } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          updatedAt: this.now(),
          revision: { increment: 1 },
        },
      });
      const action =
        enabled === false && before.enabled
          ? 'DISABLED'
          : enabled === true && !before.enabled
            ? 'ENABLED'
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
   * นโยบายของ `/dphone/embed?tenant=<alias>` — cache ≤ 30 วินาที; tenant ไม่มีอยู่/ไม่ ACTIVE,
   * ไม่มี entitlement, flag ปิด หรือ DB ใช้ไม่ได้ = ไม่มี origin (ห้ามฝัง)
   */
  async shellPolicy(alias: string): Promise<EmbedShellPolicy | null> {
    const key = alias.toLowerCase();
    const cached = this.shellCache.get(key);
    const nowMs = this.now().getTime();
    if (cached && cached.until > nowMs) return cached.policy;
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
          origins: (await this.embeddable(tx, tenant.id))
            ? (
                await tx.tenantEmbedOrigin.findMany({
                  where: { tenantId: tenant.id, enabled: true },
                  select: { origin: true },
                  orderBy: { origin: 'asc' },
                })
              ).map((row) => row.origin)
            : [],
        }));
      }
    } catch {
      policy = null; // fail closed — ไม่ cache ความล้มเหลว
      return null;
    }
    this.shellCache.set(key, {
      policy,
      until: nowMs + Math.min(this.options.cacheMs ?? 30_000, 30_000),
    });
    return policy;
  }

  /** lease ของ surface `embedded` ใช้ตรวจ host origin ซ้ำฝั่ง server (E1.5 ข้อ 5) — ไม่ใช้ cache */
  async isEmbeddable(tenantId: string, origin: string): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      if (!(await this.embeddable(tx, tenantId))) return false;
      const row = await tx.tenantEmbedOrigin.findFirst({
        where: { tenantId, origin, enabled: true },
        select: { id: true },
      });
      return Boolean(row);
    });
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
    action: 'CREATED' | 'UPDATED' | 'DISABLED' | 'ENABLED' | 'DELETED',
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
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activeSessions,
  };
}

function snapshot(row: Row): Prisma.InputJsonValue {
  return { origin: row.origin, label: row.label, enabled: row.enabled, revision: row.revision };
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
