/**
 * J2.9 — rollout gate ของ Dialer originate barrier (mirrors
 * `apps/delivery/src/line-rollout-gate.ts`'s maker-checker/kill-switch shape,
 * scoped per tenant แทน LINE pilot tuple เพราะ J2.9 ไม่มี allowlist requirement)
 *
 * Gate ตัดสินว่า "เปิดสถานีทำงานได้แค่ไหน" แยกจาก `DialerOriginateBarrier` ที่ตัดสินว่า
 * "originate ใบนี้ไปถึงไหนแล้ว" ทุก state (รวม SCOPED_INTERNAL_ENABLED) ไม่มี provider I/O
 * จริง — ความต่างระหว่าง state คือขอบเขตที่ยอมให้ barrier ทำงาน ไม่ใช่ transport ที่ต่างกัน
 */
export type DialerActorRole = 'TENANT_ADMIN' | 'COMPLIANCE' | 'PLATFORM_OPERATOR';

export type DialerBarrierBusinessState =
  | 'DISABLED'
  | 'SHADOW_RECEIPT'
  | 'OWNER_CONFORMANCE'
  | 'SCOPED_INTERNAL_ENABLED';

export type DialerBarrierEffectiveState = DialerBarrierBusinessState | 'KILLED';

export type DialerBarrierKillTrigger =
  | 'CROSS_TENANT_LEAK'
  | 'SCOPE_BYPASS'
  | 'RESERVATION_REUSE'
  | 'PROVIDER_TRAFFIC_DETECTED'
  | 'DUPLICATE_ORIGINATE';

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
    readonly from: DialerBarrierBusinessState,
    readonly to: DialerBarrierBusinessState,
  ) {
    super(`เลื่อน gate ทีละขั้นเท่านั้น: ${from} -> ${to}`);
    this.name = 'DialerGateInvalidTransitionError';
  }
}

const ADVANCE_ORDER: DialerBarrierBusinessState[] = [
  'DISABLED',
  'SHADOW_RECEIPT',
  'OWNER_CONFORMANCE',
  'SCOPED_INTERNAL_ENABLED',
];

interface TenantGateState {
  businessState: DialerBarrierBusinessState;
  killed: boolean;
  killTrigger?: DialerBarrierKillTrigger;
  pendingProposal?: DialerBarrierBusinessState;
}

export interface DialerGateAuditEntry {
  tenantId: string;
  action: 'PROPOSE' | 'APPROVE' | 'KILL';
  actorRole: DialerActorRole;
  atMs: number;
  detail: string;
}

export class DialerOwnerBarrierGate {
  private readonly tenants = new Map<string, TenantGateState>();
  readonly audit: DialerGateAuditEntry[] = [];

  constructor(private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() }) {}

  private stateFor(tenantId: string): TenantGateState {
    let state = this.tenants.get(tenantId);
    if (!state) {
      state = { businessState: 'DISABLED', killed: false };
      this.tenants.set(tenantId, state);
    }
    return state;
  }

  private log(entry: Omit<DialerGateAuditEntry, 'atMs'>): void {
    this.audit.push({ ...entry, atMs: this.clock.nowMs() });
  }

  /** effective state: KILLED ชนะทุก state เสมอ */
  currentState(tenantId: string): DialerBarrierEffectiveState {
    const state = this.stateFor(tenantId);
    return state.killed ? 'KILLED' : state.businessState;
  }

  propose(
    tenantId: string,
    actorRole: DialerActorRole,
    target: DialerBarrierBusinessState,
  ): void {
    if (actorRole !== 'TENANT_ADMIN') throw new DialerGateAuthorizationError(actorRole, 'propose');
    const state = this.stateFor(tenantId);
    if (state.killed) throw new DialerGateInvalidTransitionError(state.businessState, target);
    const fromIndex = ADVANCE_ORDER.indexOf(state.businessState);
    const toIndex = ADVANCE_ORDER.indexOf(target);
    if (toIndex !== fromIndex + 1) {
      throw new DialerGateInvalidTransitionError(state.businessState, target);
    }
    state.pendingProposal = target;
    this.log({ tenantId, action: 'PROPOSE', actorRole, detail: `${state.businessState}->${target}` });
  }

  approve(tenantId: string, actorRole: DialerActorRole): void {
    if (actorRole !== 'COMPLIANCE') throw new DialerGateAuthorizationError(actorRole, 'approve');
    const state = this.stateFor(tenantId);
    if (state.killed || !state.pendingProposal) {
      throw new DialerGateInvalidTransitionError(state.businessState, state.businessState);
    }
    const target = state.pendingProposal;
    state.businessState = target;
    state.pendingProposal = undefined;
    this.log({ tenantId, action: 'APPROVE', actorRole, detail: target });
  }

  /** kill ใช้ได้ทั้ง Compliance และ Platform Operator; ชนะทุก state ทันทีไม่ต้องรออีกฝ่าย */
  kill(tenantId: string, actorRole: DialerActorRole, trigger: DialerBarrierKillTrigger): void {
    if (actorRole !== 'COMPLIANCE' && actorRole !== 'PLATFORM_OPERATOR') {
      throw new DialerGateAuthorizationError(actorRole, 'kill');
    }
    const state = this.stateFor(tenantId);
    state.killed = true;
    state.killTrigger = trigger;
    state.pendingProposal = undefined;
    this.log({ tenantId, action: 'KILL', actorRole, detail: trigger });
  }

  /** kill ที่ระบบ trigger เอง (เช่น negative scan ล้มเหลว) ไม่ใช่คำสั่งของ actor */
  systemKill(tenantId: string, trigger: DialerBarrierKillTrigger): void {
    const state = this.stateFor(tenantId);
    state.killed = true;
    state.killTrigger = trigger;
    state.pendingProposal = undefined;
    this.log({ tenantId, action: 'KILL', actorRole: 'PLATFORM_OPERATOR', detail: `SYSTEM:${trigger}` });
  }

  killTriggerFor(tenantId: string): DialerBarrierKillTrigger | undefined {
    return this.stateFor(tenantId).killTrigger;
  }
}
