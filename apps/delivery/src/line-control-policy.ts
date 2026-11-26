/**
 * Owner: Delivery/Channels — pure policy of the LINE control plane (S2.3 #367)
 *
 * Authority: rollout/security decision #358 §A/§B/§C/§D/§E/§F and Phase Contract #362 §9/§10
 *
 * This file has no I/O, no database, no credential value and no provider call — only
 * decision tables that can be read and compared directly with the decisions: who may order what, which business state may touch
 * which provider operation, which limits one cap unit must pass, what the proposal digest is computed from,
 * which quota snapshots are unusable, and which signals must trigger an automatic kill.
 *
 * Every numeric cap value always comes from `LINE_PILOT_CAPS` (S2) or from a trial authorization bounded by
 * `LINE_TEAM_TRIAL_MAX_CAPS` (#567) of `@d-contact/cxa-contracts` — no duplicate cap literal may appear here
 * because raising a cap needs a new decision (#358 §C)
 */
import { createHash } from 'node:crypto';
import {
  LINE_PILOT_CAPS,
  LINE_PILOT_PROFILE,
  LINE_TEAM_TRIAL_MAX_CAPS,
  LINE_TEAM_TRIAL_PROFILE,
  type LineCapKind,
  type LineGateErrorCode,
  type LineKillReason,
  type LineProviderOutcomeCode,
  type LineRolloutState,
} from '@d-contact/cxa-contracts';
import type { LineCapLimit } from './line-control-repository.js';

/** Matches the Postgres enum `DlLineActorKind`; `SYSTEM` is allowed only for automatic kill */
export const LINE_CONTROL_ACTOR_ROLES = [
  'TENANT_ADMIN',
  'COMPLIANCE',
  'PLATFORM_OPERATOR',
  'SYSTEM',
] as const;
export type LineControlActorRole = (typeof LINE_CONTROL_ACTOR_ROLES)[number];

export const LINE_CONTROL_ACTIONS = [
  'ADVANCE_STATE',
  'LOWER_STATE',
  'SET_TECHNICAL_SWITCH',
  'KILL',
  'CLEAR_KILL',
  'REGISTER_ALLOWLIST',
  'REVOKE_ALLOWLIST',
  'REGISTER_CREDENTIAL',
  'ACTIVATE_CREDENTIAL',
  'REVOKE_CREDENTIAL',
  'PROPOSE_RUN',
  'APPROVE_RUN_TENANT_ADMIN',
  'APPROVE_RUN_COMPLIANCE',
  'CLOSE_RUN',
  'EXECUTE_RUN',
] as const;
export type LineControlAction = (typeof LINE_CONTROL_ACTIONS)[number];

/**
 * Authority matrix per #358 §E: Platform Operator proposes/opens the switch/executes, Tenant Admin confirms
 * recipient/purpose/content, Compliance approves promotion and lifting a kill, while lowering a step and kill
 * can be done immediately by either side (#358 §C/§F) — `SYSTEM` is permitted only automatic kill
 */
export const LINE_CONTROL_AUTHORITY: Readonly<
  Record<LineControlAction, readonly LineControlActorRole[]>
> = Object.freeze({
  ADVANCE_STATE: ['COMPLIANCE'],
  LOWER_STATE: ['COMPLIANCE', 'PLATFORM_OPERATOR'],
  SET_TECHNICAL_SWITCH: ['PLATFORM_OPERATOR'],
  // #567 (T5): the Tenant Admin of a pilot tenant can press kill from the inbound page — kill is always the fail-closed route
  // while lifting a kill remains Compliance only
  KILL: ['TENANT_ADMIN', 'COMPLIANCE', 'PLATFORM_OPERATOR', 'SYSTEM'],
  CLEAR_KILL: ['COMPLIANCE'],
  REGISTER_ALLOWLIST: ['TENANT_ADMIN'],
  REVOKE_ALLOWLIST: ['TENANT_ADMIN', 'COMPLIANCE'],
  REGISTER_CREDENTIAL: ['PLATFORM_OPERATOR'],
  ACTIVATE_CREDENTIAL: ['PLATFORM_OPERATOR'],
  REVOKE_CREDENTIAL: ['PLATFORM_OPERATOR', 'COMPLIANCE'],
  PROPOSE_RUN: ['PLATFORM_OPERATOR'],
  APPROVE_RUN_TENANT_ADMIN: ['TENANT_ADMIN'],
  APPROVE_RUN_COMPLIANCE: ['COMPLIANCE'],
  CLOSE_RUN: ['PLATFORM_OPERATOR', 'COMPLIANCE'],
  EXECUTE_RUN: ['PLATFORM_OPERATOR'],
});

export class LineControlAuthorizationError extends Error {
  readonly code: LineGateErrorCode = 'LINE_GATE_AUTHORIZATION_DENIED';

  constructor(
    readonly actorRole: LineControlActorRole,
    readonly action: LineControlAction,
  ) {
    super(`actor role ${actorRole} is not permitted to ${action}`);
    this.name = 'LineControlAuthorizationError';
  }
}

export function mayPerform(role: LineControlActorRole, action: LineControlAction): boolean {
  return LINE_CONTROL_AUTHORITY[action].includes(role);
}

export function assertControlAuthority(
  role: LineControlActorRole,
  action: LineControlAction,
): void {
  if (!mayPerform(role, action)) throw new LineControlAuthorizationError(role, action);
}

// ── Business state → provider operation (#358 §A) ────────────────────────────

/**
 * Operations the control plane knows, not real HTTP calls (S2.3 has no provider I/O):
 * they are the "permission the caller is asking for", which S2.4/S2.5 must always request before touching the transport
 */
export const LINE_PROVIDER_OPERATIONS = [
  'LOCAL_VALIDATION',
  'TOKEN_VERIFY',
  'QUOTA_READ',
  'MESSAGE_VALIDATE',
  'WEBHOOK_TEST',
  'PUSH',
] as const;
export type LineProviderOperation = (typeof LINE_PROVIDER_OPERATIONS)[number];

/** Lowest business state that permits the operation — `DISABLED` permits nothing at all */
export const LINE_OPERATION_MINIMUM_STATE: Readonly<
  Record<LineProviderOperation, Exclude<LineRolloutState, 'DISABLED'>>
> = Object.freeze({
  LOCAL_VALIDATION: 'DRY_RUN',
  TOKEN_VERIFY: 'PROVIDER_CONFORMANCE',
  QUOTA_READ: 'PROVIDER_CONFORMANCE',
  MESSAGE_VALIDATE: 'PROVIDER_CONFORMANCE',
  WEBHOOK_TEST: 'PROVIDER_CONFORMANCE',
  PUSH: 'CAPPED_PILOT',
});

/** Operations that need the network to reach real LINE, so they need a readable credential + quota */
export const LINE_OPERATIONS_NEEDING_PROVIDER: readonly LineProviderOperation[] = Object.freeze([
  'TOKEN_VERIFY',
  'QUOTA_READ',
  'MESSAGE_VALIDATE',
  'WEBHOOK_TEST',
  'PUSH',
]);

const ROLLOUT_ORDER: readonly LineRolloutState[] = [
  'DISABLED',
  'DRY_RUN',
  'PROVIDER_CONFORMANCE',
  'CAPPED_PILOT',
];

export function rolloutRank(state: LineRolloutState): number {
  return ROLLOUT_ORDER.indexOf(state);
}

export function allowsOperation(
  state: LineRolloutState,
  operation: LineProviderOperation,
): boolean {
  if (state === 'DISABLED') return false;
  return rolloutRank(state) >= rolloutRank(LINE_OPERATION_MINIMUM_STATE[operation]);
}

export function needsProviderCredential(operation: LineProviderOperation): boolean {
  return LINE_OPERATIONS_NEEDING_PROVIDER.includes(operation);
}

/** Advances one step at a time only (the trigger `DL_LINE_GATE_STEP` enforces it again in the DB) */
export function isSingleStepAdvance(from: LineRolloutState, to: LineRolloutState): boolean {
  return rolloutRank(to) === rolloutRank(from) + 1;
}

export function isLowering(from: LineRolloutState, to: LineRolloutState): boolean {
  return rolloutRank(to) < rolloutRank(from);
}

// ── Cap profile (#358 §C) ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;

/** Cap of the logical delivery used for one decision — S2 = `LINE_PILOT_CAPS`, trial = the value in the authorization */
export interface LineDeliveryCaps {
  perRun: number;
  perRecipientPer24h: number;
  per24h: number;
  lifetime: number;
}

export const LINE_PILOT_DELIVERY_CAPS: LineDeliveryCaps = Object.freeze({
  perRun: LINE_PILOT_CAPS.logicalDeliveriesPerRun,
  perRecipientPer24h: LINE_PILOT_CAPS.logicalDeliveriesPerRecipientPer24h,
  per24h: LINE_PILOT_CAPS.logicalDeliveriesPer24h,
  lifetime: LINE_PILOT_CAPS.logicalDeliveriesLifetime,
});

/** An authorization row sufficient to derive the cap (not bound to Prisma) */
export interface LineRunCapSource {
  profile: string;
  capLogicalDeliveries: number;
  capRecipientPer24h?: number | null;
  capPer24h?: number | null;
  capLifetime?: number | null;
}

/**
 * Cap of a run: S2 always uses constants whatever the row says; a trial uses the value in the row but not above the ceiling, and a missing value = 0
 * (fail closed — the DB CHECK already enforces completeness, this is the second gate)
 */
export function lineDeliveryCapsFor(run: LineRunCapSource): LineDeliveryCaps {
  if (run.profile !== LINE_TEAM_TRIAL_PROFILE) return LINE_PILOT_DELIVERY_CAPS;
  const bounded = (value: number | null | undefined, max: number) =>
    Math.min(Math.max(value ?? 0, 0), max);
  return {
    perRun: bounded(run.capLogicalDeliveries, LINE_TEAM_TRIAL_MAX_CAPS.logicalDeliveriesPerRun),
    perRecipientPer24h: bounded(
      run.capRecipientPer24h,
      LINE_TEAM_TRIAL_MAX_CAPS.logicalDeliveriesPerRecipientPer24h,
    ),
    per24h: bounded(run.capPer24h, LINE_TEAM_TRIAL_MAX_CAPS.logicalDeliveriesPer24h),
    lifetime: bounded(run.capLifetime, LINE_TEAM_TRIAL_MAX_CAPS.logicalDeliveriesLifetime),
  };
}

export function isTeamTrialRun(run: { profile: string }): boolean {
  return run.profile === LINE_TEAM_TRIAL_PROFILE;
}

export interface LineCapLimitInput {
  capKind: LineCapKind;
  at: Date;
  /** Cap of this run, can be lowered from the profile but not exceeded (the DB CHECK enforces 1..4) */
  runCapProviderAttempts?: number;
  /** #567: cap of the logical delivery per the run's profile — unspecified = S2 */
  deliveryCaps?: LineDeliveryCaps;
}

/**
 * The full set of limits for one cap unit — the caller of `reserveCap` must always pass the whole set (S2.1 hand-off).
 * An incomplete set = a cap nobody counts, and the ledger would say "passed" even though the profile was exceeded.
 *
 * LOGICAL_DELIVERY has four dimensions at once: 1/run, 1/recipient/24h, 3/24h and 10 across the profile.
 * Counts only RESERVED+COMMITTED rows — work released before the barrier does not eat the daily/lifetime quota
 */
export function lineCapLimits(input: LineCapLimitInput): LineCapLimit[] {
  const since = new Date(input.at.getTime() - DAY_MS);
  const caps = input.deliveryCaps ?? LINE_PILOT_DELIVERY_CAPS;
  switch (input.capKind) {
    case 'LOGICAL_DELIVERY':
      return [
        {
          code: 'RUN_DELIVERY_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: caps.perRun,
          sameRun: true,
        },
        {
          code: 'CONTACT_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: caps.perRecipientPer24h,
          sameRecipient: true,
          since,
        },
        {
          code: 'SUBMISSION_WINDOW_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: caps.per24h,
          since,
        },
        {
          code: 'LIFETIME_CAP_EXCEEDED',
          capKind: 'LOGICAL_DELIVERY',
          max: caps.lifetime,
        },
      ];
    case 'CONCURRENT_SUBMISSION':
      return [
        {
          code: 'CONCURRENT_SUBMISSION_CAP_EXCEEDED',
          capKind: 'CONCURRENT_SUBMISSION',
          max: LINE_PILOT_CAPS.concurrentSubmissions,
          activeOnly: true,
        },
      ];
    case 'CONCURRENT_UNKNOWN':
      return [
        {
          code: 'CONCURRENT_UNKNOWN_RECONCILING_CAP_EXCEEDED',
          capKind: 'CONCURRENT_UNKNOWN',
          max: LINE_PILOT_CAPS.concurrentUnknownReconciling,
          activeOnly: true,
        },
      ];
    case 'PROVIDER_ATTEMPT':
      return [
        {
          code: 'PROVIDER_ATTEMPT_CAP_EXCEEDED',
          capKind: 'PROVIDER_ATTEMPT',
          max: Math.min(
            input.runCapProviderAttempts ?? LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
            LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery,
          ),
          sameDelivery: true,
        },
      ];
  }
  // A new cap kind must always have its own limit — letting it through would allow a cap nobody counts
  const exhaustive: never = input.capKind;
  throw new TypeError(`no cap limit for ${String(exhaustive)}`);
}

// ── Immutable run proposal (#358 §E) ─────────────────────────────────────────

/**
 * Every dimension the approver sees at approval — the digest is computed from these values only, so the executor cannot change
 * anything after approval while keeping the digest the same (`proposalRef` gives a new run of the same
 * binding a new digest, so it does not collide with the unique of one already consumed)
 */
export interface LineRunProposalDigestInput {
  tenantId: string;
  gateId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  allowlistEntryId: string;
  recipientFingerprint: string;
  contentDigest: string;
  configDigest: string;
  credentialRefId: string;
  credentialVersion: number;
  capLogicalDeliveries: number;
  capProviderAttempts: number;
  proposedBy: string;
  proposalRef: string;
  proposedAt: Date;
  expiresAt: Date;
  /** #567: present only for a trial — S2 omits it so the S2 digest stays identical byte for byte */
  trial?: {
    trialRef: string;
    capRecipientPer24h: number;
    capPer24h: number;
    capLifetime: number;
    contactId: string;
    identityId: string | null;
  };
}

export function lineRunProposalDigest(input: LineRunProposalDigestInput): string {
  const trial = input.trial
    ? [
        ['trialRef', input.trial.trialRef],
        ['capRecipientPer24h', String(input.trial.capRecipientPer24h)],
        ['capPer24h', String(input.trial.capPer24h)],
        ['capLifetime', String(input.trial.capLifetime)],
        ['contactId', input.trial.contactId],
        ['identityId', input.trial.identityId ?? ''],
      ]
    : [];
  const canonical = [
    ['profile', input.trial ? LINE_TEAM_TRIAL_PROFILE : LINE_PILOT_PROFILE],
    ...trial,
    ['tenantId', input.tenantId],
    ['gateId', input.gateId],
    ['channelAccountId', input.channelAccountId],
    ['senderIdentityId', input.senderIdentityId],
    ['purpose', input.purpose],
    ['contactKind', input.contactKind],
    ['allowlistEntryId', input.allowlistEntryId],
    ['recipientFingerprint', input.recipientFingerprint],
    ['contentDigest', input.contentDigest],
    ['configDigest', input.configDigest],
    ['credentialRefId', input.credentialRefId],
    ['credentialVersion', String(input.credentialVersion)],
    ['capLogicalDeliveries', String(input.capLogicalDeliveries)],
    ['capProviderAttempts', String(input.capProviderAttempts)],
    ['proposedBy', input.proposedBy],
    ['proposalRef', input.proposalRef],
    ['proposedAt', input.proposedAt.toISOString()],
    ['expiresAt', input.expiresAt.toISOString()],
  ].sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** #567: TTL of a trial (≤30 days) — the DB CHECK enforces it again */
export function lineTeamTrialExpiry(proposedAt: Date, days: number): Date {
  const bounded = Math.min(
    Math.max(Math.trunc(days), 1),
    LINE_TEAM_TRIAL_MAX_CAPS.runAuthorizationTtlDays,
  );
  return new Date(proposedAt.getTime() + bounded * DAY_MS);
}

/** TTL of a one-shot authorization — the DB CHECK enforces again that it must not exceed this value */
export function lineRunExpiry(proposedAt: Date): Date {
  return new Date(proposedAt.getTime() + LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000);
}

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

/**
 * Snapshot the caller (S2.4 transport) read from LINE — the control plane does not fire it itself.
 * `type` follows the provider's answer: `limited` has a ceiling, `none` means unlimited
 */
export interface LineQuotaSnapshot {
  type: 'limited' | 'none';
  targetLimit?: number;
  totalUsage: number;
  observedAt: Date;
}

export const LINE_QUOTA_ADVISORY_STATUSES = ['OK', 'EXHAUSTED', 'STALE', 'UNAVAILABLE'] as const;
export type LineQuotaAdvisoryStatus = (typeof LINE_QUOTA_ADVISORY_STATUSES)[number];

/** A snapshot older than this is unusable for decisions — one times shorter than the authorization TTL */
export const LINE_QUOTA_SNAPSHOT_MAX_AGE_MS =
  (LINE_PILOT_CAPS.runAuthorizationTtlMinutes / 2) * 60_000;

/**
 * quota is advisory/approximate: it can be used only to "reject", never to replace the durable cap.
 * No snapshot, a stale snapshot, or insufficient remaining quota = fail closed in all three cases (#358 §D)
 */
export function evaluateQuotaAdvisory(
  snapshot: LineQuotaSnapshot | undefined,
  at: Date,
  requiredMessages = LINE_PILOT_CAPS.logicalDeliveriesPerRun,
): LineQuotaAdvisoryStatus {
  if (!snapshot) return 'UNAVAILABLE';
  const age = at.getTime() - snapshot.observedAt.getTime();
  if (age < 0 || age > LINE_QUOTA_SNAPSHOT_MAX_AGE_MS) return 'STALE';
  if (snapshot.type === 'none') return 'OK';
  const limit = snapshot.targetLimit;
  if (limit === undefined || !Number.isFinite(limit)) return 'UNAVAILABLE';
  return limit - snapshot.totalUsage >= requiredMessages ? 'OK' : 'EXHAUSTED';
}

// ── Automatic kill (#358 §F) ─────────────────────────────────────────────────

/**
 * Signals the control plane treats as "must kill immediately" — a closed set per #358 §F.
 * These signals come from callers that saw the real event (adapter/worker/acceptance), not from guessing
 */
export const LINE_CONTROL_SIGNALS = [
  'CROSS_TENANT_LEAK',
  'ALLOWLIST_BINDING_MISMATCH',
  'CG3_BYPASS',
  'DUPLICATE_BUSINESS_EFFECT',
  'PII_OR_CREDENTIAL_LEAK',
  'EVIDENCE_HASH_MISMATCH',
  'UNKNOWN_OUTCOME_EXPIRED',
  'PROVIDER_ATTEMPTS_EXHAUSTED',
  'AUTH_FAILURE',
  'QUOTA_EXHAUSTED',
  'CAP_ACCOUNTING_INCONSISTENCY',
] as const;
export type LineControlSignal = (typeof LINE_CONTROL_SIGNALS)[number];

/** Every signal has a kill reason of the same name in `LINE_KILL_REASONS` — so the mapping is an identity */
export function automaticKillReasonFor(signal: LineControlSignal): LineKillReason {
  return signal;
}

/** A kill that comes from a human: split by role so audit can tell who ordered it (#358 §F) */
export function operatorKillReasonFor(role: LineControlActorRole): LineKillReason {
  return role === 'COMPLIANCE' ? 'COMPLIANCE_KILL' : 'OPERATOR_KILL';
}

/**
 * Provider outcomes that must close the scope immediately without waiting for a human decision (#358 §D/§F).
 * Outcomes not in this table (rejected/unavailable/unknown) remain a matter for a single delivery
 */
export const LINE_OUTCOME_KILL_SIGNALS: Readonly<
  Partial<Record<LineProviderOutcomeCode, LineControlSignal>>
> = Object.freeze({
  LINE_AUTH_INVALID: 'AUTH_FAILURE',
  LINE_MONTHLY_QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  LINE_RETRY_WINDOW_EXPIRED: 'UNKNOWN_OUTCOME_EXPIRED',
});

export function killSignalForOutcome(
  outcomeCode: LineProviderOutcomeCode,
): LineControlSignal | undefined {
  return LINE_OUTCOME_KILL_SIGNALS[outcomeCode];
}
