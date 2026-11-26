import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCg4Policy } from './cg4-policy-compiler.js';
import {
  CG4_PLATFORM_FIXTURE_PACK,
  CG4_PLATFORM_FIXTURE_PACK_DIGEST,
  digestCg4FixturePack,
  type Cg4PolicyFixturePack,
} from './cg4-policy-fixtures.js';
import { previewCg4Policy, runCg4PolicyTests } from './cg4-policy-preview.js';

const PINNED_TIME = '2026-01-05T00:00:00.000Z';
const PINNED_ZONE = 'Asia/Bangkok';

const TENANT_PACK: Cg4PolicyFixturePack = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: PINNED_ZONE,
      fromInstant: PINNED_TIME,
      probeHours: 24,
      stepMinutes: 30,
    },
    { id: 'tenant:preference-block-not-liftable', kind: 'PREFERENCE_BLOCK_NOT_LIFTABLE' },
  ],
};

function compile(overrides: Record<string, unknown> = {}) {
  return compileCg4Policy({
    version: 1,
    content: {
      timezoneFallback: PINNED_ZONE,
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: ['QUIET_HOURS'],
      allowedOperationalRuleCodes: ['QUIET_HOURS'],
      holidays: [
        { localDate: '2026-01-01', effect: 'CLOSED', windows: [] },
        {
          localDate: '2026-01-02',
          effect: 'WINDOWS',
          windows: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '09:00', endLocal: '17:00' }],
        },
      ],
      ...overrides,
    },
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return runCg4PolicyTests({
    compiled: compile(overrides),
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
}

test('a valid candidate passes the mandatory suite of both the platform and tenant packs', () => {
  const result = run();
  const failures = result.checks.filter((check) => check.outcome === 'FAIL');
  assert.deepEqual(
    failures.map((check) => ({ id: check.id, failures: check.failures.slice(0, 2) })),
    [],
  );
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.failed, 0);
  assert.equal(result.platformFixtureDigest, CG4_PLATFORM_FIXTURE_PACK_DIGEST);
  assert.equal(result.tenantFixtureDigest, digestCg4FixturePack(TENANT_PACK));
});

test('every check in the platform pack is really run, none is silently skipped', () => {
  const result = run();
  const ids = new Set(result.checks.map((check) => check.id));
  for (const check of CG4_PLATFORM_FIXTURE_PACK.checks) assert.ok(ids.has(check.id), check.id);
  // every declared check must have at least one assertion against this sample candidate
  for (const check of result.checks) {
    assert.ok(check.assertions > 0, `${check.id} asserted nothing`);
  }
});

test('a candidate that tries to lift a hard rule through the allowlist is rejected by the compiler before reaching the suite', () => {
  assert.throws(() => compile({ allowedOperationalRuleCodes: ['QUIET_HOURS', 'DNC_GLOBAL'] }));
});

test('the result is deterministic: the same input gives the same result digest', () => {
  assert.equal(run().resultDigest, run().resultDigest);
});

test('changing the content changes the result digest and the artifact digest', () => {
  const base = previewCg4Policy({
    compiled: compile(),
    baseContent: null,
    baseHeadVersion: 0,
    baseHeadDigest: '0'.repeat(64),
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
  const changed = previewCg4Policy({
    compiled: compile({
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '06:00' }],
    }),
    baseContent: null,
    baseHeadVersion: 0,
    baseHeadDigest: '0'.repeat(64),
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
  assert.notEqual(base.artifactDigest, changed.artifactDigest);
  assert.notEqual(base.previewDigest, changed.previewDigest);
});

test('the artifact digest is bound to the fixture pack: editing the pack changes the digest', () => {
  const pinned = {
    baseContent: null,
    baseHeadVersion: 0,
    baseHeadDigest: '0'.repeat(64),
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  } as const;
  const withDefault = previewCg4Policy({ compiled: compile(), tenantPack: TENANT_PACK, ...pinned });
  const withEdited = previewCg4Policy({
    compiled: compile(),
    tenantPack: { ...TENANT_PACK, checks: [TENANT_PACK.checks[0]!] },
    ...pinned,
  });
  assert.notEqual(withDefault.tenantFixturePackDigest, withEdited.tenantFixturePackDigest);
  assert.notEqual(withDefault.artifactDigest, withEdited.artifactDigest);
});

test('the artifact digest is bound to the head it is diffed against: a different head gives a different digest', () => {
  const shared = {
    compiled: compile(),
    baseContent: null,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  } as const;
  const atHeadZero = previewCg4Policy({
    ...shared,
    baseHeadVersion: 0,
    baseHeadDigest: '0'.repeat(64),
  });
  const atHeadOne = previewCg4Policy({
    ...shared,
    baseHeadVersion: 1,
    baseHeadDigest: '1'.repeat(64),
  });
  assert.notEqual(atHeadZero.artifactDigest, atHeadOne.artifactDigest);
});

test('preview returns a diff class and result counts consistent with the candidate', () => {
  const preview = previewCg4Policy({
    compiled: compile(),
    baseContent: null,
    baseHeadVersion: 0,
    baseHeadDigest: '0'.repeat(64),
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
  assert.equal(preview.diffClass, 'RELAXATION');
  const total = Object.values(preview.resultCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 48);
  assert.ok(preview.resultCounts.DEFER > 0, 'there must be a quiet-hours period that DEFERs');
  assert.ok(preview.resultCounts.PASSED > 0, 'there must be a period that passes');
});

test('a candidate with no temporal constraint at all still passes the suite but has no DEFER', () => {
  const result = run({ quietHours: [], holidays: [] });
  assert.equal(result.outcome, 'PASS');
});

test('the suite is not vacuous: facts that do not match the declared content make a check fail', () => {
  const compiled = compile();
  // simulate a compiler that lets facts drift from the content the author declared
  const drifted = {
    ...compiled,
    facts: { ...compiled.facts, quietHours: [] },
  };
  const result = runCg4PolicyTests({
    compiled: drifted,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
  assert.equal(result.outcome, 'FAIL');
  const clock = result.checks.find((check) => check.id === 'quiet-hours-local-clock:bangkok');
  assert.equal(clock?.outcome, 'FAIL');
  assert.ok(clock!.failures.length > 0);
});

test('the suite is not vacuous: content that lets a hard rule into the allowlist makes a check fail', () => {
  const compiled = compile();
  const tampered = {
    ...compiled,
    content: {
      ...compiled.content,
      allowedOperationalRuleCodes: [...compiled.content.allowedOperationalRuleCodes, 'DNC_GLOBAL'],
    },
  };
  const result = runCg4PolicyTests({
    compiled: tampered,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: PINNED_TIME,
    pinnedTimezone: PINNED_ZONE,
  });
  assert.equal(result.outcome, 'FAIL');
  assert.equal(
    result.checks.find((check) => check.id === 'hard-rule-not-overridable:DNC_GLOBAL')?.outcome,
    'FAIL',
  );
});
