import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type ContactChannel,
  type Cg4AppliedExceptionPin,
  type Cg4ExceptionEffectiveState,
  type Cg4ExceptionRiskTier,
  type Cg4ExceptionWorkflowState,
  type Cg4IdentityScopeKind,
} from '@d-contact/cxa-contracts';
import { resolveCg4OverrideEligibility } from './cg4-rule-registry.js';

/**
 * CG4.4 (#187): pure exception matching for the evaluator. No I/O — the fact loader
 * reads candidates inside the authorization transaction and passes them in, so a
 * decision stays deterministic and replayable from its pinned facts.
 *
 * Everything here fails closed: an exception lifts a provisional failure only when
 * every dimension matches exactly (#174 §4). There is no wildcard, no "nearest match",
 * and no defaulting of a null scope field.
 */

/** One APPROVED exception series, resolved to its current revision at load time. */
export interface Cg4ExceptionFacts {
  seriesId: string;
  revisionId: string;
  revision: number;
  workflowState: Cg4ExceptionWorkflowState;
  identityId: string | null;
  scopeKind: Cg4IdentityScopeKind;
  channel: ContactChannel;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: readonly string[];
  policyId: string;
  policyVersionId: string;
  policyVersion: number;
  /** Digest the exception was approved against. */
  policyContentDigest: string;
  /** Digest the policy row carries right now; a drift means the binding is stale. */
  currentPolicyContentDigest: string | null;
  /** Rule codes the pinned policy version positively allows. */
  policyAllowedRuleCodes: readonly string[];
  registryVersion: string;
  startsAt: Date;
  expiresAt: Date;
  tier: Cg4ExceptionRiskTier;
  contentDigest: string;
  approvalDigest: string;
}

export interface Cg4ExceptionMatchContext {
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  source: string;
  sourceId: string;
  now: Date;
}

/**
 * Effective state from database time (#177 §2). `expiresAt` is an exclusive boundary:
 * at exactly `expiresAt` the exception is already EXPIRED. Every non-APPROVED workflow
 * state is INACTIVE, so a PENDING/REJECTED/CANCELLED/REVOKED series can never override.
 */
export function resolveCg4EffectiveState(input: {
  workflowState: Cg4ExceptionWorkflowState;
  startsAt: Date;
  expiresAt: Date;
  now: Date;
}): Cg4ExceptionEffectiveState {
  if (input.workflowState !== 'APPROVED') return 'INACTIVE';
  const now = input.now.getTime();
  if (now < input.startsAt.getTime()) return 'SCHEDULED';
  if (now >= input.expiresAt.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

export type Cg4ExceptionMismatchReason =
  | 'NOT_ACTIVE'
  | 'SCOPE_MISMATCH'
  | 'RULE_NOT_COVERED'
  | 'POLICY_BINDING_STALE'
  | 'REGISTRY_VERSION_STALE'
  | 'RULE_NOT_OVERRIDABLE';

export type Cg4ExceptionCoverage =
  | { covered: true; exception: Cg4ExceptionFacts; pin: Cg4AppliedExceptionPin }
  | { covered: false; reason: Cg4ExceptionMismatchReason };

function scopeMatches(exception: Cg4ExceptionFacts, context: Cg4ExceptionMatchContext): boolean {
  const identityMatches =
    exception.scopeKind === 'CONTACT_WIDE'
      ? exception.identityId === null
      : exception.identityId !== null && exception.identityId === (context.identityId ?? null);
  return (
    identityMatches &&
    exception.channel === context.channel &&
    exception.purpose === context.purpose &&
    exception.sourceType === context.source &&
    exception.sourceId === context.sourceId
  );
}

function coversRule(
  exception: Cg4ExceptionFacts,
  context: Cg4ExceptionMatchContext,
  reasonCode: string,
): Cg4ExceptionCoverage {
  const effectiveState = resolveCg4EffectiveState({
    workflowState: exception.workflowState,
    startsAt: exception.startsAt,
    expiresAt: exception.expiresAt,
    now: context.now,
  });
  if (effectiveState !== 'ACTIVE') return { covered: false, reason: 'NOT_ACTIVE' };
  if (!scopeMatches(exception, context)) return { covered: false, reason: 'SCOPE_MISMATCH' };
  if (!exception.allowedRuleCodes.includes(reasonCode)) {
    return { covered: false, reason: 'RULE_NOT_COVERED' };
  }
  if (exception.registryVersion !== CG4_RULE_REGISTRY_VERSION) {
    return { covered: false, reason: 'REGISTRY_VERSION_STALE' };
  }
  if (
    exception.currentPolicyContentDigest === null ||
    exception.currentPolicyContentDigest !== exception.policyContentDigest
  ) {
    return { covered: false, reason: 'POLICY_BINDING_STALE' };
  }

  // Re-run platform eligibility at read time, not just at request time: a registry that
  // has since made this rule non-overridable, or a tier/lifetime that no longer fits its
  // cap, must stop overriding immediately rather than ride an old approval.
  const eligibility = resolveCg4OverrideEligibility({
    ruleCode: reasonCode,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: exception.scopeKind,
    policyAllowedRuleCodes: exception.policyAllowedRuleCodes,
    riskTier: exception.tier,
    requestedRuleCount: exception.allowedRuleCodes.length,
    lifetimeSeconds: Math.floor(
      (exception.expiresAt.getTime() - exception.startsAt.getTime()) / 1_000,
    ),
  });
  if (!eligibility.eligible) return { covered: false, reason: 'RULE_NOT_OVERRIDABLE' };

  return {
    covered: true,
    exception,
    pin: {
      seriesId: exception.seriesId as Cg4AppliedExceptionPin['seriesId'],
      revisionId: exception.revisionId as Cg4AppliedExceptionPin['revisionId'],
      version: exception.revision,
      contentDigest: exception.contentDigest,
      approvalDigest: exception.approvalDigest,
      matchedRuleCode: reasonCode,
    },
  };
}

/**
 * The first exactly-matching active exception that covers `reasonCode`, or why none did.
 * Candidates are ordered by the caller (earliest `startsAt` first) so the choice is
 * deterministic when more than one could apply.
 */
export function resolveCg4ExceptionCoverage(input: {
  exceptions: readonly Cg4ExceptionFacts[];
  context: Cg4ExceptionMatchContext;
  reasonCode: string;
}): Cg4ExceptionCoverage {
  let lastReason: Cg4ExceptionMismatchReason = 'RULE_NOT_COVERED';
  for (const exception of input.exceptions) {
    const coverage = coversRule(exception, input.context, input.reasonCode);
    if (coverage.covered) return coverage;
    lastReason = coverage.reason;
  }
  return { covered: false, reason: lastReason };
}

/** Canonical policy binding of an applied exception, for the decision trace pins. */
export function toCg4PolicyBinding(exception: Cg4ExceptionFacts) {
  return {
    policyId: exception.policyId as never,
    policyVersionId: exception.policyVersionId as never,
    policyVersion: exception.policyVersion,
    policyContentDigest: exception.policyContentDigest,
    policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
  };
}
