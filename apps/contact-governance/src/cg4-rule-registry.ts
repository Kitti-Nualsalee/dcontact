import {
  CG4_RULE_REGISTRY_VERSION,
  type Cg4ExceptionRiskTier,
  type Cg4IdentityScopeKind,
  type Cg4OverrideMechanism,
  type Cg4RuleClass,
  type Cg4RuleMetadata,
} from '@d-contact/cxa-contracts';

export const CG4_PLATFORM_LIFETIME_CAP_SECONDS = Object.freeze({
  STANDARD: 4 * 60 * 60,
  HIGH: 24 * 60 * 60,
  EMERGENCY: 30 * 60,
} satisfies Readonly<Record<Cg4ExceptionRiskTier, number>>);

export const CG4_RULE_CODES = {
  IDENTITY_AMBIGUOUS: 'IDENTITY_AMBIGUOUS',
  IDENTITY_NOT_FOUND: 'IDENTITY_NOT_FOUND',
  TENANT_SCOPE_NOT_ALLOWED: 'TENANT_SCOPE_NOT_ALLOWED',
  TEAM_SEGMENT_NOT_ALLOWED: 'TEAM_SEGMENT_NOT_ALLOWED',
  CAPABILITY_REQUIRED: 'CAPABILITY_REQUIRED',
  AUTHORIZATION_CONTEXT_UNAVAILABLE: 'AUTHORIZATION_CONTEXT_UNAVAILABLE',
  DNC_GLOBAL: 'DNC_GLOBAL',
  PURPOSE_OBJECTED: 'PURPOSE_OBJECTED',
  CONSENT_REVOKED: 'CONSENT_REVOKED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  CONSENT_EXPIRED: 'CONSENT_EXPIRED',
  LAWFUL_BASIS_REQUIRED: 'LAWFUL_BASIS_REQUIRED',
  REGULATORY_RESTRICTION: 'REGULATORY_RESTRICTION',
  SAFETY_RESTRICTION: 'SAFETY_RESTRICTION',
  PREFERENCE_BLOCKED: 'PREFERENCE_BLOCKED',
  PREFERENCE_DEFERRED: 'PREFERENCE_DEFERRED',
  TIMEZONE_UNKNOWN: 'TIMEZONE_UNKNOWN',
  SENDER_IDENTITY_REQUIRED: 'SENDER_IDENTITY_REQUIRED',
  SENDER_IDENTITY_INVALID: 'SENDER_IDENTITY_INVALID',
  GOVERNANCE_KILL_SWITCH_ACTIVE: 'GOVERNANCE_KILL_SWITCH_ACTIVE',
  OUTBOUND_TRAFFIC_DISABLED: 'OUTBOUND_TRAFFIC_DISABLED',
  GOVERNANCE_VERSION_STALE: 'GOVERNANCE_VERSION_STALE',
  GOVERNANCE_STATE_UNAVAILABLE: 'GOVERNANCE_STATE_UNAVAILABLE',
  GOVERNANCE_POLICY_VERSION_UNSUPPORTED: 'GOVERNANCE_POLICY_VERSION_UNSUPPORTED',
  CALLBACK_OVERRIDE_NOT_ALLOWED: 'CALLBACK_OVERRIDE_NOT_ALLOWED',
  CALLBACK_OVERRIDE_EXPIRED: 'CALLBACK_OVERRIDE_EXPIRED',
  PREFERENCE_WINDOW_CLOSED: 'PREFERENCE_WINDOW_CLOSED',
  QUIET_HOURS: 'QUIET_HOURS',
  TENANT_HOLIDAY: 'TENANT_HOLIDAY',
  MIN_GAP: 'MIN_GAP',
  DAILY_ATTEMPT_CAP: 'DAILY_ATTEMPT_CAP',
  DAILY_TOUCH_CAP: 'DAILY_TOUCH_CAP',
} as const;

export type Cg4RegisteredRuleCode = (typeof CG4_RULE_CODES)[keyof typeof CG4_RULE_CODES];

const NO_MECHANISMS = Object.freeze([]) as readonly Cg4OverrideMechanism[];
const NO_SCOPES = Object.freeze([]) as readonly Cg4IdentityScopeKind[];
const NO_LIFETIME = Object.freeze({
  STANDARD: 0,
  HIGH: 0,
  EMERGENCY: 0,
}) satisfies Readonly<Record<Cg4ExceptionRiskTier, number>>;
const ALL_SCOPES = Object.freeze([
  'EXACT_IDENTITY',
  'CONTACT_WIDE',
] as const) satisfies readonly Cg4IdentityScopeKind[];

interface RuleOptions {
  ruleClass: Cg4RuleClass;
  mechanisms?: readonly Cg4OverrideMechanism[];
  scopes?: readonly Cg4IdentityScopeKind[];
  riskFloor?: Cg4ExceptionRiskTier;
  lifetimeCapSeconds?: Readonly<Record<Cg4ExceptionRiskTier, number>>;
}

function rule(ruleCode: Cg4RegisteredRuleCode, options: RuleOptions): Cg4RuleMetadata {
  const mechanisms = Object.freeze([...(options.mechanisms ?? NO_MECHANISMS)]);
  const scopes = Object.freeze([...(options.scopes ?? NO_SCOPES)]);
  const overridable = mechanisms.length > 0;
  return Object.freeze({
    ruleCode,
    ruleClass: options.ruleClass,
    overridable,
    allowedOverrideMechanisms: mechanisms,
    supportedExceptionScopes: scopes,
    riskFloor: options.riskFloor ?? null,
    platformLifetimeCapSeconds: options.lifetimeCapSeconds ?? NO_LIFETIME,
    registryVersion: CG4_RULE_REGISTRY_VERSION,
  });
}

function hard(ruleCode: Cg4RegisteredRuleCode): Cg4RuleMetadata {
  return rule(ruleCode, { ruleClass: 'NON_OVERRIDABLE' });
}

function callbackScoped(ruleCode: Cg4RegisteredRuleCode): Cg4RuleMetadata {
  return rule(ruleCode, {
    ruleClass: 'CUSTOMER_REQUEST_SCOPED',
    mechanisms: ['CUSTOMER_CALLBACK'],
    scopes: ALL_SCOPES,
    riskFloor: 'STANDARD',
    lifetimeCapSeconds: CG4_PLATFORM_LIFETIME_CAP_SECONDS,
  });
}

function operational(
  ruleCode: Cg4RegisteredRuleCode,
  riskFloor: Extract<Cg4ExceptionRiskTier, 'STANDARD' | 'HIGH'>,
  mechanisms: readonly Cg4OverrideMechanism[] = ['APPROVED_EXCEPTION'],
): Cg4RuleMetadata {
  return rule(ruleCode, {
    ruleClass: 'APPROVAL_REQUIRED_OPERATIONAL',
    mechanisms,
    scopes: ALL_SCOPES,
    riskFloor,
    lifetimeCapSeconds: CG4_PLATFORM_LIFETIME_CAP_SECONDS,
  });
}

const registryEntries: Record<Cg4RegisteredRuleCode, Cg4RuleMetadata> = {
  IDENTITY_AMBIGUOUS: hard(CG4_RULE_CODES.IDENTITY_AMBIGUOUS),
  IDENTITY_NOT_FOUND: hard(CG4_RULE_CODES.IDENTITY_NOT_FOUND),
  TENANT_SCOPE_NOT_ALLOWED: hard(CG4_RULE_CODES.TENANT_SCOPE_NOT_ALLOWED),
  TEAM_SEGMENT_NOT_ALLOWED: hard(CG4_RULE_CODES.TEAM_SEGMENT_NOT_ALLOWED),
  CAPABILITY_REQUIRED: hard(CG4_RULE_CODES.CAPABILITY_REQUIRED),
  AUTHORIZATION_CONTEXT_UNAVAILABLE: hard(CG4_RULE_CODES.AUTHORIZATION_CONTEXT_UNAVAILABLE),
  DNC_GLOBAL: hard(CG4_RULE_CODES.DNC_GLOBAL),
  PURPOSE_OBJECTED: hard(CG4_RULE_CODES.PURPOSE_OBJECTED),
  CONSENT_REVOKED: hard(CG4_RULE_CODES.CONSENT_REVOKED),
  CONSENT_REQUIRED: hard(CG4_RULE_CODES.CONSENT_REQUIRED),
  CONSENT_EXPIRED: hard(CG4_RULE_CODES.CONSENT_EXPIRED),
  LAWFUL_BASIS_REQUIRED: hard(CG4_RULE_CODES.LAWFUL_BASIS_REQUIRED),
  REGULATORY_RESTRICTION: hard(CG4_RULE_CODES.REGULATORY_RESTRICTION),
  SAFETY_RESTRICTION: hard(CG4_RULE_CODES.SAFETY_RESTRICTION),
  PREFERENCE_BLOCKED: hard(CG4_RULE_CODES.PREFERENCE_BLOCKED),
  PREFERENCE_DEFERRED: hard(CG4_RULE_CODES.PREFERENCE_DEFERRED),
  TIMEZONE_UNKNOWN: hard(CG4_RULE_CODES.TIMEZONE_UNKNOWN),
  SENDER_IDENTITY_REQUIRED: hard(CG4_RULE_CODES.SENDER_IDENTITY_REQUIRED),
  SENDER_IDENTITY_INVALID: hard(CG4_RULE_CODES.SENDER_IDENTITY_INVALID),
  GOVERNANCE_KILL_SWITCH_ACTIVE: hard(CG4_RULE_CODES.GOVERNANCE_KILL_SWITCH_ACTIVE),
  OUTBOUND_TRAFFIC_DISABLED: hard(CG4_RULE_CODES.OUTBOUND_TRAFFIC_DISABLED),
  GOVERNANCE_VERSION_STALE: hard(CG4_RULE_CODES.GOVERNANCE_VERSION_STALE),
  GOVERNANCE_STATE_UNAVAILABLE: hard(CG4_RULE_CODES.GOVERNANCE_STATE_UNAVAILABLE),
  GOVERNANCE_POLICY_VERSION_UNSUPPORTED: hard(CG4_RULE_CODES.GOVERNANCE_POLICY_VERSION_UNSUPPORTED),
  CALLBACK_OVERRIDE_NOT_ALLOWED: hard(CG4_RULE_CODES.CALLBACK_OVERRIDE_NOT_ALLOWED),
  CALLBACK_OVERRIDE_EXPIRED: hard(CG4_RULE_CODES.CALLBACK_OVERRIDE_EXPIRED),
  PREFERENCE_WINDOW_CLOSED: callbackScoped(CG4_RULE_CODES.PREFERENCE_WINDOW_CLOSED),
  QUIET_HOURS: operational(CG4_RULE_CODES.QUIET_HOURS, 'STANDARD', [
    'CUSTOMER_CALLBACK',
    'APPROVED_EXCEPTION',
  ]),
  TENANT_HOLIDAY: operational(CG4_RULE_CODES.TENANT_HOLIDAY, 'STANDARD', [
    'CUSTOMER_CALLBACK',
    'APPROVED_EXCEPTION',
  ]),
  MIN_GAP: operational(CG4_RULE_CODES.MIN_GAP, 'HIGH'),
  DAILY_ATTEMPT_CAP: operational(CG4_RULE_CODES.DAILY_ATTEMPT_CAP, 'HIGH'),
  DAILY_TOUCH_CAP: operational(CG4_RULE_CODES.DAILY_TOUCH_CAP, 'HIGH'),
};

/** registry แบบปิดและแก้ไขไม่ได้; caller ส่งได้เฉพาะ rule code และห้ามประกาศ metadata เอง */
export const CG4_RULE_REGISTRY: Readonly<Record<Cg4RegisteredRuleCode, Cg4RuleMetadata>> =
  Object.freeze(registryEntries);

export type Cg4RuleResolution =
  { known: true; metadata: Cg4RuleMetadata } | { known: false; metadata: Cg4RuleMetadata };

function unknownRule(ruleCode: string): Cg4RuleMetadata {
  return Object.freeze({
    ruleCode,
    ruleClass: 'NON_OVERRIDABLE',
    overridable: false,
    allowedOverrideMechanisms: NO_MECHANISMS,
    supportedExceptionScopes: NO_SCOPES,
    riskFloor: null,
    platformLifetimeCapSeconds: NO_LIFETIME,
    registryVersion: CG4_RULE_REGISTRY_VERSION,
  });
}

export function resolveCg4RuleMetadata(ruleCode: string): Cg4RuleResolution {
  const metadata = CG4_RULE_REGISTRY[ruleCode as Cg4RegisteredRuleCode];
  return metadata ? { known: true, metadata } : { known: false, metadata: unknownRule(ruleCode) };
}

export type Cg4OverrideIneligibilityReason =
  | 'RULE_NOT_REGISTERED'
  | 'NON_OVERRIDABLE_RULE'
  | 'OVERRIDE_MECHANISM_NOT_ALLOWED'
  | 'SCOPE_NOT_SUPPORTED'
  | 'RULE_NOT_ENABLED_BY_POLICY'
  | 'RULE_SET_INVALID'
  | 'RISK_TIER_UNSUPPORTED'
  | 'RISK_TIER_TOO_LOW'
  | 'LIFETIME_EXCEEDS_CAP';

export type Cg4OverrideEligibility =
  | { eligible: true; metadata: Cg4RuleMetadata; lifetimeCapSeconds: number }
  | {
      eligible: false;
      reason: Cg4OverrideIneligibilityReason;
      metadata: Cg4RuleMetadata;
    };

const RISK_RANK: Readonly<Record<Cg4ExceptionRiskTier, number>> = Object.freeze({
  STANDARD: 0,
  HIGH: 1,
  EMERGENCY: 2,
});

export interface Cg4OverrideEligibilityInput {
  ruleCode: string;
  mechanism: Cg4OverrideMechanism;
  identityScope: Cg4IdentityScopeKind;
  policyAllowedRuleCodes: readonly string[];
  riskTier: Cg4ExceptionRiskTier;
  requestedRuleCount: number;
  lifetimeSeconds: number;
}

export function resolveCg4OverrideEligibility(
  input: Cg4OverrideEligibilityInput,
): Cg4OverrideEligibility {
  const resolution = resolveCg4RuleMetadata(input.ruleCode);
  const { metadata } = resolution;
  if (!resolution.known) return { eligible: false, reason: 'RULE_NOT_REGISTERED', metadata };
  if (!metadata.overridable) {
    return { eligible: false, reason: 'NON_OVERRIDABLE_RULE', metadata };
  }
  if (!metadata.allowedOverrideMechanisms.includes(input.mechanism)) {
    return { eligible: false, reason: 'OVERRIDE_MECHANISM_NOT_ALLOWED', metadata };
  }
  if (!metadata.supportedExceptionScopes.includes(input.identityScope)) {
    return { eligible: false, reason: 'SCOPE_NOT_SUPPORTED', metadata };
  }
  if (!input.policyAllowedRuleCodes.includes(input.ruleCode)) {
    return { eligible: false, reason: 'RULE_NOT_ENABLED_BY_POLICY', metadata };
  }
  if (!Object.hasOwn(RISK_RANK, input.riskTier)) {
    return { eligible: false, reason: 'RISK_TIER_UNSUPPORTED', metadata };
  }
  if (!Number.isInteger(input.requestedRuleCount) || input.requestedRuleCount <= 0) {
    return { eligible: false, reason: 'RULE_SET_INVALID', metadata };
  }
  const effectiveRiskFloor =
    input.identityScope === 'CONTACT_WIDE' || input.requestedRuleCount > 1
      ? 'HIGH'
      : metadata.riskFloor;
  if (effectiveRiskFloor && RISK_RANK[input.riskTier] < RISK_RANK[effectiveRiskFloor]) {
    return { eligible: false, reason: 'RISK_TIER_TOO_LOW', metadata };
  }
  const lifetimeCapSeconds = metadata.platformLifetimeCapSeconds[input.riskTier];
  if (
    !Number.isInteger(input.lifetimeSeconds) ||
    input.lifetimeSeconds <= 0 ||
    input.lifetimeSeconds > lifetimeCapSeconds
  ) {
    return { eligible: false, reason: 'LIFETIME_EXCEEDS_CAP', metadata };
  }
  return { eligible: true, metadata, lifetimeCapSeconds };
}
