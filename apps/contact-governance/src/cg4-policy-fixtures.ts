import {
  CG4_RULE_REGISTRY_VERSION,
  canonicalCg4Digest,
  type Cg4Digest,
} from '@d-contact/cxa-contracts';

/**
 * CG4.5 (#188): the mandatory platform fixture pack from #176 §2.
 *
 * Each entry is a *property* the compiled candidate must hold, not a hardcoded expected
 * decision — a pack of fixed expectations would only ever fit one policy shape, and #176
 * requires this suite to gate every submit/approve/publish on every scope. The pack is
 * frozen data with a stable digest, which is what lets an approval bind "these exact
 * checks passed against this exact content"; editing a check changes the pack digest and
 * invalidates every approval bound to the old one.
 */

export type Cg4PolicyCheckKind =
  /** Registry says the rule is non-overridable, and the candidate lists it nowhere. */
  | 'HARD_RULE_NOT_OVERRIDABLE'
  /** A cap/min-gap rule keeps its registry risk floor. */
  | 'CAP_RULE_RISK_FLOOR'
  /** An explicit BLOCK preference wins over any Approved exception. */
  | 'PREFERENCE_BLOCK_NOT_LIFTABLE'
  /** A defective exception changes nothing versus evaluating with no exception at all. */
  | 'EXCEPTION_OUT_OF_SCOPE_IS_INERT'
  | 'EXCEPTION_EXPIRED_IS_INERT'
  | 'EXCEPTION_STALE_BINDING_IS_INERT'
  | 'EXCEPTION_OUTSIDE_ALLOWLIST_IS_INERT'
  | 'EXCEPTION_UNKNOWN_REGISTRY_IS_INERT'
  /** An exact-scope exception lifts exactly the provisional rules the candidate allows. */
  | 'EXCEPTION_IN_SCOPE_LIFTS_ALLOWED_RULE'
  /** Quiet-hours verdicts follow the tenant's local clock, DST folds included. */
  | 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK'
  /** Every local instant of a declared CLOSED date is blocked. */
  | 'CLOSED_HOLIDAY_BLOCKS_WHOLE_LOCAL_DAY'
  /** A WINDOWS holiday blocks exactly outside its declared windows. */
  | 'WINDOWS_HOLIDAY_BLOCKS_OUTSIDE_WINDOWS'
  /** The same inputs re-evaluated produce a byte-identical result digest. */
  | 'DETERMINISTIC_REPLAY';

export interface Cg4PolicyCheck {
  id: string;
  kind: Cg4PolicyCheckKind;
  ruleCode?: string;
  riskFloor?: 'STANDARD' | 'HIGH' | 'EMERGENCY';
  /** Tenant timezone a clock/holiday check probes in. */
  timezone?: string;
  /** ISO instant a clock check starts probing from. */
  fromInstant?: string;
  probeHours?: number;
  stepMinutes?: number;
}

export interface Cg4PolicyFixturePack {
  packId: string;
  suiteVersion: string;
  checks: readonly Cg4PolicyCheck[];
}

export function digestCg4FixturePack(pack: Cg4PolicyFixturePack): Cg4Digest {
  return canonicalCg4Digest({
    packId: pack.packId,
    suiteVersion: pack.suiteVersion,
    registryVersion: CG4_RULE_REGISTRY_VERSION,
    checks: pack.checks,
  });
}

/** No DST; the baseline tenant clock. */
const BANGKOK = 'Asia/Bangkok';
/** 2026-03-08 is the US spring-forward date, so this probes the missing local hour. */
const NEW_YORK = 'America/New_York';

const HARD_RULES = [
  'DNC_GLOBAL',
  'PURPOSE_OBJECTED',
  'CONSENT_REVOKED',
  'CONSENT_REQUIRED',
  'CONSENT_EXPIRED',
  'LAWFUL_BASIS_REQUIRED',
  'REGULATORY_RESTRICTION',
  'SAFETY_RESTRICTION',
  'PREFERENCE_BLOCKED',
  'PREFERENCE_DEFERRED',
  'SENDER_IDENTITY_REQUIRED',
  'SENDER_IDENTITY_INVALID',
  'GOVERNANCE_KILL_SWITCH_ACTIVE',
  'OUTBOUND_TRAFFIC_DISABLED',
  // Unregistered codes resolve to non-overridable — the fail-closed default (#174 §2).
  'NOT_A_REGISTERED_RULE',
] as const;

const INERT_EXCEPTION_CHECKS = [
  ['EXCEPTION_OUT_OF_SCOPE_IS_INERT', 'out-of-scope'],
  ['EXCEPTION_EXPIRED_IS_INERT', 'expired'],
  ['EXCEPTION_STALE_BINDING_IS_INERT', 'stale-policy-binding'],
  ['EXCEPTION_OUTSIDE_ALLOWLIST_IS_INERT', 'outside-policy-allowlist'],
  ['EXCEPTION_UNKNOWN_REGISTRY_IS_INERT', 'unknown-registry-version'],
] as const;

export const CG4_PLATFORM_FIXTURE_PACK: Cg4PolicyFixturePack = Object.freeze({
  packId: 'CG4_PLATFORM_FIXTURES',
  suiteVersion: 'CG4_PLATFORM_FIXTURES_V1',
  checks: Object.freeze([
    ...HARD_RULES.map((ruleCode) => ({
      id: `hard-rule-not-overridable:${ruleCode}`,
      kind: 'HARD_RULE_NOT_OVERRIDABLE' as const,
      ruleCode,
    })),
    ...(['MIN_GAP', 'DAILY_ATTEMPT_CAP', 'DAILY_TOUCH_CAP'] as const).map((ruleCode) => ({
      id: `cap-rule-risk-floor:${ruleCode}`,
      kind: 'CAP_RULE_RISK_FLOOR' as const,
      ruleCode,
      riskFloor: 'HIGH' as const,
    })),
    { id: 'preference-block-not-liftable', kind: 'PREFERENCE_BLOCK_NOT_LIFTABLE' as const },
    ...INERT_EXCEPTION_CHECKS.map(([kind, label]) => ({
      id: `exception-inert:${label}`,
      kind,
    })),
    {
      id: 'exception-in-scope-lifts-allowed-rule',
      kind: 'EXCEPTION_IN_SCOPE_LIFTS_ALLOWED_RULE' as const,
    },
    {
      id: 'quiet-hours-local-clock:bangkok',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK' as const,
      timezone: BANGKOK,
      fromInstant: '2026-01-05T00:00:00.000Z',
      probeHours: 48,
      stepMinutes: 15,
    },
    {
      id: 'quiet-hours-local-clock:new-york-dst',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK' as const,
      timezone: NEW_YORK,
      fromInstant: '2026-03-07T12:00:00.000Z',
      probeHours: 36,
      stepMinutes: 15,
    },
    {
      id: 'closed-holiday-blocks-whole-day:bangkok',
      kind: 'CLOSED_HOLIDAY_BLOCKS_WHOLE_LOCAL_DAY' as const,
      timezone: BANGKOK,
      stepMinutes: 30,
    },
    {
      id: 'windows-holiday-blocks-outside-windows:bangkok',
      kind: 'WINDOWS_HOLIDAY_BLOCKS_OUTSIDE_WINDOWS' as const,
      timezone: BANGKOK,
      stepMinutes: 30,
    },
    {
      id: 'deterministic-replay',
      kind: 'DETERMINISTIC_REPLAY' as const,
      timezone: BANGKOK,
      fromInstant: '2026-01-05T00:00:00.000Z',
      probeHours: 24,
      stepMinutes: 60,
    },
  ] satisfies readonly Cg4PolicyCheck[]),
} satisfies Cg4PolicyFixturePack);

export const CG4_PLATFORM_FIXTURE_PACK_DIGEST = digestCg4FixturePack(CG4_PLATFORM_FIXTURE_PACK);
