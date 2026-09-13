import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4AuthorizationReviewReason,
  type Cg4Digest,
  type Cg4SourceType,
  type ContactChannel,
} from '@d-contact/cxa-contracts';
import {
  cg4PolicyScopeMatches,
  cg4PolicyScopeSpecificity,
  cg4PolicyScopesAmbiguous,
} from './cg4-policy-compiler.js';

/**
 * CG4.5 (#188): pure resolution of "which policy version governs this request", with the
 * fail-closed rules from #176 §1/§4/§5. Kept separate from the lifecycle repository so it
 * can be unit-tested without a database and reused by the runtime reader when CG4.10
 * switches `authorizeAndReserve()` off the CG3 `publishedAt` tie-break onto these heads.
 *
 * There is deliberately no "latest published wins": equal-specificity overlap is an error,
 * and a due-but-unactivated schedule never falls back to the previous version.
 */

export interface Cg4ScopeHeadFacts {
  scopeKey: string;
  policyId: string;
  policyVersionId: string;
  policyVersion: number;
  policyContentDigest: Cg4Digest;
  schemaVersion: number;
  registryVersion: string;
  evaluatorVersion: string;
  headVersion: number;
  headDigest: Cg4Digest;
  /** Set while a scheduled candidate is waiting; cleared when it activates. */
  nextActivationAt: Date | null;
}

export interface Cg4PolicyRequestScope {
  channel?: ContactChannel;
  contactKind?: string;
  purpose?: string;
  sourceType?: Cg4SourceType;
}

export interface Cg4ResolvedPolicyHead {
  outcome: 'RESOLVED';
  head: Cg4ScopeHeadFacts;
  /** Upper bound for a mutable head cache entry (#176 §5). */
  validUntil: Date;
}

export type Cg4PolicyResolution =
  | Cg4ResolvedPolicyHead
  /** No CG4 policy governs this scope yet; the caller keeps its existing behaviour. */
  | { outcome: 'UNCONFIGURED' }
  | { outcome: 'FAIL_CLOSED'; reason: Cg4AuthorizationReviewReason; detail: string };

export interface ResolveCg4ActivePolicyInput {
  heads: readonly Cg4ScopeHeadFacts[];
  request: Cg4PolicyRequestScope;
  now: Date;
  cacheTtlSeconds: number;
}

export function resolveCg4ActivePolicy(input: ResolveCg4ActivePolicyInput): Cg4PolicyResolution {
  const matching = input.heads.filter((head) =>
    cg4PolicyScopeMatches(head.scopeKey, input.request),
  );
  if (matching.length === 0) return { outcome: 'UNCONFIGURED' };

  const best = Math.max(...matching.map((head) => cg4PolicyScopeSpecificity(head.scopeKey)));
  const winners = matching.filter((head) => cg4PolicyScopeSpecificity(head.scopeKey) === best);
  if (winners.length > 1) {
    const [first, second] = winners;
    // Two heads at the same specificity both matching one request is the ambiguity #176 §1
    // rejects at publish. Seeing it at read time means the invariant was already violated,
    // so the only safe answer is to refuse rather than pick one.
    return {
      outcome: 'FAIL_CLOSED',
      reason: 'GOVERNANCE_STATE_UNAVAILABLE',
      detail:
        first && second && cg4PolicyScopesAmbiguous(first.scopeKey, second.scopeKey)
          ? `scope ${first.scopeKey} และ ${second.scopeKey} กำกวมที่ specificity เดียวกัน`
          : 'มี active head มากกว่าหนึ่งตัวที่ specificity เดียวกัน',
    };
  }

  const head = winners[0] as Cg4ScopeHeadFacts;
  if (
    head.schemaVersion !== CG4_POLICY_SCHEMA_VERSION ||
    head.registryVersion !== CG4_RULE_REGISTRY_VERSION ||
    head.evaluatorVersion !== CG4_EVALUATOR_VERSION
  ) {
    return {
      outcome: 'FAIL_CLOSED',
      reason: 'GOVERNANCE_POLICY_VERSION_UNSUPPORTED',
      detail: `head ใช้ schema ${head.schemaVersion}/${head.registryVersion}/${head.evaluatorVersion}`,
    };
  }

  // A schedule that is already due but has not activated must never fall back to the
  // version it was meant to replace (#176 §4) — the scheduler is availability, not safety.
  if (head.nextActivationAt && head.nextActivationAt.getTime() <= input.now.getTime()) {
    return {
      outcome: 'FAIL_CLOSED',
      reason: 'POLICY_ACTIVATION_PENDING',
      detail: `scheduled activation ${head.nextActivationAt.toISOString()} ยังไม่ถูก activate`,
    };
  }

  const ttlBound = input.now.getTime() + input.cacheTtlSeconds * 1_000;
  const validUntil = new Date(
    head.nextActivationAt ? Math.min(ttlBound, head.nextActivationAt.getTime()) : ttlBound,
  );
  return { outcome: 'RESOLVED', head, validUntil };
}
