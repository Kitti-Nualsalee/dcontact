/**
 * J2.9 — rollout gate ของ Dialer originate barrier (maker-checker/kill-switch shape เดียวกับ
 * `apps/delivery/src/line-rollout-gate.ts` แต่ scoped ต่อ tenant)
 *
 * Gate ตัดสินว่า "เปิดสถานีทำงานได้แค่ไหน" แยกจาก `DialerOriginateBarrier` ที่ตัดสินว่า
 * "originate ใบนี้ไปถึงไหนแล้ว" ทุก state ไม่มี provider I/O จริง — ต่างกันที่ barrier เดินไปได้ไกลแค่ไหน:
 *
 * - `SHADOW_RECEIPT` ตรวจ current scope แล้วหยุด
 * - `OWNER_CONFORMANCE` ตรวจเงื่อนไขฝั่ง owner ครบแล้วหยุดก่อนจอง Governance reservation
 * - `SCOPED_INTERNAL_ENABLED` จอง reservation + TEST_ADAPTER originate เฉพาะ campaign/queue ใน allowlist
 *
 * J2.9 (#137) ย้าย state/kill/audit มาไว้ใน `ob_originate_rollout_*` แทน `Map` ในหน่วยความจำ — kill ที่
 * สั่งบน instance หนึ่งต้องหยุดทุก instance และไม่หายตอน restart ฐานข้อมูลบังคับซ้ำด้วย trigger ว่า state
 * เดินหน้าทีละขั้น kill ยกเลิกไม่ได้ (J2 ไม่มีสิทธิ์ยก kill switch ตาม #124) และ audit เป็น append-only
 *
 * นี่คือ development rollout authority model ไม่ใช่ production release API หรือ IAM จริง
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
    super(`actor role ${actorRole} ไม่มีสิทธิ ${action}`);
    this.name = 'DialerGateAuthorizationError';
  }
}

export class DialerGateInvalidTransitionError extends Error {
  readonly code = 'DIALER_GATE_INVALID_TRANSITION';
  constructor(
    readonly from: DialerBarrierEffectiveState,
    readonly to: DialerBarrierBusinessState,
  ) {
    super(`เลื่อน gate ทีละขั้นเท่านั้น: ${from} -> ${to}`);
    this.name = 'DialerGateInvalidTransitionError';
  }
}

/** maker-checker: คนเสนอกับคนอนุมัติต้องเป็นคนละคน ไม่ใช่แค่คนละ role */
export class DialerGateSelfApprovalError extends Error {
  readonly code = 'DIALER_GATE_SELF_APPROVAL';
  constructor() {
    super('ผู้อนุมัติต้องไม่ใช่ผู้เสนอ');
    this.name = 'DialerGateSelfApprovalError';
  }
}

export interface DialerGateActor {
  role: DialerActorRole;
  /** opaque reference ของผู้กระทำ (เช่น user id) — ใช้แยก maker/checker และลง audit */
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

  /** ล็อกแถวของ tenant (สร้างเป็น DISABLED ถ้ายังไม่มี) — การเปลี่ยน state ทุกทางผ่านจุดนี้ */
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

  /** effective state: KILLED ชนะทุก state เสมอ; tenant ที่ไม่มีแถวคือ DISABLED (fail closed) */
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

  /** kill ใช้ได้ทั้ง Compliance และ Platform Operator; ชนะทุก state ทันทีไม่ต้องรออีกฝ่าย */
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

  /** kill ที่ระบบ trigger เอง (เช่น negative scan ล้มเหลว) ไม่ใช่คำสั่งของ actor */
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
      // kill ซ้ำเป็น no-op — trigger แรกคือเหตุที่ถูกต้อง ห้ามเขียนทับ
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

  /** เพิ่ม scope ที่ SCOPED_INTERNAL_ENABLED originate ได้ — ขยายขอบเขตจึงต้องเป็น Compliance */
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

  /** ถอน scope — การลดขอบเขตปลอดภัยเสมอ Compliance หรือ Platform Operator สั่งได้ทันที */
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
