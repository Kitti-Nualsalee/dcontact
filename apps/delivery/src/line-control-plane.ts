/**
 * Owner: Delivery/Channels — durable control plane of the LINE pilot (S2.3 #367)
 *
 * Authority: rollout/security decision #358, account authority #356, Phase Contract #362 §9
 *
 * This is the `LineRolloutAuthority` of #362 §4: propose/approve/consume/kill/clearWithApproval.
 * All state is in Postgres, with no counter or latch in memory — a new instance after restart reads
 * the same truth in full, and two workers racing always yield exactly one winner because race safety comes from
 * the CAS/unique index/row lock of `LineControlRepository`, not from a check in this process.
 *
 * Order of the effective gate that must not be swapped (#358 §A) — any value missing/unreadable/mismatching = `DISABLED`:
 *   1. durable business state of the exact scope
 *   2. technical switch of the Platform Operator
 *   3. kill latch (beats every state)
 *   4. exact allowlist + config digest (recipient/content/config match on every dimension)
 *   5. credential that is ACTIVE and is the same version the run authorization pinned
 *   6. quota snapshot that is still fresh and sufficient (advisory — does not replace the durable cap)
 *   7. one-shot run authorization that is fully approved, not yet expired and not yet used
 * Only then is the cap reserved atomically; the CG3 recheck belongs to the caller (Governance owner) before crossing the barrier.
 *
 * This file has no provider I/O, no secret value and does not read environment variables — the quota snapshot
 * and the token verify result are inputs fed in by the transport owner (S2.4)
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  DlLineAllowlistEntry,
  DlLineAuditCategory,
  DlLineCapLedgerEntry,
  DlLineCredentialRef,
  DlLineRolloutState,
  DlLineRunAuthorization,
  DlLineScopeGate,
} from '@d-contact/db';
import {
  LINE_PILOT_CAPS,
  LINE_TEAM_TRIAL_CONTENT_CLASS,
  LINE_TEAM_TRIAL_MAX_CAPS,
  LINE_TEAM_TRIAL_PROFILE,
  type LineCapKind,
  type LineCredentialKind,
  type LineGateErrorCode,
  type LineKillReason,
} from '@d-contact/cxa-contracts';
import { assertOpaqueContentRef } from './evidence.js';
import type { LineAuditRepository } from './line-audit-repository.js';
import {
  type LineControlRepository,
  type LineGateScope,
  type ReserveLineCapResult,
} from './line-control-repository.js';
import {
  assertControlAuthority,
  allowsOperation,
  automaticKillReasonFor,
  evaluateQuotaAdvisory,
  isLowering,
  isSingleStepAdvance,
  isTeamTrialRun,
  lineCapLimits,
  lineDeliveryCapsFor,
  lineRunExpiry,
  lineTeamTrialExpiry,
  lineRunProposalDigest,
  needsProviderCredential,
  operatorKillReasonFor,
  type LineControlActorRole,
  type LineControlSignal,
  type LineProviderOperation,
  type LineQuotaSnapshot,
} from './line-control-policy.js';

export interface LineControlActor {
  role: LineControlActorRole;
  /** Opaque ref of the commander — not a customer email or LINE user ID (the DB CHECK rejects that form) */
  ref: string;
}

export type LineControlOutcome<T> =
  | { status: 'APPLIED'; value: T }
  | { status: 'STALE' }
  | { status: 'DENIED'; code: LineGateErrorCode };

export interface LineGateEvaluationRequest {
  scope: LineGateScope;
  operation: LineProviderOperation;
  at: Date;
  /** Required for every operation that touches the provider */
  configDigest?: string;
  quota?: LineQuotaSnapshot;
  /** Required for PUSH only — must match every value of the approved allowlist tuple */
  runAuthorizationId?: string;
  deliveryId?: string;
  recipientFingerprint?: string;
  contentDigest?: string;
}

export interface LineGateAllowed {
  status: 'ALLOWED';
  gate: DlLineScopeGate;
  credential?: DlLineCredentialRef;
  allowlistEntry?: DlLineAllowlistEntry;
  run?: DlLineRunAuthorization;
  /** true when this authorization was already consumed by this very delivery (replay after restart) */
  alreadyConsumed: boolean;
}

export interface LineGateDenied {
  status: 'DENIED';
  code: LineGateErrorCode;
  /** Signal that forces an automatic kill — only genuine contract-violating cases, not a scope outside the allowlist */
  signal?: LineControlSignal;
}

export type LineGateDecision = LineGateAllowed | LineGateDenied;

export interface LineRunGrant {
  status: 'AUTHORIZED';
  gate: DlLineScopeGate;
  run: DlLineRunAuthorization;
  allowlistEntry: DlLineAllowlistEntry;
  credential: DlLineCredentialRef;
  logicalDelivery: DlLineCapLedgerEntry;
  /**
   * `PRE` = has not crossed the barrier (release allowed), `POST` = the logical delivery unit is already committed;
   * a caller that gets `POST` after restart must go to exact-key reconciliation and must not submit again (#362 §11)
   */
  barrier: 'PRE' | 'POST';
  /** Only present at `PRE` — the concurrency slot being held */
  concurrencySlot?: DlLineCapLedgerEntry;
}

export type LineRunResult = LineRunGrant | LineGateDenied;

export interface RegisterLineAllowlistCommand {
  tenantId: string;
  gateId: string;
  scope: LineGateScope;
  recipientFingerprint: string;
  recipientProtectedRef: string;
  contentRef: string;
  contentDigest: string;
  configDigest: string;
  validFrom: Date;
  validUntil: Date;
  approvalAuditRef: string;
}

export interface RegisterLineCredentialCommand {
  tenantId: string;
  channelAccountId: string;
  credentialKind: LineCredentialKind;
  version: number;
  keychainService: string;
  keychainAccount: string;
  fingerprint: string;
  keyId?: string;
  issuedAt: Date;
  expiresAt?: Date;
  longLivedExceptionRef?: string;
}

/** Result of the token verify that the transport owner read from LINE — contains no token value */
export interface LineCredentialVerification {
  /** The `client_id` the provider answered with, must equal the Channel ID of the scope (#358 §G) */
  channelAccountId: string;
  verifiedAt: Date;
}

export interface ProposeLineRunCommand {
  tenantId: string;
  gate: DlLineScopeGate;
  allowlistEntry: DlLineAllowlistEntry;
  credential: DlLineCredentialRef;
  /** Ref the operator assigns to this run — lets the same binding be proposed again without colliding with one already used */
  proposalRef: string;
  proposedAt: Date;
  capProviderAttempts?: number;
}

/**
 * #567 (T3): propose one trial set — one authorization per recipient in the allowlist under a single `trialRef`.
 * Each recipient must have a contact in Contact Governance (consent is checked on every send)
 */
export interface ProposeLineTeamTrialCommand {
  tenantId: string;
  gate: DlLineScopeGate;
  credential: DlLineCredentialRef;
  recipients: ReadonlyArray<{
    allowlistEntry: DlLineAllowlistEntry;
    contactId: string;
    identityId?: string;
  }>;
  trialRef: string;
  proposedAt: Date;
  ttlDays: number;
  caps: {
    perRecipientPer24h: number;
    per24h: number;
    lifetime: number;
  };
  capProviderAttempts?: number;
}

export interface BeginLineRunCommand {
  tenantId: string;
  scope: LineGateScope;
  runAuthorizationId: string;
  deliveryId: string;
  recipientFingerprint: string;
  contentDigest: string;
  configDigest: string;
  quota?: LineQuotaSnapshot;
  at: Date;
}

const ACCESS_TOKEN_KINDS: readonly LineCredentialKind[] = [
  'CHANNEL_ACCESS_TOKEN_V2_1',
  'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
];

export interface LineControlPlaneOptions {
  control: LineControlRepository;
  audit: LineAuditRepository;
  /** Injectable to make tests deterministic; production uses `randomUUID` */
  newId?: () => string;
}

export class LineControlPlane {
  private readonly control: LineControlRepository;
  private readonly audit: LineAuditRepository;
  private readonly newId: () => string;

  constructor(options: LineControlPlaneOptions) {
    this.control = options.control;
    this.audit = options.audit;
    this.newId = options.newId ?? randomUUID;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  /**
   * eventId is constant per "the same command": replaying the same command with the same values returns the original row, while a different command
   * (different actor/different version) gets a different eventId, so both the winner and loser of a race are recorded in full
   */
  private async record(entry: {
    tenantId: string;
    category: DlLineAuditCategory;
    code: string;
    actor: LineControlActor;
    at: Date;
    subjectId?: string;
    deliveryId?: string;
    evidenceDigest?: string;
    /** Value that makes this command differ from other commands on the same subject */
    salt: readonly string[];
  }): Promise<void> {
    const salt = createHash('sha256')
      .update([entry.category, entry.code, entry.actor.ref, ...entry.salt].join('|'))
      .digest('hex')
      .slice(0, 16);
    await this.audit.append({
      id: this.newId(),
      tenantId: entry.tenantId,
      eventId: `s2.3.${entry.category.toLowerCase()}:${entry.subjectId ?? 'scope'}:${salt}`,
      category: entry.category,
      code: entry.code,
      actorKind: entry.actor.role,
      actorRef: entry.actor.ref,
      ...(entry.subjectId ? { subjectId: entry.subjectId } : {}),
      ...(entry.deliveryId ? { deliveryId: entry.deliveryId } : {}),
      ...(entry.evidenceDigest ? { evidenceDigest: entry.evidenceDigest } : {}),
      occurredAt: entry.at,
    });
  }

  // ── Gate lifecycle ────────────────────────────────────────────────────────

  /** Create the gate of the exact scope as DISABLED if it does not exist yet — idempotent for every caller */
  async ensureScope(actor: LineControlActor, scope: LineGateScope): Promise<DlLineScopeGate> {
    assertControlAuthority(actor.role, 'SET_TECHNICAL_SWITCH');
    return this.control.ensureGate(this.newId(), scope);
  }

  findGate(scope: LineGateScope): Promise<DlLineScopeGate | null> {
    return this.control.findGate(scope);
  }

  /** Look up the allowlist by exact tuple — the caller must know the full recipient/content/config to find it */
  findAllowlistEntry(
    tenantId: string,
    gateId: string,
    recipientFingerprint: string,
    contentDigest: string,
    configDigest: string,
  ): Promise<DlLineAllowlistEntry | null> {
    return this.control.findAllowlistEntryByTuple(
      tenantId,
      gateId,
      recipientFingerprint,
      contentDigest,
      configDigest,
    );
  }

  /**
   * Advance the business state one step at a time with Compliance approval (#358 §E) — from
   * `PROVIDER_CONFORMANCE` upward there must be a config digest that the allowlist/run authorization share
   */
  async advanceState(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    target: DlLineRolloutState,
    configDigest: string | null,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'ADVANCE_STATE');
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (!isSingleStepAdvance(gate.businessState, target)) {
      return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    }
    const digest = configDigest ?? gate.configDigest;
    if (target !== 'DRY_RUN' && !digest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      businessState: target,
      ...(digest === gate.configDigest ? {} : { configDigest: digest }),
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: `GATE_ADVANCED_${target}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /** Downgrading can be done immediately by Compliance or the Platform Operator (#358 §C) */
  async lowerState(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    target: DlLineRolloutState,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'LOWER_STATE');
    if (!isLowering(gate.businessState, target)) {
      return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    }
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      businessState: target,
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: `GATE_LOWERED_${target}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /** The technical switch belongs solely to the Platform Operator, and cannot be turned on for a scope that was killed */
  async setTechnicalSwitch(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    on: boolean,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'SET_TECHNICAL_SWITCH');
    if (on && gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    const updated = await this.control.compareAndSetGate(gate.tenantId, gate.id, gate.version, {
      technicalSwitchOn: on,
    });
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'GATE',
      code: on ? 'GATE_TECHNICAL_SWITCH_ON' : 'GATE_TECHNICAL_SWITCH_OFF',
      actor,
      at,
      subjectId: gate.id,
      salt: [String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  /**
   * kill latch: no need to know the version and it beats every state — the first call records the reason, later calls are a no-op
   * that still returns the latched gate. Audit records every commander, not only the one whose latch succeeded
   */
  async kill(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    reason: LineKillReason,
    at: Date,
  ): Promise<DlLineScopeGate> {
    assertControlAuthority(actor.role, 'KILL');
    const killed = await this.control.killGate(gate.tenantId, gate.id, reason, at);
    await this.record({
      tenantId: gate.tenantId,
      category: 'KILL',
      code: `KILL_${reason}`,
      actor,
      at,
      subjectId: gate.id,
      salt: [reason, at.toISOString()],
    });
    return killed;
  }

  /** A kill the system decides by itself (#358 §F) — the actor is `SYSTEM`, not a human decision */
  killOnSignal(
    gate: DlLineScopeGate,
    signal: LineControlSignal,
    at: Date,
  ): Promise<DlLineScopeGate> {
    return this.kill(
      { role: 'SYSTEM', ref: `system.${signal.toLowerCase()}` },
      gate,
      automaticKillReasonFor(signal),
      at,
    );
  }

  /** Human kill: the reason is bound to the commander's role so audit can distinguish operator/compliance */
  killByActor(actor: LineControlActor, gate: DlLineScopeGate, at: Date): Promise<DlLineScopeGate> {
    return this.kill(actor, gate, operatorKillReasonFor(actor.role), at);
  }

  /**
   * Lifting a kill must be done by Compliance and needs a new approval ref that cites remediation/evidence
   * (#358 §E) — a DB trigger enforces again that the ref must not repeat an old one and the state must return to `DISABLED`
   */
  async clearWithApproval(
    actor: LineControlActor,
    gate: DlLineScopeGate,
    killClearedRef: string,
    at: Date,
  ): Promise<LineControlOutcome<DlLineScopeGate>> {
    assertControlAuthority(actor.role, 'CLEAR_KILL');
    if (!gate.killed) return { status: 'DENIED', code: 'LINE_GATE_INVALID_TRANSITION' };
    if (killClearedRef === gate.killClearedRef) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    const updated = await this.control.clearGateKill(
      gate.tenantId,
      gate.id,
      gate.version,
      killClearedRef,
    );
    if (!updated) return { status: 'STALE' };
    await this.record({
      tenantId: gate.tenantId,
      category: 'KILL',
      code: 'KILL_CLEARED',
      actor,
      at,
      subjectId: gate.id,
      salt: [killClearedRef, String(updated.version)],
    });
    return { status: 'APPLIED', value: updated };
  }

  // ── Allowlist ─────────────────────────────────────────────────────────────

  /** The Tenant Admin confirms the recipient/purpose/content of the scope (#358 §E) */
  async registerAllowlistEntry(
    actor: LineControlActor,
    command: RegisterLineAllowlistCommand,
    at: Date,
  ): Promise<DlLineAllowlistEntry> {
    assertControlAuthority(actor.role, 'REGISTER_ALLOWLIST');
    assertOpaqueContentRef(command.contentRef);
    const entry = await this.control.addAllowlistEntry({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId: command.gateId,
      channelAccountId: command.scope.channelAccountId,
      senderIdentityId: command.scope.senderIdentityId,
      purpose: command.scope.purpose,
      contactKind: command.scope.contactKind,
      recipientFingerprint: command.recipientFingerprint,
      recipientProtectedRef: command.recipientProtectedRef,
      contentRef: command.contentRef,
      contentDigest: command.contentDigest,
      configDigest: command.configDigest,
      validFrom: command.validFrom,
      validUntil: command.validUntil,
      approvalAuditRef: command.approvalAuditRef,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'ALLOWLIST',
      code: 'ALLOWLIST_REGISTERED',
      actor,
      at,
      subjectId: entry.id,
      salt: [command.approvalAuditRef],
    });
    return entry;
  }

  async revokeAllowlistEntry(
    actor: LineControlActor,
    tenantId: string,
    id: string,
    revocationCode: string,
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'REVOKE_ALLOWLIST');
    const revoked = await this.control.revokeAllowlistEntry(tenantId, id, revocationCode, at);
    if (revoked) {
      await this.record({
        tenantId,
        category: 'ALLOWLIST',
        code: 'ALLOWLIST_REVOKED',
        actor,
        at,
        subjectId: id,
        salt: [revocationCode],
      });
    }
    return revoked;
  }

  // ── Credential metadata (#358 §G) ─────────────────────────────────────────

  /** Holds only a reference/metadata; the real value lives in the Keychain and passes only through `LineCredentialBoundary` */
  async registerCredential(
    actor: LineControlActor,
    command: RegisterLineCredentialCommand,
    at: Date,
  ): Promise<DlLineCredentialRef> {
    assertControlAuthority(actor.role, 'REGISTER_CREDENTIAL');
    const credential = await this.control.registerCredentialRef({
      id: this.newId(),
      ...command,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'CREDENTIAL',
      code: 'CREDENTIAL_REGISTERED',
      actor,
      at,
      subjectId: credential.id,
      salt: [command.credentialKind, String(command.version)],
    });
    return credential;
  }

  /**
   * Can activate only once verified and the `client_id` matches the Channel ID of that credential
   * (#358 §G) — a mismatch is a genuine auth failure signal: do not activate and the caller must kill the scope
   */
  async verifyAndActivateCredential(
    actor: LineControlActor,
    tenantId: string,
    credentialId: string,
    verification: LineCredentialVerification,
    at: Date,
  ): Promise<LineControlOutcome<DlLineCredentialRef> & { signal?: LineControlSignal }> {
    assertControlAuthority(actor.role, 'ACTIVATE_CREDENTIAL');
    const candidate = await this.control.findCredentialRef(tenantId, credentialId);
    if (!candidate) return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    if (candidate.channelAccountId !== verification.channelAccountId) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE', signal: 'AUTH_FAILURE' };
    }
    if (candidate.expiresAt !== null && candidate.expiresAt.getTime() <= at.getTime()) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    const activated = await this.control.activateCredentialRef(
      tenantId,
      credentialId,
      verification.verifiedAt,
      at,
    );
    if (!activated) return { status: 'STALE' };
    await this.record({
      tenantId,
      category: 'CREDENTIAL',
      code: 'CREDENTIAL_ACTIVATED',
      actor,
      at,
      subjectId: activated.id,
      salt: [String(activated.version)],
    });
    return { status: 'APPLIED', value: activated };
  }

  async revokeCredential(
    actor: LineControlActor,
    tenantId: string,
    credentialId: string,
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'REVOKE_CREDENTIAL');
    const revoked = await this.control.revokeCredentialRef(tenantId, credentialId, at);
    if (revoked) {
      await this.record({
        tenantId,
        category: 'CREDENTIAL',
        code: 'CREDENTIAL_REVOKED',
        actor,
        at,
        subjectId: credentialId,
        salt: [at.toISOString()],
      });
    }
    return revoked;
  }

  // ── Run authorization (#358 §E) ───────────────────────────────────────────

  /**
   * The proposal is immutable: the digest is computed from the whole binding the approver sees, so the executor
   * cannot change any value after approval while keeping the digest the same. caps/TTL are pinned directly from the profile
   */
  async proposeRun(
    actor: LineControlActor,
    command: ProposeLineRunCommand,
    at: Date,
  ): Promise<LineControlOutcome<DlLineRunAuthorization>> {
    assertControlAuthority(actor.role, 'PROPOSE_RUN');
    const { gate, allowlistEntry, credential } = command;
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (allowlistEntry.gateId !== gate.id || allowlistEntry.revokedAt) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    if (
      allowlistEntry.validFrom.getTime() > command.proposedAt.getTime() ||
      allowlistEntry.validUntil.getTime() <= command.proposedAt.getTime()
    ) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    if (gate.configDigest !== allowlistEntry.configDigest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    if (credential.status !== 'ACTIVE' || !ACCESS_TOKEN_KINDS.includes(credential.credentialKind)) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    const expiresAt = lineRunExpiry(command.proposedAt);
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= expiresAt.getTime()) {
      // A token that would expire before the authorization expires would let a worker cross the barrier with a dead token
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }

    const capProviderAttempts = Math.min(
      command.capProviderAttempts ?? LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
      LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
    );
    const proposalDigest = lineRunProposalDigest({
      tenantId: command.tenantId,
      gateId: gate.id,
      channelAccountId: gate.channelAccountId,
      senderIdentityId: gate.senderIdentityId,
      purpose: gate.purpose,
      contactKind: gate.contactKind,
      allowlistEntryId: allowlistEntry.id,
      recipientFingerprint: allowlistEntry.recipientFingerprint,
      contentDigest: allowlistEntry.contentDigest,
      configDigest: allowlistEntry.configDigest,
      credentialRefId: credential.id,
      credentialVersion: credential.version,
      capLogicalDeliveries: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
      capProviderAttempts,
      proposedBy: actor.ref,
      proposalRef: command.proposalRef,
      proposedAt: command.proposedAt,
      expiresAt,
    });

    const run = await this.control.proposeRun({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId: gate.id,
      allowlistEntryId: allowlistEntry.id,
      credentialRefId: credential.id,
      credentialVersion: credential.version,
      proposalDigest,
      configDigest: allowlistEntry.configDigest,
      capLogicalDeliveries: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
      capProviderAttempts,
      proposedBy: actor.ref,
      proposedAt: command.proposedAt,
      expiresAt,
    });
    await this.record({
      tenantId: command.tenantId,
      category: 'RUN_AUTHORIZATION',
      code: 'RUN_PROPOSED',
      actor,
      at,
      subjectId: run.id,
      salt: [proposalDigest],
    });
    return { status: 'APPLIED', value: run };
  }

  /**
   * #567 (T3): propose a whole trial — one authorization per recipient, usable for many deliveries until expiry (≤30 days).
   * The cap is in the row (not above `LINE_TEAM_TRIAL_MAX_CAPS`) and the allowlist must be the content class of the trial.
   * The same set is approved with `approveRun` row by row by the same person (the CLI `trial-approve` does it in one command).
   * Result: all-or-nothing across rows is not guaranteed — a row already created, proposed again with the same input, returns the same row
   */
  async proposeTeamTrial(
    actor: LineControlActor,
    command: ProposeLineTeamTrialCommand,
    at: Date,
  ): Promise<LineControlOutcome<DlLineRunAuthorization[]>> {
    assertControlAuthority(actor.role, 'PROPOSE_RUN');
    const { gate, credential } = command;
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (!/^trial-[0-9a-f-]{36}$/.test(command.trialRef)) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    const max = LINE_TEAM_TRIAL_MAX_CAPS;
    const { perRecipientPer24h, per24h, lifetime } = command.caps;
    if (
      command.recipients.length === 0 ||
      !(perRecipientPer24h >= 1 && perRecipientPer24h <= max.logicalDeliveriesPerRecipientPer24h) ||
      !(per24h >= 1 && per24h <= max.logicalDeliveriesPer24h) ||
      !(lifetime >= 1 && lifetime <= max.logicalDeliveriesLifetime)
    ) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    if (credential.status !== 'ACTIVE' || !ACCESS_TOKEN_KINDS.includes(credential.credentialKind)) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    const expiresAt = lineTeamTrialExpiry(command.proposedAt, command.ttlDays);
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= expiresAt.getTime()) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    for (const { allowlistEntry } of command.recipients) {
      if (
        allowlistEntry.gateId !== gate.id ||
        allowlistEntry.revokedAt ||
        allowlistEntry.contentRef !== LINE_TEAM_TRIAL_CONTENT_CLASS ||
        allowlistEntry.validFrom.getTime() > command.proposedAt.getTime() ||
        // The allowlist must cover the whole trial period, otherwise a recipient would silently drop out midway
        allowlistEntry.validUntil.getTime() < expiresAt.getTime()
      ) {
        return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
      }
      if (gate.configDigest !== allowlistEntry.configDigest) {
        return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
      }
    }

    const capProviderAttempts = Math.min(
      command.capProviderAttempts ?? max.providerAttemptsPerLogicalDelivery,
      max.providerAttemptsPerLogicalDelivery,
    );
    // One recipient can use at most 20/day × the number of days in the trial (and not above the per-run ceiling)
    const days = Math.ceil((expiresAt.getTime() - command.proposedAt.getTime()) / 86_400_000);
    const capLogicalDeliveries = Math.min(perRecipientPer24h * days, max.logicalDeliveriesPerRun);
    const runs: DlLineRunAuthorization[] = [];
    for (const recipient of command.recipients) {
      const { allowlistEntry } = recipient;
      const trial = {
        trialRef: command.trialRef,
        capRecipientPer24h: perRecipientPer24h,
        capPer24h: per24h,
        capLifetime: lifetime,
        contactId: recipient.contactId,
        identityId: recipient.identityId ?? null,
      };
      const proposalDigest = lineRunProposalDigest({
        tenantId: command.tenantId,
        gateId: gate.id,
        channelAccountId: gate.channelAccountId,
        senderIdentityId: gate.senderIdentityId,
        purpose: gate.purpose,
        contactKind: gate.contactKind,
        allowlistEntryId: allowlistEntry.id,
        recipientFingerprint: allowlistEntry.recipientFingerprint,
        contentDigest: allowlistEntry.contentDigest,
        configDigest: allowlistEntry.configDigest,
        credentialRefId: credential.id,
        credentialVersion: credential.version,
        capLogicalDeliveries,
        capProviderAttempts,
        proposedBy: actor.ref,
        proposalRef: `${command.trialRef}:${allowlistEntry.id}`,
        proposedAt: command.proposedAt,
        expiresAt,
        trial,
      });
      const run = await this.control.proposeRun({
        id: this.newId(),
        tenantId: command.tenantId,
        gateId: gate.id,
        allowlistEntryId: allowlistEntry.id,
        credentialRefId: credential.id,
        credentialVersion: credential.version,
        proposalDigest,
        configDigest: allowlistEntry.configDigest,
        capLogicalDeliveries,
        capProviderAttempts,
        proposedBy: actor.ref,
        proposedAt: command.proposedAt,
        expiresAt,
        profile: LINE_TEAM_TRIAL_PROFILE,
        capRecipientPer24h: perRecipientPer24h,
        capPer24h: per24h,
        capLifetime: lifetime,
        trialRef: command.trialRef,
        contactId: recipient.contactId,
        identityId: recipient.identityId ?? null,
      });
      await this.record({
        tenantId: command.tenantId,
        category: 'RUN_AUTHORIZATION',
        code: 'RUN_PROPOSED',
        actor,
        at,
        subjectId: run.id,
        salt: [proposalDigest],
      });
      runs.push(run);
    }
    return { status: 'APPLIED', value: runs };
  }

  /**
   * The proposer cannot approve their own (#358 §E) — one person may hold both Tenant Admin and Compliance
   * but must confirm twice separately, and must not be the same person as the proposer/executor
   */
  async approveRun(
    actor: LineControlActor,
    tenantId: string,
    runId: string,
    at: Date,
  ): Promise<LineControlOutcome<DlLineRunAuthorization>> {
    const action =
      actor.role === 'COMPLIANCE' ? 'APPROVE_RUN_COMPLIANCE' : 'APPROVE_RUN_TENANT_ADMIN';
    assertControlAuthority(actor.role, action);
    const run = await this.control.findRun(tenantId, runId);
    if (!run) return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.proposedBy === actor.ref) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    if (run.state !== 'PROPOSED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.expiresAt.getTime() < at.getTime()) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    }
    const approved = await this.control.approveRun(
      tenantId,
      runId,
      actor.role === 'COMPLIANCE' ? 'COMPLIANCE' : 'TENANT_ADMIN',
      actor.ref,
      at,
    );
    if (!approved) return { status: 'STALE' };
    await this.record({
      tenantId,
      category: 'RUN_AUTHORIZATION',
      code: actor.role === 'COMPLIANCE' ? 'RUN_APPROVED_COMPLIANCE' : 'RUN_APPROVED_TENANT_ADMIN',
      actor,
      at,
      subjectId: runId,
      salt: [run.proposalDigest],
    });
    return { status: 'APPLIED', value: approved };
  }

  async closeRun(
    actor: LineControlActor,
    tenantId: string,
    runId: string,
    state: 'EXPIRED' | 'REVOKED',
    at: Date,
  ): Promise<boolean> {
    assertControlAuthority(actor.role, 'CLOSE_RUN');
    const closed = await this.control.closeRun(tenantId, runId, state, at);
    if (closed) {
      await this.record({
        tenantId,
        category: 'RUN_AUTHORIZATION',
        code: `RUN_${state}`,
        actor,
        at,
        subjectId: runId,
        salt: [at.toISOString()],
      });
    }
    return closed;
  }

  // ── Fail-closed evaluation (#358 §A) ──────────────────────────────────────

  /**
   * read-only: changes no state so it can be called repeatedly at any point (preflight, after restart, before the barrier).
   * A rejection that is not the scope's fault returns a neutral code and does not reveal whether the gate/allowlist/recipient
   * really exists (#358 §B) — so the caller cannot use the code to discern another tenant's data
   */
  async evaluate(request: LineGateEvaluationRequest): Promise<LineGateDecision> {
    const gate = await this.control.findGate(request.scope);
    if (!gate) return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    if (!gate.technicalSwitchOn) {
      return { status: 'DENIED', code: 'LINE_GATE_TECHNICAL_SWITCH_OFF' };
    }
    if (!allowsOperation(gate.businessState, request.operation)) {
      return { status: 'DENIED', code: 'LINE_GATE_AUTHORIZATION_DENIED' };
    }
    if (!needsProviderCredential(request.operation)) {
      // DRY_RUN must really resolve/validate the allowlist when the caller specifies a recipient/content
      // (#358 §A) — the only difference is having no network I/O, not skipping the check
      if (request.recipientFingerprint !== undefined || request.contentDigest !== undefined) {
        const entry = await this.matchedAllowlistEntry(gate, request);
        if (!entry) return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
        return { status: 'ALLOWED', gate, allowlistEntry: entry, alreadyConsumed: false };
      }
      return { status: 'ALLOWED', gate, alreadyConsumed: false };
    }

    if (!gate.configDigest || gate.configDigest !== request.configDigest) {
      return { status: 'DENIED', code: 'CONFIG_DIGEST_MISMATCH' };
    }
    const credential = await this.control.findActiveCredentialRef(
      request.scope.tenantId,
      gate.channelAccountId,
      'ACCESS_TOKEN',
    );
    if (!credential) return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= request.at.getTime()) {
      return { status: 'DENIED', code: 'CREDENTIAL_UNAVAILABLE' };
    }

    const quota = evaluateQuotaAdvisory(request.quota, request.at);
    if (quota !== 'OK') {
      return {
        status: 'DENIED',
        code: 'LINE_GATE_AUTHORIZATION_DENIED',
        ...(quota === 'EXHAUSTED' ? { signal: 'QUOTA_EXHAUSTED' as const } : {}),
      };
    }

    if (request.operation !== 'PUSH') {
      return { status: 'ALLOWED', gate, credential, alreadyConsumed: false };
    }

    if (!request.runAuthorizationId || !request.recipientFingerprint || !request.contentDigest) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }
    const run = await this.control.findRun(request.scope.tenantId, request.runAuthorizationId);
    if (!run || run.gateId !== gate.id) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }
    if (run.configDigest !== gate.configDigest) {
      return {
        status: 'DENIED',
        code: 'CONFIG_DIGEST_MISMATCH',
        signal: 'ALLOWLIST_BINDING_MISMATCH',
      };
    }

    const allowlistEntry = await this.control.findAllowlistEntry(
      request.scope.tenantId,
      run.allowlistEntryId,
    );
    if (
      !allowlistEntry ||
      allowlistEntry.revokedAt ||
      allowlistEntry.validFrom.getTime() > request.at.getTime() ||
      allowlistEntry.validUntil.getTime() <= request.at.getTime()
    ) {
      return { status: 'DENIED', code: 'LINE_GATE_SCOPE_NOT_ALLOWED' };
    }
    // A binding mismatch inside an approved run is a genuine bypass, not an ordinary scope outside the allowlist
    if (
      allowlistEntry.recipientFingerprint !== request.recipientFingerprint ||
      allowlistEntry.contentDigest !== request.contentDigest ||
      allowlistEntry.configDigest !== request.configDigest
    ) {
      return {
        status: 'DENIED',
        code: 'LINE_GATE_SCOPE_NOT_ALLOWED',
        signal: 'ALLOWLIST_BINDING_MISMATCH',
      };
    }

    if (run.credentialRefId !== credential.id || run.credentialVersion !== credential.version) {
      return { status: 'DENIED', code: 'CREDENTIAL_VERSION_MISMATCH' };
    }

    if (run.state === 'CONSUMED') {
      if (request.deliveryId && run.consumedDeliveryId === request.deliveryId) {
        return { status: 'ALLOWED', gate, credential, allowlistEntry, run, alreadyConsumed: true };
      }
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_CONSUMED' };
    }
    if (run.state === 'EXPIRED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    if (run.state !== 'APPROVED') return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    if (run.expiresAt.getTime() < request.at.getTime()) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
    }

    return { status: 'ALLOWED', gate, credential, allowlistEntry, run, alreadyConsumed: false };
  }

  /** An allowlist that matches the tuple the caller really holds and is still within its usable period */
  private async matchedAllowlistEntry(
    gate: DlLineScopeGate,
    request: LineGateEvaluationRequest,
  ): Promise<DlLineAllowlistEntry | null> {
    if (!request.recipientFingerprint || !request.contentDigest || !request.configDigest) {
      return null;
    }
    const entry = await this.control.findAllowlistEntryByTuple(
      request.scope.tenantId,
      gate.id,
      request.recipientFingerprint,
      request.contentDigest,
      request.configDigest,
    );
    if (!entry || entry.revokedAt) return null;
    if (
      entry.validFrom.getTime() > request.at.getTime() ||
      entry.validUntil.getTime() <= request.at.getTime()
    ) {
      return null;
    }
    return entry;
  }

  // ── One-shot run + atomic caps ────────────────────────────────────────────

  /**
   * Barrier of the control plane: read the durable state in full first, then consume the one-shot.
   * Consuming before reserving is deliberate — a cap that rejects after consume burns the authorization
   * and forces a new propose/approve, which is the correct fail-closed side of the one-shot.
   *
   * Calling again with the same deliveryId after restart gives the same result: `evaluate` sees that the authorization was already
   * consumed by this delivery, so it skips `consumeRun` and the cap reservation and returns the original replay
   */
  async beginRun(actor: LineControlActor, command: BeginLineRunCommand): Promise<LineRunResult> {
    assertControlAuthority(actor.role, 'EXECUTE_RUN');
    const decision = await this.evaluate({
      scope: command.scope,
      operation: 'PUSH',
      at: command.at,
      configDigest: command.configDigest,
      quota: command.quota,
      runAuthorizationId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      recipientFingerprint: command.recipientFingerprint,
      contentDigest: command.contentDigest,
    });
    if (decision.status === 'DENIED') {
      return this.denyRun(actor, command, decision);
    }
    const { gate, run, allowlistEntry, credential } = decision;
    if (!run || !allowlistEntry || !credential) {
      return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
    }

    // unknown-reconciling stuck = auto-pause new work, but reconciliation of the old one keeps going
    const unknown = await this.control.listActiveCapEntries(
      command.tenantId,
      gate.id,
      'CONCURRENT_UNKNOWN',
    );
    if (unknown.some((entry) => entry.deliveryId !== command.deliveryId)) {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
      });
    }

    // #567: a trial is not a one-shot — no consume; each send is counted through the cap ledger per the cap in the row
    if (!decision.alreadyConsumed && !isTeamTrialRun(run)) {
      const consumed = await this.control.consumeRun(
        command.tenantId,
        run.id,
        command.deliveryId,
        command.at,
      );
      if (consumed.status === 'DENIED') {
        return this.denyRun(actor, command, { status: 'DENIED', code: consumed.code });
      }
      await this.record({
        tenantId: command.tenantId,
        category: 'RUN_AUTHORIZATION',
        code: 'RUN_CONSUMED',
        actor,
        at: command.at,
        subjectId: run.id,
        deliveryId: command.deliveryId,
        salt: [command.deliveryId],
      });
    }

    const logical = await this.reserve(command, gate.id, run.id, 'LOGICAL_DELIVERY', {
      runCapProviderAttempts: run.capProviderAttempts,
      deliveryCaps: lineDeliveryCapsFor(run),
    });
    if (logical.status === 'DENIED') {
      return this.denyRun(actor, command, { status: 'DENIED', code: logical.code });
    }
    // A delivery that was released and then woken again = cap counting can no longer be trusted (#358 §F)
    if (logical.entry.state === 'RELEASED') {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CAP_ACCOUNTING_INCONSISTENCY',
        signal: 'CAP_ACCOUNTING_INCONSISTENCY',
      });
    }
    // Restart after crossing the barrier: the unit is already committed, must not reserve a new slot and must not submit again
    if (logical.entry.state === 'COMMITTED') {
      return {
        status: 'AUTHORIZED',
        gate,
        run,
        allowlistEntry,
        credential,
        logicalDelivery: logical.entry,
        barrier: 'POST',
      };
    }

    const slot = await this.reserve(command, gate.id, run.id, 'CONCURRENT_SUBMISSION', {});
    if (slot.status === 'DENIED') {
      // Has not crossed the barrier: return the logical delivery unit just reserved so it does not eat the daily budget
      if (!logical.replay) {
        await this.control.settleCap(
          command.tenantId,
          command.deliveryId,
          'LOGICAL_DELIVERY',
          0,
          'RELEASED',
          command.at,
        );
      }
      return this.denyRun(actor, command, { status: 'DENIED', code: slot.code });
    }
    if (slot.entry.state !== 'RESERVED') {
      return this.denyRun(actor, command, {
        status: 'DENIED',
        code: 'CAP_ACCOUNTING_INCONSISTENCY',
        signal: 'CAP_ACCOUNTING_INCONSISTENCY',
      });
    }

    // A replay of the original reservation is not a new reservation, so no extra audit row
    if (!logical.replay) {
      await this.record({
        tenantId: command.tenantId,
        category: 'CAP',
        code: 'CAP_RESERVED',
        actor,
        at: command.at,
        subjectId: logical.entry.id,
        deliveryId: command.deliveryId,
        salt: [command.deliveryId, 'LOGICAL_DELIVERY'],
      });
    }
    return {
      status: 'AUTHORIZED',
      gate,
      run,
      allowlistEntry,
      credential,
      logicalDelivery: logical.entry,
      barrier: 'PRE',
      concurrencySlot: slot.entry,
    };
  }

  private reserve(
    command: BeginLineRunCommand,
    gateId: string,
    runAuthorizationId: string,
    capKind: LineCapKind,
    options: {
      runCapProviderAttempts?: number;
      attemptNo?: number;
      deliveryCaps?: ReturnType<typeof lineDeliveryCapsFor>;
    },
  ): Promise<ReserveLineCapResult> {
    return this.control.reserveCap({
      id: this.newId(),
      tenantId: command.tenantId,
      gateId,
      runAuthorizationId,
      deliveryId: command.deliveryId,
      capKind,
      ...(options.attemptNo === undefined ? {} : { attemptNo: options.attemptNo }),
      recipientFingerprint: command.recipientFingerprint,
      reservedAt: command.at,
      limits: lineCapLimits({
        capKind,
        at: command.at,
        ...(options.runCapProviderAttempts === undefined
          ? {}
          : { runCapProviderAttempts: options.runCapProviderAttempts }),
        ...(options.deliveryCaps ? { deliveryCaps: options.deliveryCaps } : {}),
      }),
    });
  }

  /** One rejection = one audit row, and an immediate kill if it is a signal per #358 §F */
  private async denyRun(
    actor: LineControlActor,
    command: BeginLineRunCommand,
    denied: LineGateDenied,
  ): Promise<LineGateDenied> {
    if (denied.signal) {
      const gate = await this.control.findGate(command.scope);
      if (gate) await this.killOnSignal(gate, denied.signal, command.at);
    }
    await this.record({
      tenantId: command.tenantId,
      category: 'RUN_AUTHORIZATION',
      code: 'RUN_DENIED',
      actor,
      at: command.at,
      subjectId: command.runAuthorizationId,
      deliveryId: command.deliveryId,
      salt: [command.deliveryId, denied.code, command.at.toISOString()],
    });
    return denied;
  }

  /**
   * One provider attempt (including the first attempt) — exceeding the run cap is the signal
   * `PROVIDER_ATTEMPTS_EXHAUSTED` that must kill + quarantine and never issue a new key (#358 §C)
   */
  async reserveProviderAttempt(
    actor: LineControlActor,
    command: BeginLineRunCommand,
    gate: DlLineScopeGate,
    run: DlLineRunAuthorization,
    attemptNo: number,
  ): Promise<LineControlOutcome<DlLineCapLedgerEntry>> {
    assertControlAuthority(actor.role, 'EXECUTE_RUN');
    if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };
    const reserved = await this.reserve(command, gate.id, run.id, 'PROVIDER_ATTEMPT', {
      runCapProviderAttempts: run.capProviderAttempts,
      attemptNo,
    });
    if (reserved.status === 'DENIED') {
      if (reserved.code === 'PROVIDER_ATTEMPT_CAP_EXCEEDED') {
        await this.killOnSignal(gate, 'PROVIDER_ATTEMPTS_EXHAUSTED', command.at);
      }
      return { status: 'DENIED', code: reserved.code };
    }
    return { status: 'APPLIED', value: reserved.entry };
  }

  /**
   * S2.7 (#368 decision 2026-09-23): PR02 replay probe — the exact original request fired again after accepted
   * to prove the `409` is a `PROVIDER` audit only, not an attempt receipt, and does not touch Governance.
   * The caller must reserve a `PROVIDER_ATTEMPT` through `reserveProviderAttempt` before firing
   */
  async recordProviderReplayProbe(
    actor: LineControlActor,
    input: {
      tenantId: string;
      runAuthorizationId: string;
      deliveryId: string;
      evidenceDigest: string;
      at: Date;
    },
  ): Promise<void> {
    assertControlAuthority(actor.role, 'EXECUTE_RUN');
    await this.record({
      tenantId: input.tenantId,
      category: 'PROVIDER',
      code: 'PROVIDER_REPLAY_PROBE',
      actor,
      at: input.at,
      subjectId: input.runAuthorizationId,
      deliveryId: input.deliveryId,
      evidenceDigest: input.evidenceDigest,
      salt: [input.deliveryId, input.evidenceDigest],
    });
  }

  /** Crossed the barrier: the logical delivery unit becomes COMMITTED and the concurrency slot is returned */
  async commitDelivery(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    const committed = await this.control.settleCap(
      tenantId,
      deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'COMMITTED',
      at,
    );
    await this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_SUBMISSION', 0, 'RELEASED', at);
    return committed;
  }

  /**
   * Before the barrier only: return both the unit and the slot — if the unit is already committed it cannot be returned and the caller
   * must go the exact-key reconciliation route instead (#358 §F, #362 §11)
   */
  async releaseDelivery(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    const released = await this.control.settleCap(
      tenantId,
      deliveryId,
      'LOGICAL_DELIVERY',
      0,
      'RELEASED',
      at,
    );
    await this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_SUBMISSION', 0, 'RELEASED', at);
    return released;
  }

  /** unknown outcome: reserve a slot, only one at a time is possible, then pause new work in this scope (#358 §C) */
  async enterUnknownReconciling(
    command: BeginLineRunCommand,
    gateId: string,
    runAuthorizationId: string,
  ): Promise<LineControlOutcome<DlLineCapLedgerEntry>> {
    const reserved = await this.reserve(
      command,
      gateId,
      runAuthorizationId,
      'CONCURRENT_UNKNOWN',
      {},
    );
    if (reserved.status === 'DENIED') return { status: 'DENIED', code: reserved.code };
    return { status: 'APPLIED', value: reserved.entry };
  }

  exitUnknownReconciling(tenantId: string, deliveryId: string, at: Date): Promise<boolean> {
    return this.control.settleCap(tenantId, deliveryId, 'CONCURRENT_UNKNOWN', 0, 'RELEASED', at);
  }
}
