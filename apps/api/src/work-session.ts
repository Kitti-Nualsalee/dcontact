/**
 * Owner: Agent Workspace — work-session lease (E1.9 #483)
 *
 * Authority: E1.3 #459, Phase Contract E1.8 #464, ADR-026 item 2
 *
 * - one lease per agent per tenant across every surface (`workspace | dphone | embedded` + host origin)
 *   — a partial unique index in the DB prevents races across API instances
 * - TTL 60 seconds, renewed by a heartbeat every 20 seconds through `/api/v1/workspace-session`
 * - a lease does not expire while there is work (an `ACTIVE`/`WRAPUP` interaction of the agent): it can expire only when idle
 * - takeover must send `expectedLeaseId`, is forbidden during work, and a pending offer is returned to the queue + audit
 * - released or expired while idle = presence becomes OFFLINE (the router stops sending work)
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { WorkspaceMutationAuthBinding } from '@d-contact/workspace-session';
import { invalidateC360WorkAuthInTransaction } from './customer-360-work-auth.js';
import { normalizeEmbedOrigin } from '@d-contact/shared';

export const WORK_SESSION_TTL_MS = 60_000;
export const WORK_SESSION_HEARTBEAT_MS = 20_000;
export const WORK_SESSION_SURFACES = ['workspace', 'dphone', 'embedded'] as const;
export type WorkSessionSurface = (typeof WORK_SESSION_SURFACES)[number];
export type LeaseReleaseReason =
  'released' | 'takeover' | 'expired' | 'auth_revoked' | 'origin_revoked';

export type WorkSessionErrorCode =
  | 'VALIDATION_FAILED'
  | 'WORK_SESSION_HELD'
  | 'WORK_SESSION_BUSY'
  | 'WORK_SESSION_CHANGED'
  | 'AGENT_NOT_FOUND'
  /** E1.11: the host origin of an embedded surface is not in the tenant's effective allowlist */
  | 'EMBED_ORIGIN_NOT_ALLOWED';

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
  | {
      type: 'lease.revoked';
      leaseId: string;
      reason: 'takeover' | 'auth_revoked' | 'origin_revoked';
    }
  | { type: 'lease.expired'; leaseId: string };

/** sends a signal to the socket bound to that lease in this instance (other instances learn at the next heartbeat) */
export interface LeaseSignalSink {
  signal(tenantId: string, userId: string, signal: LeaseSignal): void;
}

export interface SipRegistrationRevocationSink {
  flush(input: {
    tenantId: string;
    extension: string;
    sipDomain: string;
    telephonyNodeId: string;
    workSessionLeaseId: string;
  }): void;
}

/** structured event for metrics (log-based) — no token/PII, only an opaque id and the surface */
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

/**
 * the host origin of an embedded surface: same format as the allowlist (E1.11) and must be sent already normalized
 * — localhost is accepted at this layer but usable only when it is in the allowlist (which accepts localhost in dev only)
 */
export function normalizeHostOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = normalizeEmbedOrigin(value, { allowLocalhost: true });
  if (!result.ok || result.origin !== value.replace(/\/$/, '')) return null;
  return result.origin;
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
  /** signals waiting to be sent after the commit of each transaction — rollback = not sent */
  private readonly afterCommit = new WeakMap<Tx, Array<() => void>>();

  constructor(
    private readonly database: PrismaClient,
    private readonly options: {
      now?: () => Date;
      id?: () => string;
      signals?: LeaseSignalSink;
      diagnostics?: { write(event: WorkSessionDiagnostic): void };
      /** E1.11: check the host origin of an embedded surface against the allowlist (unset = embedded not allowed) */
      embedOrigins?: { isEmbeddable(tenantId: string, origin: string): Promise<boolean> };
      /** E1.10: revoke the credential in the same transaction, then flush the registration after commit */
      sipRegistrations?: SipRegistrationRevocationSink;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /**
   * #583 (#582): every tenant enforces the work-session lease — the `workSession.lease.enforced` flag no longer exists
   * (SIP credentials have been issued only to the lease holder since E1.10 #551; a tenant that turned the flag off could not receive calls)
   */
  async enforced(_tenantId: string): Promise<boolean> {
    return true;
  }

  /**
   * E1.12 (#486): the state a client reads before requesting a lease — the tenant flag + the current holder (read-only, no lock)
   * a lease that expired while idle but that the sweeper has not yet closed counts as having no holder (acquire gets a lease immediately)
   */
  async status(
    actor: WorkSessionActor,
  ): Promise<{ enforced: boolean; holder: WorkSessionHolder | null }> {
    const enforced = await this.enforced(actor.tenantId);
    const current = await this.transaction(actor, async (tx) => {
      await this.requireAgent(tx, actor);
      const open = await tx.agentWorkSessionLease.findFirst({
        where: { tenantId: actor.tenantId, userId: actor.userId, releasedAt: null },
      });
      if (!open) return null;
      const row: LeaseRow = {
        id: open.id,
        surface: open.surface,
        host_origin: open.hostOrigin,
        acquired_at: open.acquiredAt,
        expires_at: open.expiresAt,
      };
      const busy = await this.busy(tx, actor);
      return this.lapsed(row, busy) ? null : holder(row, busy);
    });
    return { enforced, holder: current };
  }

  async acquire(
    actor: WorkSessionActor,
    request: WorkSessionRequest,
    correlationId: string,
  ): Promise<WorkSessionLeaseView> {
    await this.requireEmbeddable(actor, request);
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
      // two instances ask at once: the partial unique index wins — answer as if a holder exists
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
    await this.requireEmbeddable(actor, request);
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
   * heartbeat of the socket bound to the lease — renews while active; a lease that was moved/released/expired answers with that state
   * a heartbeat that arrives later than the TTL while idle counts as expired (not revived)
   */
  async heartbeat(
    actor: WorkSessionActor,
    leaseId: string,
    correlationId = 'heartbeat',
  ): Promise<
    | { status: 'ACTIVE'; expiresAt: Date }
    | { status: 'REVOKED'; reason: 'takeover' | 'auth_revoked' | 'released' | 'origin_revoked' }
    | { status: 'EXPIRED' }
  > {
    const originRevoked = await this.originRevoked(actor, leaseId);
    return this.transaction(actor, async (tx) => {
      const open = await this.lockOpen(tx, actor);
      if (open && open.id === leaseId) {
        const busy = await this.busy(tx, actor);
        const account = await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: actor.userId, isActive: true, role: 'AGENT' },
          select: { id: true },
        });
        if (!account) {
          if (!busy) await this.close(tx, actor, open, 'auth_revoked', correlationId);
          return { status: 'REVOKED' as const, reason: 'auth_revoked' as const };
        }
        // origin disabled/removed: idle = release immediately, on a call = continue until it ends and then release (E1.5 item 3)
        if (originRevoked && !busy) {
          await this.close(tx, actor, open, 'origin_revoked', correlationId);
          return { status: 'REVOKED' as const, reason: 'origin_revoked' as const };
        }
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
      if (
        reason === 'takeover' ||
        reason === 'auth_revoked' ||
        reason === 'released' ||
        reason === 'origin_revoked'
      ) {
        return { status: 'REVOKED' as const, reason };
      }
      return { status: 'EXPIRED' as const };
    });
  }

  /** whether the lease still belongs to this agent and is still active (used when sending a routing offer to the socket) */
  async isCurrent(actor: WorkSessionActor, leaseId: string): Promise<boolean> {
    if (await this.originRevoked(actor, leaseId)) return false;
    return this.transaction(actor, async (tx) => {
      const account = await tx.user.findFirst({
        where: { tenantId: actor.tenantId, id: actor.userId, isActive: true, role: 'AGENT' },
        select: { id: true },
      });
      if (!account) return false;
      const open = await tx.agentWorkSessionLease.findFirst({
        where: { id: leaseId, tenantId: actor.tenantId, userId: actor.userId, releasedAt: null },
        select: { expiresAt: true },
      });
      if (!open) return false;
      return open.expiresAt > this.now() || (await this.busy(tx, actor));
    });
  }

  /**
   * E1.14: the host origin of a still-current `embedded` lease — used as the single source of the origin when sending data to the host
   * (does not trust an origin the browser sends itself); another lease/expired/origin revoked = null
   */
  async embeddedHostOrigin(actor: WorkSessionActor, leaseId: string): Promise<string | null> {
    if (!(await this.isCurrent(actor, leaseId))) return null;
    return this.transaction(actor, async (tx) => {
      const lease = await tx.agentWorkSessionLease.findFirst({
        where: { id: leaseId, tenantId: actor.tenantId, userId: actor.userId, surface: 'embedded' },
        select: { hostOrigin: true },
      });
      return lease?.hostOrigin ?? null;
    });
  }

  /**
   * token revoked while holding a lease: idle = release immediately (`auth_revoked`), has work = keep the lease until the work ends
   * (can continue but no new work — the socket stops accepting offers itself), then the sweeper releases it when it expires
   */
  async revokeForAuth(
    actor: WorkSessionActor,
    leaseId: string,
    correlationId: string,
    expected?: WorkspaceMutationAuthBinding,
  ) {
    const released = await this.transaction(actor, async (tx) => {
      const open = await this.lockOpen(tx, actor);
      if (!open || open.id !== leaseId) return false;
      const invalidated = await invalidateC360WorkAuthInTransaction(
        tx,
        { ...actor, leaseId },
        'AUTH_REVOKED',
        expected,
      );
      if (invalidated === 'stale' || (expected && invalidated === 'absent')) return false;
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

  /** releases leases that expired while idle for every tenant — runs as a loop in every API instance (CAS with a row lock) */
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

  private async requireEmbeddable(actor: WorkSessionActor, request: WorkSessionRequest) {
    if (request.surface !== 'embedded') return;
    const allowed =
      this.options.embedOrigins !== undefined &&
      (await this.options.embedOrigins.isEmbeddable(actor.tenantId, request.hostOrigin!));
    if (!allowed) throw new WorkSessionError('EMBED_ORIGIN_NOT_ALLOWED');
  }

  /** an embedded lease whose origin is no longer in the allowlist (checked outside the lease transaction) */
  private async originRevoked(actor: WorkSessionActor, leaseId: string): Promise<boolean> {
    const lease = await this.transaction(actor, (tx) =>
      tx.agentWorkSessionLease.findFirst({
        where: { id: leaseId, tenantId: actor.tenantId, userId: actor.userId, releasedAt: null },
        select: { surface: true, hostOrigin: true },
      }),
    );
    if (!lease || lease.surface !== 'embedded' || !lease.hostOrigin) return false;
    return !(
      this.options.embedOrigins !== undefined &&
      (await this.options.embedOrigins.isEmbeddable(actor.tenantId, lease.hostOrigin))
    );
  }

  private async requireAgent(tx: Tx, actor: WorkSessionActor) {
    const agent = await tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, role: 'AGENT', isActive: true },
      select: { id: true },
    });
    if (!agent) throw new WorkSessionError('AGENT_NOT_FOUND');
  }

  /** locks the row of a lease that has not been released — requests of the same agent queue here */
  private async lockOpen(tx: Tx, actor: WorkSessionActor): Promise<LeaseRow | null> {
    const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      SELECT id, surface, host_origin, acquired_at, expires_at
      FROM agent_work_session_leases
      WHERE tenant_id = ${actor.tenantId}::uuid AND user_id = ${actor.userId}::uuid
        AND released_at IS NULL
      FOR UPDATE`);
    return rows[0] ?? null;
  }

  /** has a call or pending work (including wrap-up) — an offer not yet accepted does not count (it is returned to the queue at takeover) */
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
    const sipCredential = await tx.agentSipCredential.findUnique({
      where: { workSessionLeaseId: lease.id },
      select: {
        extension: true,
        sipDomain: true,
        telephonyNodeId: true,
        revokedAt: true,
      },
    });
    if (sipCredential && !sipCredential.revokedAt) {
      await tx.agentSipCredential.update({
        where: { workSessionLeaseId: lease.id },
        data: { revokedAt: now },
      });
      this.emitAfterCommit(tx, () =>
        this.options.sipRegistrations?.flush({
          tenantId: actor.tenantId,
          extension: sipCredential.extension,
          sipDomain: sipCredential.sipDomain,
          telephonyNodeId: sipCredential.telephonyNodeId,
          workSessionLeaseId: lease.id,
        }),
      );
    }
    await tx.agentWorkSessionLease.update({
      where: { id: lease.id },
      data: { releasedAt: now, releaseReason: reason },
    });
    if (reason === 'takeover') return; // the takeover audit is in the TAKEOVER row of the new lease
    await tx.agentWorkSessionEvent.create({
      data: {
        id: this.id(),
        tenantId: actor.tenantId,
        userId: actor.userId,
        leaseId: lease.id,
        action:
          reason === 'auth_revoked'
            ? 'AUTH_REVOKED'
            : reason === 'origin_revoked'
              ? 'ORIGIN_REVOKED'
              : reason === 'expired'
                ? 'EXPIRED'
                : 'RELEASED',
        surface: lease.surface,
        hostOrigin: lease.host_origin,
        correlationId,
        occurredAt: now,
      },
    });
    // no more work endpoint — the router stops sending work to this agent
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
    if (reason === 'auth_revoked' || reason === 'origin_revoked') {
      this.emitAfterCommit(tx, () =>
        this.options.signals?.signal(actor.tenantId, actor.userId, {
          type: 'lease.revoked',
          leaseId: lease.id,
          reason,
        }),
      );
    }
  }

  /** a pending offer of the agent → back to the queue immediately (the router reassigns per `requeueAt`) */
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
