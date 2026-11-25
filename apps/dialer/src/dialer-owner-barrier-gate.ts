/**
 * J2.9 — the rollout gate of the Dialer originate barrier (same maker-checker/kill-switch shape as
 * `apps/delivery/src/line-rollout-gate.ts` but scoped per tenant)
 *
 * The gate decides "how far the station may be opened", separate from `DialerOriginateBarrier`, which decides
 * "how far this originate has progressed". No state has real provider I/O — they differ in how far the barrier may go:
 *
 * - `SHADOW_RECEIPT` checks the current scope and stops
 * - `OWNER_CONFORMANCE` checks every owner-side condition then stops before reserving a Governance reservation
 * - `SCOPED_INTERNAL_ENABLED` reserves a reservation + TEST_ADAPTER originates only campaigns/queues in the allowlist
 *
 * J2.9 (#137) moves state/kill/audit into `ob_originate_rollout_*` instead of an in-memory `Map` — a kill
 * issued on one instance must stop every instance and survive a restart. The database also enforces with triggers that state
 * advances one step at a time, a kill cannot be undone (J2 has no authority to lift a kill switch per #124) and the audit is append-only.
 *
 * This is a development rollout authority model, not a production release API or real IAM.
 */
import {
  Prisma,
  type ObOriginateRolloutScopeKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export type DialerActorRole = 'TENANT_ADMIN' | 'COMPLIANCE' | 'PLATFORM_OPERATOR';

export type DialerBarrierBusinessState =
  'DISABLED' | 'SHADOW_RECEIPT' | 'OWNER_CONFORMANCE' | 'SCOPED_INTERNAL_ENABLED';

export type DialerBarrierEffectiveState = DialerBarrierBusinessState | 'KILLED';

export type DialerBarrierKillTrigger =
  | 'CROSS_TENANT_LEAK'
  | 'SCOPE_BYPASS'
  | 'RESERVATION_REUSE'
  | 'PROVIDER_TRAFFIC_DETECTED'
  | 'DUPLICATE_ORIGINATE';

export type DialerRolloutScopeKind = ObOriginateRolloutScopeKind;

export class DialerGateAuthorizationError extends Error {
  readonly code = 'DIALER_GATE_AUTHORIZATION_DENIED';
  constructor(
    readonly actorRole: DialerActorRole,
    readonly action: string,
  ) {
    super(`actor role ${actorRole} is not allowed to ${action}`);
    this.name = 'DialerGateAuthorizationError';
  }
}

export class DialerGateInvalidTransitionError extends Error {
  readonly code = 'DIALER_GATE_INVALID_TRANSITION';
  constructor(
    readonly from: DialerBarrierEffectiveState,
    readonly to: DialerBarrierBusinessState,
  ) {
    super(`the gate may only advance one step at a time: ${from} -> ${to}`);
    this.name = 'DialerGateInvalidTransitionError';
  }
}

/** maker-checker: the proposer and the approver must be different people, not merely different roles */
export class DialerGateSelfApprovalError extends Error {
  readonly code = 'DIALER_GATE_SELF_APPROVAL';
  constructor() {
    super('the approver must not be the proposer');
    this.name = 'DialerGateSelfApprovalError';
  }
}

export interface DialerGateActor {
  role: DialerActorRole;
  /** Opaque reference of the actor (e.g. a user id) — used to separate maker/checker and written to the audit */
  ref: string;
}

export interface DialerGateAuditEntry {
  tenantId: string;
  action: 'PROPOSE' | 'APPROVE' | 'KILL' | 'SCOPE_ALLOW' | 'SCOPE_REVOKE';
  actorRole: DialerActorRole;
  actorRef: string;
  detail: string;
  occurredAt: Date;
}

const ADVANCE_ORDER: DialerBarrierBusinessState[] = [
  'DISABLED',
  'SHADOW_RECEIPT',
  'OWNER_CONFORMANCE',
  'SCOPED_INTERNAL_ENABLED',
];

const SYSTEM_ACTOR_REF = 'system';

type Transaction = Prisma.TransactionClient;

export class DialerOwnerBarrierGate {
  constructor(private readonly database: PrismaClient) {}

  private run<T>(tenantId: string, work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, tenantId, work);
  }

  /** Locks the tenant row (created as DISABLED if missing) — every state change goes through here */
  private async lockedState(transaction: Transaction, tenantId: string) {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ob-originate-rollout:${tenantId}`}))`,
    );
    return (
      (await transaction.obOriginateRollout.findUnique({ where: { tenantId } })) ??
      transaction.obOriginateRollout.create({
        data: { tenantId, updatedByRef: SYSTEM_ACTOR_REF },
      })
    );
  }

  private audit(
    transaction: Transaction,
    tenantId: string,
    entry: Pick<DialerGateAuditEntry, 'action' | 'actorRole' | 'actorRef' | 'detail'>,
  ) {
    return transaction.obOriginateRolloutAudit.create({ data: { tenantId, ...entry } });
  }

  /** Effective state: KILLED always wins over every state; a tenant without a row is DISABLED (fail closed) */
  async currentState(tenantId: string): Promise<DialerBarrierEffectiveState> {
    const row = await this.run(tenantId, (transaction) =>
      transaction.obOriginateRollout.findUnique({
        where: { tenantId },
        select: { state: true, killed: true },
      }),
    );
    if (!row) return 'DISABLED';
    return row.killed ? 'KILLED' : row.state;
  }

  async killTriggerFor(tenantId: string): Promise<DialerBarrierKillTrigger | undefined> {
    const row = await this.run(tenantId, (transaction) =>
      transaction.obOriginateRollout.findUnique({
        where: { tenantId },
        select: { killTrigger: true },
      }),
    );
    return (row?.killTrigger as DialerBarrierKillTrigger | null) ?? undefined;
  }

  async propose(
    tenantId: string,
    actor: DialerGateActor,
    target: DialerBarrierBusinessState,
  ): Promise<void> {
    if (actor.role !== 'TENANT_ADMIN')
      throw new DialerGateAuthorizationError(actor.role, 'propose');
    await this.run(tenantId, async (transaction) => {
      const state = await this.lockedState(transaction, tenantId);
      if (state.killed) throw new DialerGateInvalidTransitionError('KILLED', target);
      if (ADVANCE_ORDER.indexOf(target) !== ADVANCE_ORDER.indexOf(state.state) + 1) {
        throw new DialerGateInvalidTransitionError(state.state, target);
      }
      await transaction.obOriginateRollout.update({
        where: { tenantId },
        data: {
          pendingState: target,
          pendingByRef: actor.ref,
          updatedByRef: actor.ref,
          version: { increment: 1 },
        },
      });
      await this.audit(transaction, tenantId, {
        action: 'PROPOSE',
        actorRole: actor.role,
        actorRef: actor.ref,
        detail: `${state.state}->${target}`,
      });
    });
  }

  async approve(tenantId: string, actor: DialerGateActor): Promise<void> {
    if (actor.role !== 'COMPLIANCE') throw new DialerGateAuthorizationError(actor.role, 'approve');
    await this.run(tenantId, async (transaction) => {
      const state = await this.lockedState(transaction, tenantId);
      if (state.killed || !state.pendingState) {
        throw new DialerGateInvalidTransitionError(
          state.killed ? 'KILLED' : state.state,
          state.state,
        );
      }
      if (state.pendingByRef === actor.ref) throw new DialerGateSelfApprovalError();
      await transaction.obOriginateRollout.update({
        where: { tenantId },
        data: {
          state: state.pendingState,
          pendingState: null,
          pendingByRef: null,
          updatedByRef: actor.ref,
          version: { increment: 1 },
        },
      });
      await this.audit(transaction, tenantId, {
        action: 'APPROVE',
        actorRole: actor.role,
        actorRef: actor.ref,
        detail: state.pendingState,
      });
    });
  }

  /** kill may be used by both Compliance and Platform Operator; it wins over every state at once without waiting for the other party */
  async kill(
    tenantId: string,
    actor: DialerGateActor,
    trigger: DialerBarrierKillTrigger,
  ): Promise<void> {
    if (actor.role !== 'COMPLIANCE' && actor.role !== 'PLATFORM_OPERATOR') {
      throw new DialerGateAuthorizationError(actor.role, 'kill');
    }
    await this.killAs(tenantId, actor, trigger, trigger);
  }

  /** A kill triggered by the system itself (e.g. a failed negative scan), not an actor command */
  async systemKill(tenantId: string, trigger: DialerBarrierKillTrigger): Promise<void> {
    await this.killAs(
      tenantId,
      { role: 'PLATFORM_OPERATOR', ref: SYSTEM_ACTOR_REF },
      trigger,
      `SYSTEM:${trigger}`,
    );
  }

  private async killAs(
    tenantId: string,
    actor: DialerGateActor,
    trigger: DialerBarrierKillTrigger,
    detail: string,
  ): Promise<void> {
    await this.run(tenantId, async (transaction) => {
      const state = await this.lockedState(transaction, tenantId);
      // A repeated kill is a no-op — the first trigger is the true cause and must not be overwritten
      if (!state.killed) {
        await transaction.obOriginateRollout.update({
          where: { tenantId },
          data: {
            killed: true,
            killTrigger: trigger,
            killedAt: new Date(),
            pendingState: null,
            pendingByRef: null,
            updatedByRef: actor.ref,
            version: { increment: 1 },
          },
        });
      }
      await this.audit(transaction, tenantId, {
        action: 'KILL',
        actorRole: actor.role,
        actorRef: actor.ref,
        detail,
      });
    });
  }

  /** Adds a scope that SCOPED_INTERNAL_ENABLED may originate — widening the scope therefore requires Compliance */
  async allowScope(
    tenantId: string,
    actor: DialerGateActor,
    scopeKind: DialerRolloutScopeKind,
    scopeRef: string,
  ): Promise<void> {
    if (actor.role !== 'COMPLIANCE')
      throw new DialerGateAuthorizationError(actor.role, 'allowScope');
    await this.run(tenantId, async (transaction) => {
      await transaction.obOriginateRolloutScope.upsert({
        where: { tenantId_scopeKind_scopeRef: { tenantId, scopeKind, scopeRef } },
        create: { tenantId, scopeKind, scopeRef, addedByRef: actor.ref },
        update: {},
      });
      await this.audit(transaction, tenantId, {
        action: 'SCOPE_ALLOW',
        actorRole: actor.role,
        actorRef: actor.ref,
        detail: `${scopeKind}:${scopeRef}`,
      });
    });
  }

  /** Revokes a scope — narrowing the scope is always safe; Compliance or Platform Operator can do it immediately */
  async revokeScope(
    tenantId: string,
    actor: DialerGateActor,
    scopeKind: DialerRolloutScopeKind,
    scopeRef: string,
  ): Promise<void> {
    if (actor.role !== 'COMPLIANCE' && actor.role !== 'PLATFORM_OPERATOR') {
      throw new DialerGateAuthorizationError(actor.role, 'revokeScope');
    }
    await this.run(tenantId, async (transaction) => {
      await transaction.obOriginateRolloutScope.deleteMany({
        where: { tenantId, scopeKind, scopeRef },
      });
      await this.audit(transaction, tenantId, {
        action: 'SCOPE_REVOKE',
        actorRole: actor.role,
        actorRef: actor.ref,
        detail: `${scopeKind}:${scopeRef}`,
      });
    });
  }

  async isScopeAllowed(
    tenantId: string,
    scopeKind: DialerRolloutScopeKind,
    scopeRef: string,
  ): Promise<boolean> {
    const row = await this.run(tenantId, (transaction) =>
      transaction.obOriginateRolloutScope.findUnique({
        where: { tenantId_scopeKind_scopeRef: { tenantId, scopeKind, scopeRef } },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async auditFor(tenantId: string): Promise<DialerGateAuditEntry[]> {
    const rows = await this.run(tenantId, (transaction) =>
      transaction.obOriginateRolloutAudit.findMany({
        where: { tenantId },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      tenantId: row.tenantId,
      action: row.action as DialerGateAuditEntry['action'],
      actorRole: row.actorRole as DialerActorRole,
      actorRef: row.actorRef,
      detail: row.detail,
      occurredAt: row.occurredAt,
    }));
  }
}
