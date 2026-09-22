import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CXA_J5_READINESS_CHECKS,
  J5_DIMENSIONS,
  J5_MARKER,
  assertValidCxaJ5EvidenceManifest,
  j5Checks,
  j5StructuredEvidence,
  j5SuitePlan,
  parsePlaywrightSummary,
  runCxaJ5Readiness,
  sha256,
} from './cxa-j5-readiness.mjs';
import { cxaJ5ProfileSummary } from './cxa-j5-profile-readiness.mjs';
import { cxaJ5DependencySummary, j5PhaseMarkerStatus } from './cxa-j5-dependency-readiness.mjs';
import { cxaJ5NegativeScan } from './cxa-j5-negative-scan.mjs';
import { cxaJ5BrowserEvidence, J5_BROWSER_MATRIX } from './cxa-j5-browser-evidence.mjs';

const SHA = 'c'.repeat(40);
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
  runId: '987654',
  attempt: 1,
  runUrl: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/987654/attempts/1',
  artifact: {
    name: `cxa-j5-evidence-${SHA}`,
    url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/987654/attempts/1#artifacts',
    immutable: true,
  },
});

const acceptedDependencies = Object.fromEntries(
  [
    ['j1', 'J1_ACCEPTED'],
    ['j2', 'JOURNEY_J2_ACCEPTED'],
    ['j3', 'JOURNEY_J3_ACCEPTED'],
    ['cg3', 'CONTACT_GOVERNANCE_CG3_ACCEPTED'],
  ].map(([phase, marker]) => [phase, [{ commitSha: SHA, candidate: false, markers: [marker] }]]),
);

const isScript = (suite, name) => String(suite.command.at(-1)).endsWith(name);

function passingSuite(suite, overrides = {}) {
  const evidence = isScript(suite, 'cxa-j5-profile-readiness.mjs')
    ? [cxaJ5ProfileSummary({})]
    : isScript(suite, 'cxa-j5-dependency-readiness.mjs')
      ? [
          cxaJ5DependencySummary({
            commitSha: SHA,
            manifests: overrides.dependencies ?? acceptedDependencies,
          }),
        ]
      : isScript(suite, 'cxa-j5-negative-scan.mjs')
        ? [
            {
              type: 'negative-scan.readiness',
              status: 'PASS',
              files: 40,
              bundleScanned: true,
              allowlist: [],
            },
          ]
        : isScript(suite, 'cxa-j5-browser-evidence.mjs')
          ? [
              {
                type: 'browser.readiness',
                status: 'PASS',
                browser: 'PLAYWRIGHT_CHROMIUM',
                matrix: J5_BROWSER_MATRIX.map(({ state }) => state),
                axeWcag22: true,
                traces: 8,
                artifactsSha256: 'e'.repeat(64),
              },
            ]
          : isScript(suite, 'cxa-j5-schema-readiness.mjs')
            ? [{ type: 'schema.readiness', status: 'PASS', existing: 'PASS', fresh: 'PASS' }]
            : undefined;
  return {
    status: 'PASS',
    durationMs: 1,
    ...(suite.command.includes('test') || suite.command.includes('--test')
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

const digests = {
  registry: 'a'.repeat(64),
  nodeRegistry: 'a'.repeat(64),
  compiler: 'a'.repeat(64),
  templateRegistry: 'a'.repeat(64),
  fixtures: 'a'.repeat(64),
  migrations: 'a'.repeat(64),
};

function run(options = {}) {
  return runCxaJ5Readiness({
    scope: options.scope ?? 'full',
    context: options.context ?? finalMainContext,
    executeSuite: options.executeSuite ?? ((suite) => passingSuite(suite)),
    now: () => new Date('2026-09-22T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
    digests,
  });
}

const rehash = (manifest) => {
  manifest.artifacts = manifest.checks.map((item) => ({
    id: `check:${item.id}`,
    kind: 'readiness-diagnostic',
    commitSha: manifest.commitSha,
    sha256: sha256(item),
  }));
  return manifest;
};

test('J5 registry ครบ 16 checks / 9 dimensions และ focused ตัดเฉพาะ J5-REG01', () => {
  assert.deepEqual(
    CXA_J5_READINESS_CHECKS.map(({ id }) => id),
    [
      'J5-F01',
      'J5-F02',
      'J5-F03',
      'J5-F04',
      'J5-TI01',
      'J5-AU01',
      'J5-AU02',
      'J5-ID01',
      'J5-ID02',
      'J5-CC01',
      'J5-CC02',
      'J5-RC01',
      'J5-RC02',
      'J5-MG01',
      'J5-OB01',
      'J5-REG01',
    ],
  );
  assert.deepEqual(
    [...new Set(CXA_J5_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
    [...J5_DIMENSIONS].sort(),
  );
  assert.equal(j5Checks('focused').length, 15);
  assert.ok(!j5Checks('focused').some(({ id }) => id === 'J5-REG01'));
  // focused ไม่รัน dependency acceptance ที่ใช้เวลาหลายชั่วโมง
  assert.ok(
    !j5SuitePlan(j5Checks('focused')).some(({ command }) => command.includes('cxa:j3:acceptance')),
  );
});

test('suite plan รันแต่ละคำสั่งครั้งเดียวแม้หลาย check ใช้ร่วมกัน', () => {
  const suites = j5SuitePlan();
  assert.equal(new Set(suites.map(({ command }) => JSON.stringify(command))).size, suites.length);
  const journeyIntegration = suites.find(
    ({ command }) => command.includes('test:integration') && command.includes('@d-contact/journey'),
  );
  assert.ok(journeyIntegration.checkIds.length >= 8);
  const e2e = suites.find(({ command }) => command.includes('playwright'));
  assert.ok(e2e.command.includes('--project=chromium'));
});

test('full run บน clean final main ที่ทุกอย่างผ่านออก marker เดียว', () => {
  const result = run();
  assert.deepEqual(result.summary.markers, [J5_MARKER]);
  assert.deepEqual(result.summary.markerBlockers, []);
  assert.equal(result.manifest.retentionDays, 90);
  assert.equal(result.manifest.checks.length, 16);
  assert.ok(result.manifest.dimensions.every(({ status }) => status === 'PASS'));
  assertValidCxaJ5EvidenceManifest(result.manifest);
});

test('focused run ไม่ออก marker แม้ผ่านทั้งหมด และ manifest เป็น candidate 30 วัน', () => {
  const result = run({ scope: 'focused' });
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, []);
  assert.ok(result.summary.markerBlockers.includes('FOCUSED_CANDIDATE'));
  assert.equal(result.manifest.candidateOnly, true);
  assert.equal(result.manifest.entryCondition, 'NOT_READY');
  assert.equal(result.manifest.retentionDays, 30);
  assert.equal(result.manifest.checks.length, 15);
  assert.equal(
    result.manifest.dimensions.find(({ name }) => name === 'regression').status,
    'NOT_RUN',
  );
  const forged = structuredClone(result.manifest);
  forged.markers = [J5_MARKER];
  forged.candidate = false;
  forged.markerBlockers = [];
  assert.throws(() => assertValidCxaJ5EvidenceManifest(forged), /focused run ออก J5 marker ไม่ได้/);
});

test('marker ถูกกันเมื่อ PR/ต่าง SHA/dirty/dependency ไม่ครบ/suite ล้ม', () => {
  const blockers = (options) => run(options).summary.markerBlockers;
  assert.ok(
    blockers({ context: { ...finalMainContext, pullRequest: 12 } }).includes('PULL_REQUEST_RUN'),
  );
  assert.ok(
    blockers({ context: { ...finalMainContext, finalMainSha: 'f'.repeat(40) } }).includes(
      'NOT_FINAL_MAIN_SHA',
    ),
  );
  assert.ok(
    blockers({ context: { ...finalMainContext, cleanTree: false } }).includes('DIRTY_TREE'),
  );
  assert.ok(
    blockers({
      executeSuite: (suite) =>
        passingSuite(suite, { dependencies: { ...acceptedDependencies, j3: [] } }),
    }).includes('DEPENDENCY_MARKERS_NOT_SAME_SHA'),
  );
  const failing = run({
    executeSuite: (suite) =>
      suite.command.includes('playwright')
        ? { status: 'FAIL', durationMs: 1, detail: 'x' }
        : passingSuite(suite),
  });
  assert.equal(failing.summary.status, 'FAIL');
  assert.deepEqual(failing.summary.markers, []);
  assert.equal(failing.checks.find(({ id }) => id === 'J5-F04').status, 'FAIL');
  assert.equal(
    failing.manifest.dimensions.find(({ name }) => name === 'functional').status,
    'FAIL',
  );
});

test('manifest validator ปฏิเสธ PII, status ที่แต่งเอง และ artifact digest ไม่ตรง', () => {
  const base = run().manifest;
  const pii = structuredClone(base);
  pii.checks[0].boundaries.push('customer somchai@example.com');
  assert.throws(() => assertValidCxaJ5EvidenceManifest(rehash(pii)), /PII/);

  const forged = structuredClone(base);
  forged.checks[0].subchecks[0].status = 'FAIL';
  assert.throws(() => assertValidCxaJ5EvidenceManifest(rehash(forged)), /suite/);

  const dimension = structuredClone(base);
  dimension.dimensions[0].status = 'FAIL';
  assert.throws(() => assertValidCxaJ5EvidenceManifest(dimension), /derive/);

  const digest = structuredClone(base);
  digest.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertValidCxaJ5EvidenceManifest(digest), /SHA-256/);

  const flags = structuredClone(base);
  flags.flags.releaseEnabled = true;
  assert.throws(() => assertValidCxaJ5EvidenceManifest(flags), /fixed flags/);
});

test('Playwright summary: flaky/skipped/did not run ถือว่าไม่สะอาด', () => {
  assert.deepEqual(parsePlaywrightSummary('Running 8 tests\n  8 passed (9.1s)\n'), {
    passed: 8,
    failed: 0,
    flaky: 0,
    skipped: 0,
    didNotRun: 0,
    interrupted: 0,
  });
  assert.equal(parsePlaywrightSummary('  1 flaky\n  7 passed (9s)\n').flaky, 1);
  assert.equal(parsePlaywrightSummary('  2 skipped\n  6 passed (9s)\n').skipped, 2);
  assert.equal(parsePlaywrightSummary('no summary here'), null);
  assert.deepEqual(
    j5StructuredEvidence(
      'noise\nCXA_J5_SCAN_EVIDENCE:{"type":"negative-scan.readiness","status":"PASS"}\n{"type":"schema.readiness","status":"PASS","existing":{"status":"PASS"},"fresh":{"status":"PASS"},"canonicalTables":[1]}\n',
    ),
    [
      { type: 'negative-scan.readiness', status: 'PASS' },
      { type: 'schema.readiness', status: 'PASS', existing: 'PASS', fresh: 'PASS' },
    ],
  );
});

test('profile/dependency script fail closed และนับเฉพาะ marker บน SHA เดียวกัน', () => {
  assert.throws(() => cxaJ5ProfileSummary({ CXA_J5_IAM_PROFILE: 'DURABLE_OWNER' }), /iam/);
  assert.throws(() => cxaJ5ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }), /provider/);
  assert.throws(
    () => cxaJ5ProfileSummary({ J5_PUBLISH_UI_ENABLED: 'true' }),
    /J5_PUBLISH_UI_ENABLED/,
  );
  assert.equal(
    j5PhaseMarkerStatus(
      [{ commitSha: 'f'.repeat(40), markers: ['J1_ACCEPTED'] }],
      SHA,
      'J1_ACCEPTED',
    ).status,
    'ABSENT',
  );
  assert.equal(
    j5PhaseMarkerStatus(
      [{ commitSha: SHA, candidate: true, markers: ['J1_ACCEPTED'] }],
      SHA,
      'J1_ACCEPTED',
    ).status,
    'ABSENT',
  );
  assert.equal(
    cxaJ5DependencySummary({ commitSha: SHA, manifests: acceptedDependencies }).allAcceptedSameSha,
    true,
  );
});

test('negative scan จับ eval, cross-owner write, skipped test และ marker ที่ hard-code', () => {
  const files = {
    'apps/journey/src/journey-authoring-x.ts': 'tx.csCase.create({})\neval("1")',
    'apps/api/src/journey-authoring-api.ts': "import { x } from '@d-contact/db';",
    'apps/console/src/journey-authoring/canvas.tsx': 'onKeyDown={x} tabIndex={0}',
    'apps/console/src/journey-authoring/outline.tsx':
      "'ADD_NODE' 'CONNECT' 'DISCONNECT' 'DELETE_NODE' 'REORDER'",
    'apps/console/src/journey-authoring/journey-authoring.tsx': "'(min-width: 960px)'",
    'apps/journey/src/journey-authoring-x.test.ts':
      "test.skip('x', () => {}); 'JOURNEY_J5_ACCEPTED'",
    'apps/journey/test/fixtures/j5/x.json': '{"note":"ok"}',
  };
  const summary = cxaJ5NegativeScan({
    read: (path) => files[path] ?? '',
    allowlist: [],
    targets: {
      journeySources: ['apps/journey/src/journey-authoring-x.ts'],
      apiSources: ['apps/api/src/journey-authoring-api.ts'],
      consoleSources: ['apps/console/src/journey-authoring/canvas.tsx'],
      tests: ['apps/journey/src/journey-authoring-x.test.ts'],
      fixtures: ['apps/journey/test/fixtures/j5/x.json'],
      bundle: [],
    },
  });
  assert.equal(summary.status, 'FAIL');
  const found = summary.violations.map(({ rule }) => rule).sort();
  assert.deepEqual(found, [
    'cross-owner-write',
    'db-import-in-adapter',
    'dynamic-code',
    'hard-coded-marker',
    'skipped-test',
  ]);
  assert.equal(summary.bundleScanned, false);
});

test('browser evidence ต้องครอบทุก state ใน matrix และมี trace ครบ', () => {
  const spec = `${J5_BROWSER_MATRIX.map(({ test: title }) => `test('${title} x'`).join('\n')}\nAxeBuilder ['serious', 'critical']`;
  const traces = J5_BROWSER_MATRIX.map((_, index) => `/r/journey-authoring-${index}/trace.zip`);
  const ok = cxaJ5BrowserEvidence({ spec, files: traces, digest: () => 'a'.repeat(64) });
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.traces, J5_BROWSER_MATRIX.length);
  const missing = cxaJ5BrowserEvidence({
    spec,
    files: traces.slice(1),
    digest: () => 'a'.repeat(64),
  });
  assert.equal(missing.status, 'FAIL');
  const noAxe = cxaJ5BrowserEvidence({
    spec: spec.replace('AxeBuilder', ''),
    files: traces,
    digest: () => 'a',
  });
  assert.equal(noAxe.status, 'FAIL');
});
