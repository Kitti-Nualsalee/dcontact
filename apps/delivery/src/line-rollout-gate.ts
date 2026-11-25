/**
 * Owner: Delivery/Channels — rollout gate of the LINE simulation (S1.6, decision #100/#102)
 *
 * Deliberately separate from the delivery lifecycle: the gate decides "how far this scope may open the work station"
 * while the delivery lifecycle (`line-delivery-port.ts`) decides "how far this job has got"
 *
 * Maker-checker: the Tenant Admin proposes (`propose`) -> Compliance approves (`approve`), promoting
 * one step at a time DISABLED -> DRY_RUN -> SIMULATED_CAPPED_PILOT only. The Platform Operator controls the
 * technical switch independently — a switched-off switch forces the effective state to DISABLED always, however far the
 * business state has advanced. Compliance or the Platform Operator can order a kill immediately
 * without waiting for the other side, and kill beats every state always
 *
 * This is a test-harness authority model, not a production release API or a real IAM
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
    super(`actor role ${actorRole} is not permitted to ${action}`);
    this.name = 'LineGateAuthorizationError';
  }
}

export class LineGateScopeNotAllowedError extends Error {
  readonly code = 'LINE_GATE_SCOPE_NOT_ALLOWED';
  constructor(readonly scope: LineScopeTuple) {
    super(`this scope is not the frozen pilot tuple: ${scopeKey(scope)}`);
    this.name = 'LineGateScopeNotAllowedError';
  }
}

export class LineGateInvalidTransitionError extends Error {
  readonly code = 'LINE_GATE_INVALID_TRANSITION';
  constructor(
    readonly from: LineBusinessGateState,
    readonly to: LineBusinessGateState,
  ) {
    super(`the gate can be promoted one step at a time only: ${from} -> ${to}`);
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

  /** effective state: KILLED beats everything, the technical switch being off forces DISABLED */
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

  /** kill applies to every known scope (including a scope that cannot be specified, so the caller kills the whole pilot scope) */
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
   * A kill the system triggers itself (e.g. unknown-reconciling stuck beyond the threshold per #102 §6)
   * is not an actor's command — the same document says this is an automatic condition, not a decision
   * of Compliance/Platform Operator on that particular event
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
