/**
 * Owner: Agent Workspace — work-session lease (E1.9 #483)
 *
 * Authority: E1.3 #459, Phase Contract E1.8 #464, ADR-026 ข้อ 2
 *
 * - lease 1 อันต่อ agent ต่อ tenant ครอบทุก surface (`workspace | dphone | embedded` + host origin)
 *   — partial unique index ใน DB กัน race ข้าม API instance
 * - TTL 60 วินาที ต่ออายุด้วย heartbeat ทุก 20 วินาทีผ่าน `/api/v1/workspace-session`
 * - lease ไม่หมดระหว่างมีงาน (interaction `ACTIVE`/`WRAPUP` ของ agent): หมดอายุได้เฉพาะตอนว่าง
 * - takeover ต้องส่ง `expectedLeaseId`, ห้ามระหว่างมีงาน, offer ที่รอกดรับถูกส่งกลับเข้าคิว + audit
 * - ปล่อยหรือหมดอายุตอนว่าง = presence เป็น OFFLINE (router หยุดส่งงาน)
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export const WORK_SESSION_TTL_MS = 60_000;
export const WORK_SESSION_HEARTBEAT_MS = 20_000;
export const WORK_SESSION_FLAG = 'workSession.lease.enforced';
export const WORK_SESSION_SURFACES = ['workspace', 'dphone', 'embedded'] as const;
export type WorkSessionSurface = (typeof WORK_SESSION_SURFACES)[number];
export type LeaseReleaseReason = 'released' | 'takeover' | 'expired' | 'auth_revoked';

export type WorkSessionErrorCode =
  | 'VALIDATION_FAILED'
  | 'WORK_SESSION_HELD'
  | 'WORK_SESSION_BUSY'
  | 'WORK_SESSION_CHANGED'
  | 'AGENT_NOT_FOUND';

export interface WorkSessionHolder {
  leaseId: string;
  surface: WorkSessionSurface;
  hostOrigin: string | null;
  acquiredAt: string;
  busy: boolean;
}

export class WorkSessionError extends Error {
  constructor(
    readonly code: WorkSessionErrorCode,
    readonly holder?: WorkSessionHolder,
  ) {
    super(code);
    this.name = 'WorkSessionError';
  }
}

export interface WorkSessionLeaseView {
  leaseId: string;
  surface: WorkSessionSurface;
  hostOrigin: string | null;
  acquiredAt: string;
  expiresAt: string;
  ttlSeconds: number;
  heartbeatSeconds: number;
}

export type LeaseSignal =
  | { type: 'lease.revoked'; leaseId: string; reason: 'takeover' | 'auth_revoked' }
  | { type: 'lease.expired'; leaseId: string };

/** ส่งสัญญาณไปที่ socket ที่ผูก lease นั้นใน instance นี้ (instance อื่นรู้ตอน heartbeat ถัดไป) */
export interface LeaseSignalSink {
  signal(tenantId: string, userId: string, signal: LeaseSignal): void;
}

/** structured event สำหรับ metrics (log-based) — ไม่มี token/PII มีแค่ opaque id และ surface */
export interface WorkSessionDiagnostic {
  event:
    | 'work_session.acquired'
    | 'work_session.denied'
    | 'work_session.takeover'
    | 'work_session.released'
    | 'work_session.expired'
    | 'work_session.auth_revoked';
  tenantId: string;
  surface?: WorkSessionSurface;
  reason?: string;
  requeued?: number;
}

export interface WorkSessionActor {
  tenantId: string;
  userId: string;
}

export interface WorkSessionRequest {
  surface: WorkSessionSurface;
  hostOrigin: string | null;
}

type Tx = Prisma.TransactionClient;
type LeaseRow = {
  id: string;
  surface: string;
  host_origin: string | null;
  acquired_at: Date;
  expires_at: Date;
};

/** https exact origin (ไม่มี path/query/credential) ที่ normalize เป็นตัวเล็ก */
export function normalizeHostOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.origin !== value.replace(/\/$/, '').toLowerCase()) return null;
  return url.origin;
}

export function parseWorkSessionRequest(body: unknown): WorkSessionRequest {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const surface = input.surface;
  if (!(WORK_SESSION_SURFACES as readonly unknown[]).includes(surface)) {
    throw new WorkSessionError('VALIDATION_FAILED');
  }
  if (surface === 'embedded') {
    const hostOrigin = normalizeHostOrigin(input.hostOrigin);
    if (!hostOrigin) throw new WorkSessionError('VALIDATION_FAILED');
    return { surface, hostOrigin };
  }
  if (input.hostOrigin !== undefined && input.hostOrigin !== null) {
    throw new WorkSessionError('VALIDATION_FAILED');
  }
  return { surface: surface as WorkSessionSurface, hostOrigin: null };
}

export class WorkSessionLeases {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly flagCache = new Map<string, { enforced: boolean; until: number }>();
  /** สัญญาณที่รอส่งหลัง commit ของแต่ละ transaction — rollback = ไม่ส่ง */
  private readonly afterCommit = new WeakMap<Tx, Array<() => void>>();

  constructor(
    private readonly database: PrismaClient,
    private readonly options: {
      now?: () => Date;
      id?: () => string;
      signals?: LeaseSignalSink;
      diagnostics?: { write(event: WorkSessionDiagnostic): void };
      flagCacheMs?: number;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /** flag `workSession.lease.enforced` ของ tenant (ไม่มีแถว = ปิด) — cache สั้น */
  async enforced(tenantId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.flagCache.get(tenantId);
    if (cached && cached.until > now) return cached.enforced;
    const flag = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.tenantUiFlag.findUnique({
        where: { tenantId_flagKey: { tenantId, flagKey: WORK_SESSION_FLAG } },
        select: { enabled: true },
      }),
    );
    const enforced = flag?.enabled === true;
    this.flagCache.set(tenantId, { enforced, until: now + (this.options.flagCacheMs ?? 15_000) });
    return enforced;
  }

  async acquire(
    actor: WorkSessionActor,
    request: WorkSessionRequest,
    correlationId: string,
  ): Promise<WorkSessionLeaseView> {
    try {
      const view = await this.transaction(actor, async (tx) => {
        await this.requireAgent(tx, actor);
        const open = await this.lockOpen(tx, actor);
        if (open) {
          const busy = await this.busy(tx, actor);
          if (!this.lapsed(open, busy))
            throw new WorkSessionError('WORK_SESSION_HELD', holder(open, busy));
          await this.close(tx, actor, open, 'expired', correlationId);
        }
        return this.open(tx, actor, request, 'ACQUIRED', correlationId);
      });
      this.diagnose({
        event: 'work_session.acquired',
        tenantId: actor.tenantId,
        surface: request.surface,
      });
      return view;
    } catch (error) {
      // สอง instance ขอพร้อมกัน: partial unique index ชนะ — ตอบเหมือนมีผู้ถืออยู่
      if (isUniqueViolation(error)) {
        const current = await this.holderOf(actor);
        throw new WorkSessionError('WORK_SESSION_HELD', current ?? undefined);
      }
      if (error instanceof WorkSessionError && error.code === 'WORK_SESSION_HELD') {
        this.diagnose({
          event: 'work_session.denied',
          tenantId: actor.tenantId,
          reason: error.code,
        });
      }
      throw error;
    }
  }

  async takeover(
    actor: WorkSessionActor,
    request: WorkSessionRequest & { expectedLeaseId: string },
    correlationId: string,
  ): Promise<WorkSessionLeaseView> {
    let previous: LeaseRow | null = null;
    let requeued = 0;
    const view = await this.transaction(actor, async (tx) => {
      await this.requireAgent(tx, actor);
      const open = await this.lockOpen(tx, actor);
      if (!open || open.id !== request.expectedLeaseId)
        throw new WorkSessionError('WORK_SESSION_CHANGED');
      const busy = await this.busy(tx, actor);
      if (busy) throw new WorkSessionError('WORK_SESSION_BUSY', holder(open, busy));
      previous = open;
      requeued = await this.requeueOffers(tx, actor);
      await this.close(tx, actor, open, 'takeover', correlationId, { silent: true });
      return this.open(tx, actor, request, 'TAKEOVER', correlationId, { previous: open, requeued });
    });
    const replaced = previous as LeaseRow | null;
    if (replaced) {
      this.options.signals?.signal(actor.tenantId, actor.userId, {
        type: 'lease.revoked',
        leaseId: replaced.id,
        reason: 'takeover',
      });
    }
    this.diagnose({
      event: 'work_session.takeover',
      tenantId: actor.tenantId,
      surface: request.surface,
      requeued,
    });
    return view;
  }

  async release(actor: WorkSessionActor, leaseId: string, correlationId: string): Promise<void> {
    await this.transaction(actor, async (tx) => {
      const open = await this.lockOpen(tx, actor);
      if (!open || open.id !== leaseId) throw new WorkSessionError('WORK_SESSION_CHANGED');
      if (await this.busy(tx, actor))
        throw new WorkSessionError('WORK_SESSION_BUSY', holder(open, true));
      await this.close(tx, actor, open, 'released', correlationId);
    });
    this.diagnose({ event: 'work_session.released', tenantId: actor.tenantId });
  }

  /**
   * heartbeat ของ socket ที่ผูก lease — ต่ออายุเมื่อยัง active; lease ที่ถูกย้าย/ปล่อย/หมดอายุตอบสถานะนั้น
   * heartbeat ที่มาช้าเกิน TTL ตอนว่างถือว่าหมดอายุ (ไม่ชุบชีวิต)
   */
  async heartbeat(
    actor: WorkSessionActor,
    leaseId: string,
    correlationId = 'heartbeat',
  ): Promise<
    | { status: 'ACTIVE'; expiresAt: Date }
    | { status: 'REVOKED'; reason: 'takeover' | 'auth_revoked' | 'released' }
    | { status: 'EXPIRED' }
  > {
    return this.transaction(actor, async (tx) => {
      const open = await this.lockOpen(tx, actor);
      if (open && open.id === leaseId) {
        const busy = await this.busy(tx, actor);
        if (this.lapsed(open, busy)) {
          await this.close(tx, actor, open, 'expired', correlationId);
          return { status: 'EXPIRED' as const };
        }
        const expiresAt = new Date(this.now().getTime() + WORK_SESSION_TTL_MS);
        await tx.agentWorkSessionLease.update({
          where: { id: open.id },
          data: { heartbeatAt: this.now(), expiresAt },
        });
        return { status: 'ACTIVE' as const, expiresAt };
      }
      const closed = await tx.agentWorkSessionLease.findFirst({
        where: { id: leaseId, tenantId: actor.tenantId, userId: actor.userId },
        select: { releaseReason: true },
      });
      const reason = closed?.releaseReason;
      if (reason === 'takeover' || reason === 'auth_revoked' || reason === 'released') {
        return { status: 'REVOKED' as const, reason };
      }
      return { status: 'EXPIRED' as const };
    });
  }

  /** lease ยังเป็นของ agent คนนี้และยัง active อยู่ไหม (ใช้ตอนส่ง routing offer ให้ socket) */
  async isCurrent(actor: WorkSessionActor, leaseId: string): Promise<boolean> {
    return this.transaction(actor, async (tx) => {
      const open = await tx.agentWorkSessionLease.findFirst({
        where: { id: leaseId, tenantId: actor.tenantId, userId: actor.userId, releasedAt: null },
        select: { expiresAt: true },
      });
      if (!open) return false;
      return open.expiresAt > this.now() || (await this.busy(tx, actor));
    });
  }

  /**
   * token ถูกเพิกถอนระหว่างถือ lease: ว่าง = ปล่อยทันที (`auth_revoked`), มีงาน = คง lease ไว้จนงานจบ
   * (คุยต่อได้ ห้ามรับงานใหม่ — socket หยุดรับ offer เอง) แล้ว sweeper ปล่อยเมื่อหมดอายุ
   */
  async revokeForAuth(actor: WorkSessionActor, leaseId: string, correlationId: string) {
    const released = await this.transaction(actor, async (tx) => {
      const open = await this.lockOpen(tx, actor);
      if (!open || open.id !== leaseId) return false;
      if (await this.busy(tx, actor)) return false;
      await this.close(tx, actor, open, 'auth_revoked', correlationId);
      return true;
    });
    this.diagnose({
      event: 'work_session.auth_revoked',
      tenantId: actor.tenantId,
      reason: released ? 'released' : 'kept_until_work_ends',
    });
    return released;
  }

  /** ปล่อย lease ที่หมดอายุตอนว่างของทุก tenant — รันเป็นรอบใน API ทุก instance (CAS ด้วย row lock) */
  async sweep(): Promise<number> {
    const tenants = await this.database.tenant.findMany({
      where: { lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    });
    let expired = 0;
    for (const tenant of tenants) {
      const lapsed = await withTenantDatabaseTransaction(this.database, tenant.id, (tx) =>
        tx.agentWorkSessionLease.findMany({
          where: { tenantId: tenant.id, releasedAt: null, expiresAt: { lte: this.now() } },
          select: { userId: true, id: true },
        }),
      );
      for (const lease of lapsed) {
        const actor = { tenantId: tenant.id, userId: lease.userId };
        const closed = await this.transaction(actor, async (tx) => {
          const open = await this.lockOpen(tx, actor);
          if (!open || open.id !== lease.id) return false;
          if (!this.lapsed(open, await this.busy(tx, actor))) return false;
          await this.close(tx, actor, open, 'expired', `sweep:${lease.id}`);
          return true;
        });
        if (closed) expired += 1;
      }
    }
    return expired;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async transaction<T>(actor: WorkSessionActor, work: (tx: Tx) => Promise<T>): Promise<T> {
    const pending: Array<() => void> = [];
    const result = await withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) => {
      this.afterCommit.set(tx, pending);
      return work(tx);
    });
    for (const send of pending) send();
    return result;
  }

  private emitAfterCommit(tx: Tx, send: () => void) {
    const pending = this.afterCommit.get(tx);
    if (pending) pending.push(send);
    else send();
  }

  private async requireAgent(tx: Tx, actor: WorkSessionActor) {
    const agent = await tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, role: 'AGENT', isActive: true },
      select: { id: true },
    });
    if (!agent) throw new WorkSessionError('AGENT_NOT_FOUND');
  }

  /** lock แถวของ lease ที่ยังไม่ปล่อย — request ของ agent เดียวกันเข้าคิวกันที่นี่ */
  private async lockOpen(tx: Tx, actor: WorkSessionActor): Promise<LeaseRow | null> {
    const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      SELECT id, surface, host_origin, acquired_at, expires_at
      FROM agent_work_session_leases
      WHERE tenant_id = ${actor.tenantId}::uuid AND user_id = ${actor.userId}::uuid
        AND released_at IS NULL
      FOR UPDATE`);
    return rows[0] ?? null;
  }

  /** มีสายหรืองานค้าง (รวม wrap-up) — offer ที่ยังไม่กดรับไม่นับ (ถูกส่งกลับเข้าคิวตอน takeover) */
  private async busy(tx: Tx, actor: WorkSessionActor): Promise<boolean> {
    const active = await tx.interaction.count({
      where: {
        tenantId: actor.tenantId,
        agentId: actor.userId,
        state: { in: ['ACTIVE', 'WRAPUP'] },
      },
    });
    return active > 0;
  }

  private lapsed(lease: LeaseRow, busy: boolean): boolean {
    return !busy && lease.expires_at.getTime() <= this.now().getTime();
  }

  private async open(
    tx: Tx,
    actor: WorkSessionActor,
    request: WorkSessionRequest,
    action: 'ACQUIRED' | 'TAKEOVER',
    correlationId: string,
    takeover?: { previous: LeaseRow; requeued: number },
  ): Promise<WorkSessionLeaseView> {
    const now = this.now();
    const lease = await tx.agentWorkSessionLease.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        userId: actor.userId,
        surface: request.surface,
        hostOrigin: request.hostOrigin,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + WORK_SESSION_TTL_MS),
      },
    });
    await tx.agentWorkSessionEvent.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        userId: actor.userId,
        leaseId: lease.id,
        action,
        surface: request.surface,
        hostOrigin: request.hostOrigin,
        previousLeaseId: takeover?.previous.id ?? null,
        previousSurface: takeover?.previous.surface ?? null,
        requeuedInteractionCount: takeover?.requeued ?? 0,
        correlationId,
        occurredAt: now,
      },
    });
    return {
      leaseId: lease.id,
      surface: request.surface,
      hostOrigin: request.hostOrigin,
      acquiredAt: lease.acquiredAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
      ttlSeconds: WORK_SESSION_TTL_MS / 1000,
      heartbeatSeconds: WORK_SESSION_HEARTBEAT_MS / 1000,
    };
  }

  private async close(
    tx: Tx,
    actor: WorkSessionActor,
    lease: LeaseRow,
    reason: LeaseReleaseReason,
    correlationId: string,
    options: { silent?: boolean } = {},
  ) {
    const now = this.now();
    await tx.agentWorkSessionLease.update({
      where: { id: lease.id },
      data: { releasedAt: now, releaseReason: reason },
    });
    if (reason === 'takeover') return; // audit ของ takeover อยู่ในแถว TAKEOVER ของ lease ใหม่
    await tx.agentWorkSessionEvent.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        userId: actor.userId,
        leaseId: lease.id,
        action:
          reason === 'auth_revoked'
            ? 'AUTH_REVOKED'
            : reason === 'expired'
              ? 'EXPIRED'
              : 'RELEASED',
        surface: lease.surface,
        hostOrigin: lease.host_origin,
        correlationId,
        occurredAt: now,
      },
    });
    // ไม่มีจุดรับงานแล้ว — router หยุดส่งงานให้ agent คนนี้
    await tx.agentStateLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        state: 'OFFLINE',
        reason: `work_session_${reason}`,
      },
    });
    if (reason === 'expired' && !options.silent) {
      this.emitAfterCommit(tx, () => {
        this.options.signals?.signal(actor.tenantId, actor.userId, {
          type: 'lease.expired',
          leaseId: lease.id,
        });
        this.diagnose({
          event: 'work_session.expired',
          tenantId: actor.tenantId,
          surface: lease.surface as WorkSessionSurface,
        });
      });
    }
    if (reason === 'auth_revoked') {
      this.emitAfterCommit(tx, () =>
        this.options.signals?.signal(actor.tenantId, actor.userId, {
          type: 'lease.revoked',
          leaseId: lease.id,
          reason: 'auth_revoked',
        }),
      );
    }
  }

  /** offer ที่รอกดรับของ agent → กลับเข้าคิวทันที (router จ่ายใหม่ตาม `requeueAt`) */
  private async requeueOffers(tx: Tx, actor: WorkSessionActor): Promise<number> {
    const offers = await tx.interaction.findMany({
      where: { tenantId: actor.tenantId, agentId: actor.userId, state: 'ASSIGNED' },
      select: { id: true },
    });
    const now = this.now();
    let requeued = 0;
    for (const offer of offers) {
      const updated = await tx.interaction.updateMany({
        where: { id: offer.id, tenantId: actor.tenantId, agentId: actor.userId, state: 'ASSIGNED' },
        data: { state: 'QUEUED', agentId: null, offerExpiresAt: null, requeueAt: now },
      });
      if (updated.count === 0) continue;
      requeued += 1;
      await tx.interactionEvent.createMany({
        data: [
          {
            tenantId: actor.tenantId,
            interactionId: offer.id,
            type: 'interaction.offer_revoked',
            payload: { agentId: actor.userId, reason: 'work_session_takeover' },
          },
          {
            tenantId: actor.tenantId,
            interactionId: offer.id,
            type: 'interaction.queued',
            payload: { reason: 'work_session_takeover' },
          },
        ],
      });
    }
    if (requeued > 0) {
      await tx.agentStateLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          state: 'AVAILABLE',
          reason: 'work_session_takeover',
        },
      });
    }
    return requeued;
  }

  private async holderOf(actor: WorkSessionActor): Promise<WorkSessionHolder | null> {
    return this.transaction(actor, async (tx) => {
      const open = await tx.agentWorkSessionLease.findFirst({
        where: { tenantId: actor.tenantId, userId: actor.userId, releasedAt: null },
      });
      if (!open) return null;
      return holder(
        {
          id: open.id,
          surface: open.surface,
          host_origin: open.hostOrigin,
          acquired_at: open.acquiredAt,
          expires_at: open.expiresAt,
        },
        await this.busy(tx, actor),
      );
    });
  }

  private diagnose(event: WorkSessionDiagnostic) {
    this.options.diagnostics?.write(event);
  }
}

function holder(lease: LeaseRow, busy: boolean): WorkSessionHolder {
  return {
    leaseId: lease.id,
    surface: lease.surface as WorkSessionSurface,
    hostOrigin: lease.host_origin,
    acquiredAt: lease.acquired_at.toISOString(),
    busy,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error as { code?: string } | null)?.code === 'P2002' ||
    /agent_work_session_leases_one_open|unique constraint/i.test(String((error as Error)?.message))
  );
}
