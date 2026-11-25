import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG3_BASELINE_SHA,
  CG4_DIMENSIONS,
  CG4_FIXED_FLAGS,
  CG4_MARKER,
  CXA_CG4_READINESS_CHECKS,
  assertPiiSafeEvidence,
  assertValidCxaCg4EvidenceManifest,
  cg4FailureDetail,
  cg4MarkerBlockers,
  cg4SuitePlan,
  executeCg4Suite,
  parseTapSummary,
  runCxaCg4Readiness,
  sha256,
} from './cxa-cg4-readiness.mjs';
import { cxaCg4ProfileSummary } from './cxa-cg4-profile-readiness.mjs';
import {
  CG3_MARKER,
  S1_REGRESSION_SCRIPTS,
  cxaCg4DependencySummary,
} from './cxa-cg4-dependency-readiness.mjs';

const SHA = 'b'.repeat(40);
const finalMainContext = Object.freeze({
  repository: 'Kitti-Nualsalee/dcontact',
  defaultBranch: 'main',
  ref: 'refs/heads/main',
  pullRequest: null,
  baseSha: SHA,
  commitSha: SHA,
  finalMainSha: SHA,
  expectedCommitSha: SHA,
  cleanTree: true,
  runId: '123456',
  attempt: 1,
  runUrl: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123456/attempts/1',
  artifact: {
    name: `cxa-cg4-evidence-${SHA}`,
    url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123456/attempts/1#artifacts',
    immutable: true,
  },
});

const passingRegression = Object.fromEntries(
  S1_REGRESSION_SCRIPTS.map((script) => [script, 'PASS']),
);
const dependencyEvidence = {
  type: 'dependency.readiness',
  workflow: 'cxa-cg4-dependency',
  status: 'PASS',
  commitSha: SHA,
  cg3: 'INTEGRATED_SAME_SHA',
  cg3Marker: CG3_MARKER,
  s1ManifestSha256: 'c'.repeat(64),
  s1Regression: passingRegression,
  j2: 'CONTRACT_COMPATIBLE',
  j2ManifestSha256: null,
};

const isScript = (suite, name) => String(suite.command.at(-1)).endsWith(name);

function passingSuite(suite) {
  const evidence = isScript(suite, 'cxa-cg4-dependency-readiness.mjs')
    ? [dependencyEvidence]
    : isScript(suite, 'cxa-cg4-profile-readiness.mjs')
      ? [cxaCg4ProfileSummary({})]
      : undefined;
  const isTap = suite.command.includes('--test');
  return {
    status: 'PASS',
    durationMs: 1,
    ...(isTap
      ? {
          tap: {
            tests: 3,
            passed: 3,
            failed: 0,
            cancelled: 0,
            skipped: 0,
            todo: 0,
            titlesSha256: 'd'.repeat(64),
          },
        }
      : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function run(options = {}) {
  return runCxaCg4Readiness({
    context: options.context ?? finalMainContext,
    executeSuite: options.executeSuite ?? passingSuite,
    now: () => new Date('2026-09-15T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
    digests: { registry: 'd'.repeat(64), migrations: 'e'.repeat(64) },
  });
}

test('CG4 registry has all 25 mandatory checks across 9 dimensions per #178', () => {
  assert.deepEqual(
    CXA_CG4_READINESS_CHECKS.map(({ id }) => id),
    [
      'CG4-F01',
      'CG4-F02',
      'CG4-F03',
      'CG4-F04',
      'CG4-F05',
      'CG4-UX01',
      'CG4-TI01',
      'CG4-TI02',
      'CG4-AU01',
      'CG4-AU02',
      'CG4-ID01',
      'CG4-ID02',
      'CG4-CC01',
      'CG4-CC02',
      'CG4-CC03',
      'CG4-CC04',
      'CG4-RC01',
      'CG4-RC02',
      'CG4-RC03',
      'CG4-MG01',
      'CG4-MG02',
      'CG4-OB01',
      'CG4-OB02',
      'CG4-REG01',
      'CG4-REG02',
    ],
  );
  assert.deepEqual(
    [...new Set(CXA_CG4_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
    [...CG4_DIMENSIONS].sort(),
  );
  for (const item of CXA_CG4_READINESS_CHECKS) {
    assert.ok(item.commands.length > 0, item.id);
    assert.ok(item.boundaries.length > 0, item.id);
    // the unit of a suite is a single file: a tsx --test command must have a single test file
    for (const command of item.commands.filter((entry) => entry.includes('--test'))) {
      assert.equal(command.filter((part) => /\.(test|integration|spec)\.ts$/.test(part)).length, 1);
    }
  }
});

test('A: CG4-REG01 does not run S1 nested (#572) and does not re-run build/typecheck/lint/E0/C1/Inbound Voice', () => {
  const regression = CXA_CG4_READINESS_CHECKS.find(({ id }) => id === 'CG4-REG01');
  const scripts = regression.commands.map((command) => command.at(-1));
  assert.deepEqual(scripts.length, 1);
  assert.ok(scripts[0].endsWith('cxa-cg4-dependency-readiness.mjs'));
  assert.ok(
    !CXA_CG4_READINESS_CHECKS.some((item) =>
      item.commands.some((command) => command.some((part) => /:acceptance$/.test(String(part)))),
    ),
  );
  // compare only root `pnpm <script>` commands like S1-REG-01 - `pnpm --filter console build` is a different command
  for (const duplicated of S1_REGRESSION_SCRIPTS) {
    assert.equal(
      CXA_CG4_READINESS_CHECKS.some((item) =>
        item.commands.some((command) => command.length === 2 && command.at(-1) === duplicated),
      ),
      false,
      duplicated,
    );
  }
});

test('B: the suite plan runs each file once even when several checks reference the same file', () => {
  const suites = cg4SuitePlan();
  const totalCommands = CXA_CG4_READINESS_CHECKS.reduce(
    (sum, item) => sum + item.commands.length,
    0,
  );
  assert.ok(suites.length < totalCommands, `${suites.length} < ${totalCommands}`);
  assert.equal(new Set(suites.map(({ command }) => JSON.stringify(command))).size, suites.length);
  const cg4Api = suites.find((suite) =>
    isScript(suite, 'contact-governance-cg4-api.integration.ts'),
  );
  assert.ok(cg4Api.checkIds.length >= 7, cg4Api.checkIds.join());

  const executed = new Map();
  const result = run({
    executeSuite(suite) {
      executed.set(suite.id, (executed.get(suite.id) ?? 0) + 1);
      return passingSuite(suite);
    },
  });
  assert.equal(executed.size, suites.length);
  assert.ok([...executed.values()].every((count) => count === 1));
  assert.equal(result.manifest.suites.length, suites.length);
});

test('a final main run with 25/25 PASS plus dependency/profile issues CONTACT_GOVERNANCE_CG4_ACCEPTED', () => {
  const result = run();
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, [CG4_MARKER]);
  assert.deepEqual(result.manifest.markers, [CG4_MARKER]);
  assert.deepEqual(result.manifest.flags, CG4_FIXED_FLAGS);
  assert.equal(result.manifest.baselineSha, CG3_BASELINE_SHA);
  assert.equal(result.manifest.dimensions.length, 9);
  assert.doesNotThrow(() => assertValidCxaCg4EvidenceManifest(result.manifest));
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
});

test('marker suppression: PR run, non-final SHA, dirty tree, local artifact, CG3 marker and S1 regression', () => {
  const cases = [
    [{ pullRequest: 241 }, 'PULL_REQUEST_RUN'],
    [{ ref: 'refs/heads/claude/cg4-11' }, 'NOT_DEFAULT_BRANCH_REF'],
    [{ finalMainSha: 'a'.repeat(40) }, 'NOT_FINAL_MAIN_SHA'],
    [{ expectedCommitSha: 'a'.repeat(40) }, 'NOT_FINAL_MAIN_SHA'],
    [{ cleanTree: false }, 'DIRTY_TREE'],
    [
      { runUrl: null, artifact: { name: `cxa-cg4-evidence-${SHA}`, url: null, immutable: false } },
      'ARTIFACT_NOT_IMMUTABLE',
    ],
  ];
  for (const [override, blocker] of cases) {
    const result = run({ context: { ...finalMainContext, ...override } });
    assert.deepEqual(result.summary.markers, [], blocker);
    assert.equal(result.manifest.markers, undefined, blocker);
    assert.ok(result.summary.markerBlockers.includes(blocker), blocker);
  }

  const withDependency = (dependency) =>
    run({
      executeSuite(suite) {
        const base = passingSuite(suite);
        return isScript(suite, 'cxa-cg4-dependency-readiness.mjs')
          ? { ...base, evidence: [dependency] }
          : base;
      },
    });
  assert.ok(
    withDependency({
      ...dependencyEvidence,
      cg3: 'CANDIDATE_NOT_FINAL_MAIN',
      cg3Marker: null,
    }).summary.markerBlockers.includes('CG3_MARKER_NOT_SAME_SHA'),
  );
  assert.ok(
    withDependency({
      ...dependencyEvidence,
      s1Regression: { ...passingRegression, 'voice:acceptance': 'MISSING' },
    }).summary.markerBlockers.includes('S1_REGRESSION_NOT_PASS'),
  );
});

test('a failed suite fails every check that references that suite, and the marker is not issued', () => {
  const cg4Api = cg4SuitePlan().find((suite) =>
    isScript(suite, 'contact-governance-cg4-api.integration.ts'),
  );
  const result = run({
    executeSuite(suite) {
      return suite.id === cg4Api.id
        ? { status: 'FAIL', durationMs: 1, detail: 'not ok 1 - synthetic failure' }
        : passingSuite(suite);
    },
  });
  assert.equal(result.summary.status, 'FAIL');
  assert.equal(result.manifest.markers, undefined);
  assert.deepEqual(
    result.checks
      .filter((item) => item.status === 'FAIL')
      .map((item) => item.id)
      .sort(),
    [...cg4Api.checkIds].sort(),
  );

  const noProfile = run({
    executeSuite(suite) {
      const base = passingSuite(suite);
      return isScript(suite, 'cxa-cg4-profile-readiness.mjs')
        ? { status: 'PASS', durationMs: 1 }
        : base;
    },
  });
  assert.ok(noProfile.summary.markerBlockers.includes('OWNER_PROFILE_OR_FLAGS_MISMATCH'));
});

test('TAP: skip/todo/cancel or no tests at all does not count as a pass even with exit 0', () => {
  const tapOutput = (overrides = {}) => {
    const counts = { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides };
    return [
      'ok 1 - first',
      'ok 2 - second',
      ...Object.entries(counts).map(([name, value]) => `# ${name} ${value}`),
    ].join('\n');
  };
  const suite = { id: 'suite:01', command: ['node', '--test', 'x.test.ts'], checkIds: ['CG4-F01'] };
  const fakeRunner =
    (stdout, status = 0) =>
    () => ({ status, stdout, stderr: '' });

  assert.equal(executeCg4Suite(suite, fakeRunner(tapOutput())).status, 'PASS');
  for (const override of [{ skipped: 1 }, { todo: 1 }, { cancelled: 1 }, { tests: 0, pass: 0 }]) {
    assert.equal(
      executeCg4Suite(suite, fakeRunner(tapOutput(override))).status,
      'FAIL',
      JSON.stringify(override),
    );
  }
  assert.equal(executeCg4Suite(suite, fakeRunner(tapOutput(), 1)).status, 'FAIL');
  const nonTap = { id: 'suite:02', command: ['pnpm', 'build'], checkIds: ['CG4-UX01'] };
  assert.equal(executeCg4Suite(nonTap, fakeRunner('built')).status, 'PASS');

  // several summaries (e.g. a package that runs several processes) are combined, and titles are digested rather than storing the text
  const merged = parseTapSummary(`${tapOutput()}\n${tapOutput({ tests: 1, pass: 1 })}`);
  assert.equal(merged.tests, 3);
  assert.equal(merged.passed, 3);
  assert.match(merged.titlesSha256, /^[0-9a-f]{64}$/);
});

test('the detail of a failed suite is redacted before entering the manifest, so the whole manifest does not become unusable', () => {
  const output = [
    'not ok 3 - identity customer@example.test phone 0812345678',
    '  error: token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
    'ok 4 - unrelated',
  ].join('\n');
  const detail = cg4FailureDetail(output, 'fallback');
  assert.doesNotMatch(detail, /customer@example\.test|0812345678|eyJhbGciOi/);
  assert.match(detail, /not ok 3/);

  const suiteFailure = {
    id: 'suite:01',
    command: ['node', '--test', 'x.test.ts'],
    checkIds: ['CG4-F01'],
  };
  const failed = executeCg4Suite(suiteFailure, () => ({ status: 1, stdout: output, stderr: '' }));
  assert.equal(failed.status, 'FAIL');
  assert.doesNotThrow(() => assertPiiSafeEvidence({ detail: failed.detail }));
  const result = run({
    executeSuite(suite) {
      return isScript(suite, 'cg4-rule-registry.test.ts') ? failed : passingSuite(suite);
    },
  });
  assert.equal(result.summary.status, 'FAIL');
});

test('validator rejects inconsistent check/suite, wrong artifact hash/commit, flag and SHA/ref mismatch', () => {
  const { manifest } = run();
  const reject = (mutate, pattern) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => assertValidCxaCg4EvidenceManifest(copy), pattern);
  };
  reject((copy) => {
    copy.checks[0].id = 'CG4-X99';
  }, /unknown check/);
  reject((copy) => {
    copy.checks[1] = { ...copy.checks[0] };
  }, /duplicate check/);
  reject((copy) => {
    copy.checks.pop();
    copy.artifacts.pop();
  }, /all 25/);
  reject((copy) => {
    copy.dimensions[0].checks = 0;
  }, /empty dimension/);
  reject((copy) => {
    copy.suites[0].status = 'FAIL';
  }, /does not match the suite result/);
  reject((copy) => {
    copy.checks[0].subchecks.pop();
  }, /per the registry/);
  reject((copy) => {
    copy.checks[0].status = 'FAIL';
  }, /status that does not match/);
  reject((copy) => {
    copy.artifacts[0].sha256 = '0'.repeat(64);
  }, /SHA-256/);
  reject((copy) => {
    copy.artifacts[0].commitSha = 'c'.repeat(40);
  }, /commit that does not match/);
  reject((copy) => {
    copy.flags.releaseEnabled = true;
  }, /fixed flags/);
  // ADR-032: main has moved on (finalMainSha differs from the commit), a marker can still be issued if the commit is on main
  const movedMain = structuredClone(manifest);
  movedMain.finalMainSha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertValidCxaCg4EvidenceManifest(movedMain));
  reject((copy) => {
    copy.refProof.commitOnMain = false;
  }, /already on main/);
  reject((copy) => {
    copy.refProof.cleanTree = false;
  }, /clean checkout/);
  reject((copy) => {
    copy.artifact.url = 'file:///tmp/cxa-cg4.json';
  }, /immutable CI artifact/);
  reject((copy) => {
    copy.dependencies.cg3 = 'CANDIDATE_NOT_FINAL_MAIN';
  }, /CONTACT_GOVERNANCE_CG3_ACCEPTED/);
  reject((copy) => {
    copy.dependencies.s1Regression['cxa:c1:acceptance'] = 'FAIL';
  }, /S1-REG-01/);
  reject((copy) => {
    copy.ownerProfiles.provider = 'LIVE';
  }, /owner profiles/);
});

test('manifest rejects PII and credentials even in a deep diagnostic', () => {
  assert.throws(
    () => assertPiiSafeEvidence({ nested: [{ detail: 'customer@example.test' }] }),
    /PII/,
  );
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'x' }), /forbidden field/);
  // an executor that does not redact (a contract violation) must make the manifest rejected before the file is written
  assert.throws(
    () =>
      run({
        executeSuite(suite) {
          return isScript(suite, 'contact-governance-cg4.test.ts')
            ? { status: 'FAIL', durationMs: 1, detail: 'phone 0812345678' }
            : passingSuite(suite);
        },
      }),
    /PII/,
  );
});

test('owner profile fails closed when the profile is wrong or tries to enable release/provider/real data', () => {
  assert.deepEqual(cxaCg4ProfileSummary({}).flags, CG4_FIXED_FLAGS);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_GOVERNANCE_PROFILE: 'IN_MEMORY' }),
    /contactGovernance/,
  );
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_CONSOLE_PROFILE: 'PROVIDER_DIRECT' }),
    /console/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_PROVIDER_PROFILE: 'LINE' }), /provider/);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /provider traffic/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_RELEASE_ENABLED: 'true' }), /releaseEnabled/);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_PROVIDER_CONFORMANCE: 'true' }),
    /providerConformance/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_REAL_CUSTOMER_DATA: 'true' }), /synthetic/);
});

test('dependency: final main needs the CG3 marker and the S1-REG-01 regression to PASS on the same SHA', () => {
  const regressionSubchecks = S1_REGRESSION_SCRIPTS.map((script) => ({
    command: ['pnpm', script],
    status: 'PASS',
  }));
  const s1 = {
    commitSha: SHA,
    finalMainSha: SHA,
    markers: [CG3_MARKER],
    checks: [{ id: 'S1-REG-01', status: 'PASS', subchecks: regressionSubchecks }],
  };
  const finalEnv = { GITHUB_RUN_ID: '1' };
  const summary = (overrides) =>
    cxaCg4DependencySummary({ environment: finalEnv, commitSha: SHA, mainSha: SHA, ...overrides });

  const passing = summary({ s1Manifest: s1 });
  assert.equal(passing.cg3, 'INTEGRATED_SAME_SHA');
  assert.deepEqual(passing.s1Regression, passingRegression);

  assert.throws(
    () => summary({ s1Manifest: { ...s1, markers: [] } }),
    /CONTACT_GOVERNANCE_CG3_ACCEPTED/,
  );
  assert.throws(
    () => summary({ s1Manifest: { ...s1, commitSha: 'a'.repeat(40) } }),
    /the same SHA/,
  );
  // S1-REG-01 stops at the first failing command: later commands that do not really exist must be MISSING, not treated as passing
  assert.throws(
    () =>
      summary({
        s1Manifest: {
          ...s1,
          checks: [
            {
              id: 'S1-REG-01',
              status: 'FAIL',
              subchecks: [
                ...regressionSubchecks.slice(0, 3),
                { command: ['pnpm', 'cxa:e0:acceptance'], status: 'FAIL' },
              ],
            },
          ],
        },
      }),
    /cxa:e0:acceptance=FAIL.*voice:acceptance=MISSING/,
  );

  const candidate = cxaCg4DependencySummary({
    environment: { GITHUB_PR_NUMBER: '9', GITHUB_RUN_ID: '1' },
    commitSha: SHA,
    mainSha: 'a'.repeat(40),
    s1Manifest: undefined,
  });
  assert.equal(candidate.cg3, 'CANDIDATE_NOT_FINAL_MAIN');
  assert.equal(candidate.s1Regression['build'], 'MISSING');

  const j2 = summary({
    s1Manifest: s1,
    j2Manifest: { commitSha: SHA, markers: ['JOURNEY_J2_ACCEPTED'] },
  });
  assert.equal(j2.j2, 'ACCEPTED_SAME_SHA');
});

test('profile evidence is collected from a real child process through the suite evidence prefix', () => {
  const profileSuite = cg4SuitePlan().find((suite) =>
    isScript(suite, 'cxa-cg4-profile-readiness.mjs'),
  );
  const result = executeCg4Suite(profileSuite);
  assert.equal(result.status, 'PASS');
  assert.equal(result.evidence?.[0]?.type, 'owner-profile.readiness');
  assert.deepEqual(result.evidence?.[0]?.flags, CG4_FIXED_FLAGS);
});

test('marker blockers are empty only for a fully correct context, and the artifact hash is bound to the check', () => {
  const { manifest, checks } = run();
  assert.deepEqual(cg4MarkerBlockers(finalMainContext, checks), []);
  for (const artifact of manifest.artifacts) {
    const item = manifest.checks.find(({ id }) => `check:${id}` === artifact.id);
    assert.equal(artifact.sha256, sha256(item));
  }
});
