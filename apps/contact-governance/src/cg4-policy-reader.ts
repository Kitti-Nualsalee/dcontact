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
 * CG4.10 (#193) PR-B: head-based policy reader ที่ `authorizeAndReserve()` ใช้แทน CG3 loader
 * หลัง switch และใช้ประเมินคู่กันระหว่าง shadow
 *
 * อ่านจาก canonical head ใน transaction เดียวกับ decision เสมอ (ไม่ผ่าน cache) และไม่มี fallback:
 * head ที่กำกวม, version ที่ไม่รองรับ, content digest ไม่ตรง หรือ scheduled activation ที่ถึงเวลา
 * แต่ยังไม่ activate ได้ `FAIL_CLOSED` (#176 §4/§5, #179 §5)
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

  // schedule ที่ถึงเวลาแล้วแต่ยังไม่ activate ห้ามอ่าน version เดิมต่อ. scope ที่มี head อยู่แล้วถูกกันด้วย
  // head.nextActivationAt ซึ่ง publish แบบ immediate ล้างได้ (forward-fix); job ที่ worker park เป็น
  // FAILED จึงนับเฉพาะ scope ที่ยังไม่มี head เลย ไม่งั้น forward-fix จะปลด scope นั้นไม่ได้ตลอดไป
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
      detail: `scheduled activation ของ ${due.scopeKey} ถึงเวลาแล้วแต่ยังไม่ activate`,
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
    if (!row) return unavailable(`head ของ ${head.scopeKey} ชี้ policy version ที่ไม่มีอยู่`);
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
    return unavailable(error instanceof Error ? error.message : 'resolve head ไม่ได้');
  }
  if (resolution.outcome !== 'RESOLVED') return resolution;

  const head = resolution.head;
  const row = rowById.get(head.policyVersionId)!;
  if (row.status !== 'ACTIVE' || row.version !== head.policyVersion) {
    return unavailable(`head ของ ${head.scopeKey} ไม่ตรงกับ policy version ที่ ACTIVE`);
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
      detail: error instanceof Error ? error.message : 'compile policy ไม่ได้',
    };
  }
  // canonical content ต้อง hash ได้ตรงกับ digest ที่ approve ไว้ ไม่งั้น reader ไม่รู้ว่ากำลังบังคับอะไร
  if (compiled.contentDigest !== row.contentDigest) {
    return unavailable(`content digest ของ policy ${head.policyVersionId} ไม่ตรงกับที่บันทึกไว้`);
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

/** ผลของ reader ที่ fail closed ในรูปเดียวกับ CG3 gate outcome: ไม่มี callback consume และไม่มี reservation */
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
 * PII-safe digest ของผลการตัดสิน: ไม่รวม contact/identity/callback id หรือ policy version (ซึ่ง
 * ต่างกันระหว่าง CG3 row กับ CG4 version โดยธรรมชาติ) เทียบเฉพาะสิ่งที่ผู้ถูกติดต่อได้รับผลจริง
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
