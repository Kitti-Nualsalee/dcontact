import type { Prisma } from '@d-contact/db';
import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4AuthorizationReviewReason,
  type Cg4PolicyBinding,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import type { Cg3GateOutcome, Cg3PolicyFacts } from './cg3-policy-evaluator.js';
import { compileCg4Policy, cg4PolicyScopeMatches } from './cg4-policy-compiler.js';
import {
  resolveCg4ActivePolicy,
  type Cg4PolicyRequestScope,
  type Cg4ScopeHeadFacts,
} from './cg4-policy-resolution.js';

/**
 * CG4.10 (#193) PR-B: the head-based policy reader that `authorizeAndReserve()` uses in place of the CG3 loader
 * after the switch, and used to evaluate side by side during shadow
 *
 * Always reads from the canonical head in the same transaction as the decision (not via cache) and has no fallback:
 * an ambiguous head, an unsupported version, a content digest mismatch, or a scheduled activation that is due
 * but not yet activated gets `FAIL_CLOSED` (#176 §4/§5, #179 §5)
 */

export const CG4_POLICY_HEAD_TTL_SECONDS = 60;

export type Cg4PolicyReadResult =
  | {
      outcome: 'RESOLVED';
      facts: Cg3PolicyFacts;
      binding: Cg4PolicyBinding;
      headVersion: number;
      scopeKey: string;
    }
  | { outcome: 'UNCONFIGURED' }
  | { outcome: 'FAIL_CLOSED'; reason: Cg4AuthorizationReviewReason; detail: string };

function matches(scopeKey: string, request: Cg4PolicyRequestScope): boolean {
  try {
    return cg4PolicyScopeMatches(scopeKey, request);
  } catch {
    return true;
  }
}

const unavailable = (detail: string): Cg4PolicyReadResult => ({
  outcome: 'FAIL_CLOSED',
  reason: 'GOVERNANCE_STATE_UNAVAILABLE',
  detail,
});

export async function loadCg4PolicyFacts(
  transaction: Prisma.TransactionClient,
  query: { tenantId: string; request: Cg4PolicyRequestScope; now: Date },
): Promise<Cg4PolicyReadResult> {
  const [heads, dueJobs] = await Promise.all([
    transaction.cg4PolicyScopeHead.findMany({ where: { tenantId: query.tenantId } }),
    transaction.cg4PolicyActivationJob.findMany({
      where: {
        tenantId: query.tenantId,
        state: { in: ['PENDING', 'CLAIMED', 'FAILED'] },
        scheduledFor: { lte: query.now },
      },
      select: { scopeKey: true, scheduledFor: true, state: true },
    }),
  ]);

  // a schedule that is due but not yet activated must not keep reading the old version. A scope that already has a head is guarded by
  // head.nextActivationAt, which an immediate publish can clear (forward-fix); a job the worker parked as
  // FAILED therefore counts only for a scope that has no head at all, otherwise a forward-fix could never release that scope
  const headScopes = new Set(heads.map((head) => head.scopeKey));
  const due = dueJobs.find(
    (job) =>
      matches(job.scopeKey, query.request) &&
      (job.state !== 'FAILED' || !headScopes.has(job.scopeKey)),
  );
  if (due) {
    return {
      outcome: 'FAIL_CLOSED',
      reason: 'POLICY_ACTIVATION_PENDING',
      detail: `the scheduled activation of ${due.scopeKey} is due but not yet activated`,
    };
  }

  const matching = heads.filter((head) => matches(head.scopeKey, query.request));
  if (matching.length === 0) return { outcome: 'UNCONFIGURED' };

  const rows = await transaction.cg4Policy.findMany({
    where: {
      tenantId: query.tenantId,
      id: { in: matching.map((head) => head.headPolicyRevisionId) },
    },
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const facts: Cg4ScopeHeadFacts[] = [];
  for (const head of matching) {
    const row = rowById.get(head.headPolicyRevisionId);
    if (!row)
      return unavailable(
        `the head of ${head.scopeKey} points to a policy version that does not exist`,
      );
    facts.push({
      scopeKey: head.scopeKey,
      policyId: head.headPolicyId,
      policyVersionId: head.headPolicyRevisionId,
      policyVersion: head.headPolicyVersion,
      policyContentDigest: row.contentDigest as Cg4ScopeHeadFacts['policyContentDigest'],
      schemaVersion: row.schemaVersion,
      registryVersion: row.registryVersion,
      evaluatorVersion: row.evaluatorVersion,
      headVersion: head.headVersion,
      headDigest: head.headDigest as Cg4ScopeHeadFacts['headDigest'],
      nextActivationAt: head.nextActivationAt,
    });
  }

  let resolution: ReturnType<typeof resolveCg4ActivePolicy>;
  try {
    resolution = resolveCg4ActivePolicy({
      heads: facts,
      request: query.request,
      now: query.now,
      cacheTtlSeconds: CG4_POLICY_HEAD_TTL_SECONDS,
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'could not resolve the head');
  }
  if (resolution.outcome !== 'RESOLVED') return resolution;

  const head = resolution.head;
  const row = rowById.get(head.policyVersionId)!;
  if (row.status !== 'ACTIVE' || row.version !== head.policyVersion) {
    return unavailable(`the head of ${head.scopeKey} does not match the ACTIVE policy version`);
  }
  let compiled: ReturnType<typeof compileCg4Policy>;
  try {
    compiled = compileCg4Policy({
      content: row.content,
      version: row.version,
      schemaVersion: row.schemaVersion,
      registryVersion: row.registryVersion,
      evaluatorVersion: row.evaluatorVersion,
    });
  } catch (error) {
    return {
      outcome: 'FAIL_CLOSED',
      reason: 'GOVERNANCE_POLICY_VERSION_UNSUPPORTED',
      detail: error instanceof Error ? error.message : 'could not compile the policy',
    };
  }
  // the canonical content must hash to the approved digest, otherwise the reader does not know what it is enforcing
  if (compiled.contentDigest !== row.contentDigest) {
    return unavailable(
      `the content digest of policy ${head.policyVersionId} does not match the recorded one`,
    );
  }

  return {
    outcome: 'RESOLVED',
    facts: compiled.facts,
    scopeKey: head.scopeKey,
    headVersion: head.headVersion,
    binding: {
      policyId: head.policyId as Cg4PolicyBinding['policyId'],
      policyVersionId: head.policyVersionId as Cg4PolicyBinding['policyVersionId'],
      policyVersion: head.policyVersion,
      policyContentDigest: compiled.contentDigest,
      policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
      ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
      evaluatorVersion: CG4_EVALUATOR_VERSION,
    },
  };
}

/** result of a reader that fails closed, in the same shape as a CG3 gate outcome: no callback consumed and no reservation */
export function cg4PolicyFailClosedOutcome(
  gate: 'POLICY_HEAD' | 'MIGRATION_SHADOW',
  reasonCode: string,
): Cg3GateOutcome {
  return {
    trace: [{ gate, outcome: 'REVIEW', reasonCode }],
    decision: 'REVIEW',
    reasonCode,
  };
}

/**
 * PII-safe digest of the decision result: excludes the contact/identity/callback id or policy version (which
 * naturally differ between a CG3 row and a CG4 version); compares only what the contacted person actually receives
 */
export function cg4ShadowDecisionDigest(outcome: Cg3GateOutcome): string {
  return stableDigest({
    decision: outcome.decision ?? 'ALLOW',
    reasonCode: outcome.reasonCode ?? 'POLICY_PASSED',
    nextEligibleAt: outcome.nextEligibleAt ?? null,
    matchedWindowRef: outcome.matchedWindowRef ?? null,
    timezoneSource: outcome.timezoneSource ?? null,
    exceptionMode: outcome.exceptionMode ?? null,
    overridesCallback: outcome.consumedCallbackRequestId !== undefined,
  });
}
