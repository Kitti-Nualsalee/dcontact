/**
 * Owner: Delivery/Channels — rollout gate ของ LINE simulation (S1.6, decision #100/#102)
 *
 * แยกจาก delivery lifecycle โดยตั้งใจ: gate ตัดสินว่า scope นี้ "เปิดสถานีทำงานได้แค่ไหน"
 * ส่วน delivery lifecycle (`line-delivery-port.ts`) ตัดสินว่า "งานใบนี้ไปถึงไหนแล้ว"
 *
 * Maker-checker: Tenant Admin เสนอ (`propose`) -> Compliance อนุมัติ (`approve`) เลื่อนได้
 * ทีละขั้น DISABLED -> DRY_RUN -> SIMULATED_CAPPED_PILOT เท่านั้น Platform Operator คุม
 * technical switch แยกอิสระ — switch ปิดบังคับ effective state เป็น DISABLED เสมอไม่ว่า
 * business state จะเลื่อนไปถึงไหน Compliance หรือ Platform Operator สั่ง kill ได้ทันที
 * โดยไม่ต้องรออีกฝ่าย และ kill ชนะทุก state เสมอ
 *
 * นี่คือ test-harness authority model ไม่ใช่ production release API หรือ IAM จริง
 */
import { isAllowlistedScope, type LineScopeTuple, scopeKey } from './line-simulation-fixture.js';

export type LineActorRole = 'TENANT_ADMIN' | 'COMPLIANCE' | 'PLATFORM_OPERATOR';

export type LineBusinessGateState = 'DISABLED' | 'DRY_RUN' | 'SIMULATED_CAPPED_PILOT';
export type LineEffectiveGateState = LineBusinessGateState | 'KILLED';

export type LineKillTrigger =
  | 'CROSS_TENANT_LEAK'
  | 'RESTRICTION_BYPASS'
  | 'DUPLICATE_BUSINESS_EFFECT'
  | 'BLIND_RESEND'
  | 'PII_LEAK'
  | 'SETTLEMENT_STUCK'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'SLA_NO_PROGRESS'
  | 'UNKNOWN_RECONCILING_TIMEOUT';

export class LineGateAuthorizationError extends Error {
  readonly code = 'LINE_GATE_AUTHORIZATION_DENIED';
  constructor(
    readonly actorRole: LineActorRole,
    readonly action: string,
  ) {
    super(`actor role ${actorRole} ไม่มีสิทธิ ${action}`);
    this.name = 'LineGateAuthorizationError';
  }
}

export class LineGateScopeNotAllowedError extends Error {
  readonly code = 'LINE_GATE_SCOPE_NOT_ALLOWED';
  constructor(readonly scope: LineScopeTuple) {
    super(`scope นี้ไม่ใช่ pilot tuple ที่ freeze ไว้: ${scopeKey(scope)}`);
    this.name = 'LineGateScopeNotAllowedError';
  }
}

export class LineGateInvalidTransitionError extends Error {
  readonly code = 'LINE_GATE_INVALID_TRANSITION';
  constructor(
    readonly from: LineBusinessGateState,
    readonly to: LineBusinessGateState,
  ) {
    super(`เลื่อน gate ทีละขั้นเท่านั้น: ${from} -> ${to}`);
    this.name = 'LineGateInvalidTransitionError';
  }
}

const ADVANCE_ORDER: LineBusinessGateState[] = ['DISABLED', 'DRY_RUN', 'SIMULATED_CAPPED_PILOT'];

interface ScopeState {
  businessState: LineBusinessGateState;
  technicalSwitchOn: boolean;
  killed: boolean;
  killTrigger?: LineKillTrigger;
  pendingProposal?: LineBusinessGateState;
}

export interface LineGateAuditEntry {
  scope: LineScopeTuple;
  action: 'PROPOSE' | 'APPROVE' | 'TECHNICAL_SWITCH' | 'KILL';
  actorRole: LineActorRole;
  atMs: number;
  detail: string;
}

export class LineRolloutGate {
  private readonly scopes = new Map<string, ScopeState>();
  readonly audit: LineGateAuditEntry[] = [];

  constructor(private readonly clock: { nowMs(): number }) {}

  private stateFor(scope: LineScopeTuple): ScopeState {
    const key = scopeKey(scope);
    let state = this.scopes.get(key);
    if (!state) {
      state = { businessState: 'DISABLED', technicalSwitchOn: false, killed: false };
      this.scopes.set(key, state);
    }
    return state;
  }

  private requireAllowlisted(scope: LineScopeTuple): void {
    if (!isAllowlistedScope(scope)) throw new LineGateScopeNotAllowedError(scope);
  }

  private log(entry: Omit<LineGateAuditEntry, 'atMs'>): void {
    this.audit.push({ ...entry, atMs: this.clock.nowMs() });
  }

  /** effective state: KILLED ชนะทุกอย่าง, technical switch ปิดบังคับ DISABLED */
  currentState(scope: LineScopeTuple): LineEffectiveGateState {
    if (!isAllowlistedScope(scope)) return 'DISABLED';
    const state = this.stateFor(scope);
    if (state.killed) return 'KILLED';
    if (!state.technicalSwitchOn) return 'DISABLED';
    return state.businessState;
  }

  propose(scope: LineScopeTuple, actorRole: LineActorRole, target: LineBusinessGateState): void {
    if (actorRole !== 'TENANT_ADMIN') throw new LineGateAuthorizationError(actorRole, 'propose');
    this.requireAllowlisted(scope);
    const state = this.stateFor(scope);
    if (state.killed) throw new LineGateInvalidTransitionError(state.businessState, target);
    const fromIndex = ADVANCE_ORDER.indexOf(state.businessState);
    const toIndex = ADVANCE_ORDER.indexOf(target);
    if (toIndex !== fromIndex + 1)
      throw new LineGateInvalidTransitionError(state.businessState, target);
    state.pendingProposal = target;
    this.log({ scope, action: 'PROPOSE', actorRole, detail: `${state.businessState}->${target}` });
  }

  approve(scope: LineScopeTuple, actorRole: LineActorRole): void {
    if (actorRole !== 'COMPLIANCE') throw new LineGateAuthorizationError(actorRole, 'approve');
    this.requireAllowlisted(scope);
    const state = this.stateFor(scope);
    if (state.killed || !state.pendingProposal) {
      throw new LineGateInvalidTransitionError(state.businessState, state.businessState);
    }
    const target = state.pendingProposal;
    state.businessState = target;
    state.pendingProposal = undefined;
    this.log({ scope, action: 'APPROVE', actorRole, detail: target });
  }

  setTechnicalSwitch(scope: LineScopeTuple, actorRole: LineActorRole, enabled: boolean): void {
    if (actorRole !== 'PLATFORM_OPERATOR') {
      throw new LineGateAuthorizationError(actorRole, 'setTechnicalSwitch');
    }
    this.requireAllowlisted(scope);
    const state = this.stateFor(scope);
    state.technicalSwitchOn = enabled;
    this.log({ scope, action: 'TECHNICAL_SWITCH', actorRole, detail: String(enabled) });
  }

  /** kill ใช้ได้กับทุก scope ที่รู้จัก (รวม scope ที่ระบุไม่ได้ให้ caller kill ทั้ง pilot scope) */
  kill(scope: LineScopeTuple, actorRole: LineActorRole, trigger: LineKillTrigger): void {
    if (actorRole !== 'COMPLIANCE' && actorRole !== 'PLATFORM_OPERATOR') {
      throw new LineGateAuthorizationError(actorRole, 'kill');
    }
    const state = this.stateFor(scope);
    state.killed = true;
    state.killTrigger = trigger;
    state.pendingProposal = undefined;
    this.log({ scope, action: 'KILL', actorRole, detail: trigger });
  }

  killTriggerFor(scope: LineScopeTuple): LineKillTrigger | undefined {
    return this.stateFor(scope).killTrigger;
  }

  /**
   * Kill ที่ระบบ trigger เอง (เช่น unknown-reconciling ค้างเกิน threshold ตาม #102 §6)
   * ไม่ใช่คำสั่งของ actor — เอกสารเดียวกันระบุว่านี่เป็นเงื่อนไข automatic ไม่ใช่การตัดสินใจ
   * ของ Compliance/Platform Operator ต่อ event นั้น ๆ
   */
  systemKill(scope: LineScopeTuple, trigger: LineKillTrigger): void {
    const state = this.stateFor(scope);
    state.killed = true;
    state.killTrigger = trigger;
    state.pendingProposal = undefined;
    this.log({
      scope,
      action: 'KILL',
      actorRole: 'PLATFORM_OPERATOR',
      detail: `SYSTEM:${trigger}`,
    });
  }
}
