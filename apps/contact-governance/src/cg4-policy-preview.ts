import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  canonicalCg4Digest,
  type Cg4Digest,
  type Cg4PolicyDiffClass,
  type ContactChannel,
  type ContactDecision,
} from '@d-contact/cxa-contracts';
import {
  evaluateCg3Policy,
  zonedPartsAt,
  zonedToUtc,
  type Cg3EvaluationInput,
  type Cg3GateOutcome,
  type Cg3PreferenceCandidate,
} from './cg3-policy-evaluator.js';
import type { Cg4ExceptionFacts } from './cg4-exception-evaluation.js';
import { resolveCg4RuleMetadata } from './cg4-rule-registry.js';
import type { Cg4CompiledPolicy, Cg4PolicyContentV1 } from './cg4-policy-compiler.js';
import { classifyCg4PolicyDiff, type Cg4PolicyDiff } from './cg4-policy-diff.js';
import {
  CG4_PLATFORM_FIXTURE_PACK,
  digestCg4FixturePack,
  type Cg4PolicyCheck,
  type Cg4PolicyFixturePack,
} from './cg4-policy-fixtures.js';

/**
 * CG4.5 (#188): deterministic preview/test runner.
 *
 * Every evaluation here goes through `evaluateCg3Policy` — the same function
 * `authorizeAndReserve()` calls — because #176 §2 forbids an alternate preview
 * evaluator. Time is pinned by the caller and never read from the host clock, so the
 * same candidate + packs + pinned time always produce the same artifact digest.
 */

const PROBE_CHANNEL: ContactChannel = 'VOICE';
const PROBE_PURPOSE = 'SERVICE_NOTIFICATION';
const PROBE_IDENTITY = 'cg4-preview-identity';
const PROBE_SOURCE_TYPE = 'DIALER';
const PROBE_SOURCE_ID = 'cg4-preview-source';
const PROBE_DIGEST = 'f'.repeat(64);

export interface Cg4PolicyCheckResult {
  id: string;
  kind: Cg4PolicyCheck['kind'];
  outcome: 'PASS' | 'FAIL';
  /** How many concrete probes the check ran; 0 means the candidate declares nothing to probe. */
  assertions: number;
  failures: readonly string[];
}

export interface Cg4PolicyTestRun {
  suiteVersion: string;
  platformFixtureDigest: Cg4Digest;
  tenantFixtureDigest: Cg4Digest;
  outcome: 'PASS' | 'FAIL';
  passed: number;
  failed: number;
  checks: readonly Cg4PolicyCheckResult[];
  resultDigest: Cg4Digest;
}

export interface RunCg4PolicyTestsInput {
  compiled: Cg4CompiledPolicy;
  /** Synthetic tenant pack; #176 §2 makes one mandatory alongside the platform pack. */
  tenantPack: Cg4PolicyFixturePack;
  platformPack?: Cg4PolicyFixturePack;
  pinnedEvaluationTime: string;
  pinnedTimezone: string;
}

// ── Probe construction ───────────────────────────────────────────────────────

function baseInput(
  compiled: Cg4CompiledPolicy,
  now: Date,
  timezone: string,
  overrides: Partial<Cg3EvaluationInput> = {},
): Cg3EvaluationInput {
  return {
    now,
    identityId: PROBE_IDENTITY,
    channel: PROBE_CHANNEL,
    purpose: PROBE_PURPOSE,
    // The probe pins the clock it is asserting against. `policy.timezoneFallback` outranks
    // the tenant default in the evaluator's chain, so a check that only set the tenant
    // default would silently be evaluated in the policy's own zone instead.
    customerExplicitTimezone: timezone,
    tenantDefaultTimezone: timezone,
    preferences: [],
    policy: compiled.facts,
    source: PROBE_SOURCE_TYPE,
    sourceId: PROBE_SOURCE_ID,
    ...overrides,
  };
}

function exceptionFor(
  compiled: Cg4CompiledPolicy,
  ruleCode: string,
  now: Date,
  overrides: Partial<Cg4ExceptionFacts> = {},
): Cg4ExceptionFacts {
  return {
    seriesId: 'cg4-preview-exception',
    revisionId: 'cg4-preview-exception-revision',
    revision: 1,
    workflowState: 'APPROVED',
    identityId: PROBE_IDENTITY,
    scopeKind: 'EXACT_IDENTITY',
    channel: PROBE_CHANNEL,
    purpose: PROBE_PURPOSE,
    sourceType: PROBE_SOURCE_TYPE,
    sourceId: PROBE_SOURCE_ID,
    allowedRuleCodes: [ruleCode],
    policyId: 'cg4-preview-policy',
    policyVersionId: 'cg4-preview-policy-version',
    policyVersion: compiled.facts.version,
    policyContentDigest: compiled.contentDigest,
    currentPolicyContentDigest: compiled.contentDigest,
    policyAllowedRuleCodes: compiled.content.allowedOperationalRuleCodes,
    registryVersion: CG4_RULE_REGISTRY_VERSION,
    startsAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 60_000),
    tier: 'STANDARD',
    contentDigest: PROBE_DIGEST,
    approvalDigest: PROBE_DIGEST,
    ...overrides,
  };
}

/** Only the parts of an outcome a policy author can influence; used for equality asserts. */
function outcomeShape(outcome: Cg3GateOutcome) {
  return {
    decision: outcome.decision ?? 'PASSED',
    reasonCode: outcome.reasonCode ?? null,
    appliedExceptions: (outcome.appliedExceptions ?? []).map((pin) => pin.matchedRuleCode).sort(),
  };
}

function sameOutcome(left: Cg3GateOutcome, right: Cg3GateOutcome): boolean {
  return canonicalCg4Digest(outcomeShape(left)) === canonicalCg4Digest(outcomeShape(right));
}

function probeInstants(check: Cg4PolicyCheck, fallbackFrom: Date): Date[] {
  const from = check.fromInstant ? new Date(check.fromInstant) : fallbackFrom;
  const hours = check.probeHours ?? 24;
  const step = check.stepMinutes ?? 60;
  const instants: Date[] = [];
  for (let minute = 0; minute < hours * 60; minute += step) {
    instants.push(new Date(from.getTime() + minute * 60_000));
  }
  return instants;
}

function withinDeclaredQuietHours(content: Cg4PolicyContentV1, weekday: number, minute: number) {
  return content.quietHours.some((window) => {
    if (!window.daysOfWeek.includes(weekday)) return false;
    const [startHour = 0, startMinute = 0] = window.startLocal.split(':').map(Number);
    const [endHour = 0, endMinute = 0] = window.endLocal.split(':').map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return end > start ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

function localDateKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// ── Checks ───────────────────────────────────────────────────────────────────

interface CheckContext {
  compiled: Cg4CompiledPolicy;
  pinnedNow: Date;
  pinnedTimezone: string;
}

type CheckRunner = (
  check: Cg4PolicyCheck,
  context: CheckContext,
) => {
  assertions: number;
  failures: string[];
};

/** Runs one defective-exception variant against a no-exception baseline at each probe. */
function inertExceptionCheck(
  label: string,
  mutate: (compiled: Cg4CompiledPolicy, ruleCode: string, now: Date) => Partial<Cg4ExceptionFacts>,
): CheckRunner {
  return (check, { compiled, pinnedNow, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const failures: string[] = [];
    let assertions = 0;
    for (const instant of probeInstants(check, pinnedNow)) {
      const baseline = evaluateCg3Policy(baseInput(compiled, instant, timezone));
      // Only a provisional temporal failure can be lifted at all, so a baseline that
      // already passes or already blocks hard tells us nothing about inertness.
      if (baseline.decision !== 'DEFER' || !baseline.reasonCode) continue;
      const variant = evaluateCg3Policy(
        baseInput(compiled, instant, timezone, {
          activeExceptions: [
            exceptionFor(
              compiled,
              baseline.reasonCode,
              instant,
              mutate(compiled, baseline.reasonCode, instant),
            ),
          ],
        }),
      );
      assertions += 1;
      if (!sameOutcome(baseline, variant)) {
        failures.push(
          `${label} exception เปลี่ยนผลที่ ${instant.toISOString()}: ` +
            `${JSON.stringify(outcomeShape(baseline))} -> ${JSON.stringify(outcomeShape(variant))}`,
        );
      }
    }
    return { assertions, failures };
  };
}

const CHECK_RUNNERS: Readonly<Record<Cg4PolicyCheck['kind'], CheckRunner>> = Object.freeze({
  HARD_RULE_NOT_OVERRIDABLE: (check, { compiled }) => {
    const failures: string[] = [];
    const ruleCode = check.ruleCode ?? '';
    const resolution = resolveCg4RuleMetadata(ruleCode);
    if (resolution.metadata.overridable) {
      failures.push(`registry ประกาศว่า ${ruleCode} override ได้`);
    }
    if (compiled.content.overridableRules.includes(ruleCode)) {
      failures.push(`overridableRules มี ${ruleCode}`);
    }
    if (compiled.content.allowedOperationalRuleCodes.includes(ruleCode)) {
      failures.push(`allowedOperationalRuleCodes มี ${ruleCode}`);
    }
    return { assertions: 3, failures };
  },

  CAP_RULE_RISK_FLOOR: (check, _context) => {
    const ruleCode = check.ruleCode ?? '';
    const { metadata } = resolveCg4RuleMetadata(ruleCode);
    const failures =
      metadata.riskFloor === (check.riskFloor ?? 'HIGH')
        ? []
        : [`${ruleCode} riskFloor เป็น ${metadata.riskFloor} ไม่ใช่ ${check.riskFloor}`];
    return { assertions: 1, failures };
  },

  PREFERENCE_BLOCK_NOT_LIFTABLE: (check, { compiled, pinnedNow, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const preference: Cg3PreferenceCandidate = {
      version: 1,
      identityId: PROBE_IDENTITY,
      channel: PROBE_CHANNEL,
      purpose: PROBE_PURPOSE,
      contactKind: null,
      decision: 'BLOCK',
      timezone: null,
      preferredWindows: [],
    };
    const failures: string[] = [];
    let assertions = 0;
    for (const instant of probeInstants(check, pinnedNow)) {
      const outcome = evaluateCg3Policy(
        baseInput(compiled, instant, timezone, {
          preferences: [preference],
          activeExceptions: compiled.content.allowedOperationalRuleCodes.map((ruleCode) =>
            exceptionFor(compiled, ruleCode, instant),
          ),
        }),
      );
      assertions += 1;
      if (outcome.decision !== 'BLOCK' || outcome.reasonCode !== 'PREFERENCE_BLOCKED') {
        failures.push(
          `preference BLOCK ถูกยกที่ ${instant.toISOString()}: ${JSON.stringify(outcomeShape(outcome))}`,
        );
      }
    }
    return { assertions, failures };
  },

  EXCEPTION_OUT_OF_SCOPE_IS_INERT: inertExceptionCheck('out-of-scope', () => ({
    sourceId: 'a-different-source',
  })),
  EXCEPTION_EXPIRED_IS_INERT: inertExceptionCheck('expired', (_compiled, _rule, now) => ({
    startsAt: new Date(now.getTime() - 7_200_000),
    expiresAt: new Date(now.getTime() - 3_600_000),
  })),
  EXCEPTION_STALE_BINDING_IS_INERT: inertExceptionCheck('stale-binding', () => ({
    currentPolicyContentDigest: '0'.repeat(64),
  })),
  EXCEPTION_OUTSIDE_ALLOWLIST_IS_INERT: inertExceptionCheck('outside-allowlist', () => ({
    policyAllowedRuleCodes: [],
  })),
  EXCEPTION_UNKNOWN_REGISTRY_IS_INERT: inertExceptionCheck('unknown-registry', () => ({
    registryVersion: 'CG4_RULE_REGISTRY_V0',
  })),

  EXCEPTION_IN_SCOPE_LIFTS_ALLOWED_RULE: (check, { compiled, pinnedNow, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const failures: string[] = [];
    let assertions = 0;
    for (const instant of probeInstants(check, pinnedNow)) {
      const baseline = evaluateCg3Policy(baseInput(compiled, instant, timezone));
      if (baseline.decision !== 'DEFER' || !baseline.reasonCode) continue;
      const ruleCode = baseline.reasonCode;
      const variant = evaluateCg3Policy(
        baseInput(compiled, instant, timezone, {
          activeExceptions: [exceptionFor(compiled, ruleCode, instant)],
        }),
      );
      assertions += 1;
      const allowed = compiled.content.allowedOperationalRuleCodes.includes(ruleCode);
      if (allowed) {
        const pinned = (variant.appliedExceptions ?? []).some(
          (pin) => pin.matchedRuleCode === ruleCode,
        );
        if (variant.decision !== undefined || !pinned) {
          failures.push(
            `exception ที่ครอบ ${ruleCode} ไม่ยก provisional failure ที่ ${instant.toISOString()}`,
          );
        }
      } else if (!sameOutcome(baseline, variant)) {
        failures.push(
          `${ruleCode} ไม่อยู่ใน allowlist แต่ exception เปลี่ยนผลที่ ${instant.toISOString()}`,
        );
      }
    }
    return { assertions, failures };
  },

  QUIET_HOURS_FOLLOW_LOCAL_CLOCK: (check, { compiled, pinnedNow, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const failures: string[] = [];
    let assertions = 0;
    for (const instant of probeInstants(check, pinnedNow)) {
      const parts = zonedPartsAt(instant, timezone);
      const dateKey = localDateKey(parts);
      // A holiday entry takes precedence over quiet hours in the evaluator, so those
      // dates are covered by the holiday checks instead.
      if (compiled.content.holidays.some((entry) => entry.localDate === dateKey)) continue;
      const expectedQuiet = withinDeclaredQuietHours(
        compiled.content,
        parts.weekday,
        parts.hour * 60 + parts.minute,
      );
      const outcome = evaluateCg3Policy(baseInput(compiled, instant, timezone));
      const observedQuiet = outcome.reasonCode === 'QUIET_HOURS';
      assertions += 1;
      if (expectedQuiet !== observedQuiet) {
        failures.push(
          `quiet hours ไม่ตรง local clock ที่ ${instant.toISOString()} (${timezone} ` +
            `${dateKey} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}): ` +
            `ประกาศ ${expectedQuiet} แต่ประเมินได้ ${observedQuiet}`,
        );
      }
    }
    return { assertions, failures };
  },

  CLOSED_HOLIDAY_BLOCKS_WHOLE_LOCAL_DAY: (check, { compiled, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const step = check.stepMinutes ?? 30;
    const failures: string[] = [];
    let assertions = 0;
    for (const entry of compiled.content.holidays.filter((row) => row.effect === 'CLOSED')) {
      const [year = 0, month = 1, day = 1] = entry.localDate.split('-').map(Number);
      for (let minute = 0; minute < 1440; minute += step) {
        const instant = zonedToUtc(
          year,
          month,
          day,
          Math.floor(minute / 60),
          minute % 60,
          timezone,
        );
        const outcome = evaluateCg3Policy(baseInput(compiled, instant, timezone));
        assertions += 1;
        if (outcome.reasonCode !== 'TENANT_HOLIDAY') {
          failures.push(
            `วันหยุด CLOSED ${entry.localDate} ไม่ block ที่นาที ${minute} (${outcome.reasonCode ?? 'PASSED'})`,
          );
        }
      }
    }
    return { assertions, failures };
  },

  WINDOWS_HOLIDAY_BLOCKS_OUTSIDE_WINDOWS: (check, { compiled, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const step = check.stepMinutes ?? 30;
    const failures: string[] = [];
    let assertions = 0;
    for (const entry of compiled.content.holidays.filter((row) => row.effect === 'WINDOWS')) {
      const [year = 0, month = 1, day = 1] = entry.localDate.split('-').map(Number);
      for (let minute = 0; minute < 1440; minute += step) {
        const instant = zonedToUtc(
          year,
          month,
          day,
          Math.floor(minute / 60),
          minute % 60,
          timezone,
        );
        const parts = zonedPartsAt(instant, timezone);
        const insideWindow = entry.windows.some((window) => {
          if (!window.daysOfWeek.includes(parts.weekday)) return false;
          const [startHour = 0, startMinute = 0] = window.startLocal.split(':').map(Number);
          const [endHour = 0, endMinute = 0] = window.endLocal.split(':').map(Number);
          const start = startHour * 60 + startMinute;
          const end = endHour * 60 + endMinute;
          const local = parts.hour * 60 + parts.minute;
          return end > start ? local >= start && local < end : local >= start || local < end;
        });
        const outcome = evaluateCg3Policy(baseInput(compiled, instant, timezone));
        assertions += 1;
        if (!insideWindow && outcome.reasonCode !== 'TENANT_HOLIDAY') {
          failures.push(
            `วันหยุด WINDOWS ${entry.localDate} ไม่ block นอก window ที่นาที ${minute}`,
          );
        }
        if (insideWindow && outcome.reasonCode === 'TENANT_HOLIDAY') {
          failures.push(`วันหยุด WINDOWS ${entry.localDate} block ใน window ที่นาที ${minute}`);
        }
      }
    }
    return { assertions, failures };
  },

  DETERMINISTIC_REPLAY: (check, { compiled, pinnedNow, pinnedTimezone }) => {
    const timezone = check.timezone ?? pinnedTimezone;
    const failures: string[] = [];
    let assertions = 0;
    for (const instant of probeInstants(check, pinnedNow)) {
      const first = evaluateCg3Policy(baseInput(compiled, instant, timezone));
      const second = evaluateCg3Policy(baseInput(compiled, instant, timezone));
      assertions += 1;
      if (!sameOutcome(first, second)) {
        failures.push(`ประเมินซ้ำที่ ${instant.toISOString()} ให้ผลต่างกัน`);
      }
    }
    return { assertions, failures };
  },
});

function runPack(pack: Cg4PolicyFixturePack, context: CheckContext): Cg4PolicyCheckResult[] {
  return pack.checks.map((check) => {
    const runner = CHECK_RUNNERS[check.kind];
    if (!runner) {
      return {
        id: check.id,
        kind: check.kind,
        outcome: 'FAIL' as const,
        assertions: 0,
        failures: [`ไม่รู้จัก check kind ${check.kind}`],
      };
    }
    const { assertions, failures } = runner(check, context);
    return {
      id: check.id,
      kind: check.kind,
      outcome: failures.length === 0 ? ('PASS' as const) : ('FAIL' as const),
      assertions,
      failures,
    };
  });
}

/**
 * Runs the mandatory platform pack plus the tenant's synthetic pack against the compiled
 * candidate. Both digests land in the result so an approval can bind them; a later run
 * with an edited pack produces a different digest and fails the freshness check.
 */
export function runCg4PolicyTests(input: RunCg4PolicyTestsInput): Cg4PolicyTestRun {
  const pinnedNow = new Date(input.pinnedEvaluationTime);
  if (Number.isNaN(pinnedNow.getTime())) {
    throw new TypeError('pinnedEvaluationTime ต้องเป็น ISO-8601 timestamp');
  }
  const platformPack = input.platformPack ?? CG4_PLATFORM_FIXTURE_PACK;
  const context: CheckContext = {
    compiled: input.compiled,
    pinnedNow,
    pinnedTimezone: input.pinnedTimezone,
  };
  const checks = [...runPack(platformPack, context), ...runPack(input.tenantPack, context)];
  const failed = checks.filter((check) => check.outcome === 'FAIL').length;
  const run = {
    suiteVersion: `${platformPack.suiteVersion}+${input.tenantPack.suiteVersion}`,
    platformFixtureDigest: digestCg4FixturePack(platformPack),
    tenantFixtureDigest: digestCg4FixturePack(input.tenantPack),
    outcome: failed === 0 ? ('PASS' as const) : ('FAIL' as const),
    passed: checks.length - failed,
    failed,
    checks,
  };
  return {
    ...run,
    resultDigest: canonicalCg4Digest({
      ...run,
      contentDigest: input.compiled.contentDigest,
      pinnedEvaluationTime: pinnedNow.toISOString(),
      pinnedTimezone: input.pinnedTimezone,
    }),
  };
}

export interface Cg4PolicyPreview {
  contractVersion: typeof CG4_CONTRACT_VERSION;
  policySchemaVersion: typeof CG4_POLICY_SCHEMA_VERSION;
  ruleRegistryVersion: typeof CG4_RULE_REGISTRY_VERSION;
  evaluatorVersion: typeof CG4_EVALUATOR_VERSION;
  policyContentDigest: Cg4Digest;
  platformFixturePackDigest: Cg4Digest;
  tenantFixturePackDigest: Cg4Digest;
  baseHeadVersion: number;
  baseHeadDigest: Cg4Digest;
  diffClass: Cg4PolicyDiffClass;
  diffDigest: Cg4Digest;
  diff: Cg4PolicyDiff;
  tests: Cg4PolicyTestRun;
  resultCounts: Readonly<Record<ContactDecision | 'PASSED', number>>;
  artifactDigest: Cg4Digest;
  previewDigest: Cg4Digest;
}

export interface PreviewCg4PolicyInput extends RunCg4PolicyTestsInput {
  /** Content of the scope's current ACTIVE head, or null for the first version. */
  baseContent: Cg4PolicyContentV1 | null;
  baseHeadVersion: number;
  baseHeadDigest: Cg4Digest;
}

/**
 * The single artifact an approval binds to (#176 §2): candidate identity + evaluator and
 * registry versions + both fixture-pack digests + the head it was diffed against + the
 * diff class + the test result. Anything that moves changes `artifactDigest`, which is
 * what makes a stale approval detectable instead of silently reusable.
 */
export function previewCg4Policy(input: PreviewCg4PolicyInput): Cg4PolicyPreview {
  const diff = classifyCg4PolicyDiff(input.baseContent, input.compiled.content);
  const tests = runCg4PolicyTests(input);
  const pinnedNow = new Date(input.pinnedEvaluationTime);

  const counts: Record<ContactDecision | 'PASSED', number> = {
    ALLOW: 0,
    BLOCK: 0,
    DEFER: 0,
    REVIEW: 0,
    PASSED: 0,
  };
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const outcome = evaluateCg3Policy(
      baseInput(
        input.compiled,
        new Date(pinnedNow.getTime() + minute * 60_000),
        input.pinnedTimezone,
      ),
    );
    counts[outcome.decision ?? 'PASSED'] += 1;
  }

  const binding = {
    contractVersion: CG4_CONTRACT_VERSION,
    policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
    policyContentDigest: input.compiled.contentDigest,
    platformFixturePackDigest: tests.platformFixtureDigest,
    tenantFixturePackDigest: tests.tenantFixtureDigest,
    baseHeadVersion: input.baseHeadVersion,
    baseHeadDigest: input.baseHeadDigest,
    diffClass: diff.diffClass,
    diffDigest: diff.diffDigest,
  } as const;

  const artifactDigest = canonicalCg4Digest({
    ...binding,
    testResultDigest: tests.resultDigest,
    outcome: tests.outcome,
    passed: tests.passed,
    failed: tests.failed,
  });

  return {
    ...binding,
    diff,
    tests,
    resultCounts: counts,
    artifactDigest,
    previewDigest: canonicalCg4Digest({
      artifactDigest,
      resultCounts: counts,
      pinnedEvaluationTime: pinnedNow.toISOString(),
      pinnedTimezone: input.pinnedTimezone,
    }),
  };
}
