import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CG5_BASELINE_SHA,
  CG5_DIMENSIONS,
  CG5_FIXED_FLAGS,
  CG5_MARKER,
  CXA_CG5_READINESS_CHECKS,
  assertValidCxaCg5EvidenceManifest,
  cg5SuitePlan,
  runCxaCg5Readiness,
  sha256,
} from './cxa-cg5-readiness.mjs';
import { cxaCg5ProfileSummary } from './cxa-cg5-profile-readiness.mjs';
import { cxaCg5DependencySummary } from './cxa-cg5-dependency-readiness.mjs';
import {
  cg5MigrationReport,
  cxaCg5MigrationSummary,
  readCg5Migrations,
} from './cxa-cg5-migration-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    name: `cxa-cg5-evidence-${SHA}`,
    url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123456/attempts/1#artifacts',
    immutable: true,
  },
});

const isScript = (suite, name) => String(suite.command.at(-1)).endsWith(name);

function passingSuite(suite) {
  const evidence = isScript(suite, 'cxa-cg5-dependency-readiness.mjs')
    ? [cxaCg5DependencySummary({ commitSha: SHA, manifests: { cg3: [], cg4: [], j2: [], j3: [] } })]
    : isScript(suite, 'cxa-cg5-profile-readiness.mjs')
      ? [cxaCg5ProfileSummary({})]
      : isScript(suite, 'cxa-cg5-migration-readiness.mjs')
        ? [cxaCg5MigrationSummary()]
        : undefined;
  return {
    status: 'PASS',
    durationMs: 1,
    ...(suite.command.includes('--test')
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
  return runCxaCg5Readiness({
    context: options.context ?? finalMainContext,
    executeSuite: options.executeSuite ?? passingSuite,
    now: () => new Date('2026-09-21T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
    digests: { registry: 'd'.repeat(64), migrations: 'e'.repeat(64) },
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

test('CG5 registry มีทุก check ตามตาราง #273 ครบ 9 มิติบวก UX', () => {
  assert.deepEqual(
    CXA_CG5_READINESS_CHECKS.map(({ id }) => id),
    [
      ...['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07'],
      ...['TI01', 'TI02'],
      ...['AU01', 'AU02', 'AU03', 'AU04'],
      ...['ID01', 'ID02'],
      ...['CC01', 'CC02', 'CC03'],
      ...['RC01', 'RC02', 'RC03'],
      ...['MG01', 'MG02', 'MG03'],
      ...['OB01', 'OB02'],
      ...['REG01', 'REG02'],
      'UX01',
    ].map((suffix) => `CG5-${suffix}`),
  );
  assert.deepEqual(
    [...new Set(CXA_CG5_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
    [...CG5_DIMENSIONS].sort(),
  );
  for (const item of CXA_CG5_READINESS_CHECKS) {
    assert.ok(item.commands.length > 0, item.id);
    assert.ok(item.boundaries.length > 0, item.id);
    for (const command of item.commands.filter((entry) => entry.includes('--test'))) {
      assert.equal(
        command.filter((part) => /\.(test|integration|spec)\.(ts|mjs)$/.test(part)).length,
        1,
        `${item.id}: หนึ่ง suite ต้องเป็นหนึ่งไฟล์`,
      );
    }
  }
});

test('suite ที่หลาย check ใช้ร่วมกันถูกรันครั้งเดียวต่อ run', () => {
  const executed = [];
  const result = run({
    executeSuite: (suite) => {
      executed.push(JSON.stringify(suite.command));
      return passingSuite(suite);
    },
  });
  assert.equal(new Set(executed).size, executed.length);
  assert.equal(executed.length, cg5SuitePlan().length);
  const e2e = result.suites.find((suite) => isScript(suite, 'e2e/governance.spec.ts'));
  assert.deepEqual(e2e.checkIds, ['CG5-AU01', 'CG5-AU02', 'CG5-CC01', 'CG5-RC02', 'CG5-UX01']);
});

test('run บน final main ที่ทุก check ผ่านออก marker พร้อม fixed flags และสถานะเฟสอื่น', () => {
  const { summary, manifest } = run();
  assert.deepEqual(summary.markers, [CG5_MARKER]);
  assert.equal(manifest.candidate, false);
  assert.equal(manifest.baselineSha, CG5_BASELINE_SHA);
  assert.deepEqual(manifest.flags, CG5_FIXED_FLAGS);
  assert.equal(manifest.flags.releaseEnabled, false);
  assert.equal(manifest.flags.actualProviderTraffic, false);
  assert.equal(manifest.flags.externalApiEnabled, false);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.phaseMarkers).map(([phase, v]) => [phase, v.status]),
    ),
    {
      cg3: 'CONTRACT_COMPATIBLE',
      cg4: 'CONTRACT_COMPATIBLE',
      j2: 'CONTRACT_COMPATIBLE',
      j3: 'CONTRACT_COMPATIBLE',
    },
  );
  assert.doesNotThrow(() => assertValidCxaCg5EvidenceManifest(manifest));
});

test('run ที่ไม่ใช่ final main ได้ candidate manifest และไม่ออก marker', () => {
  for (const [context, blocker] of [
    [{ ...finalMainContext, pullRequest: 12, ref: 'refs/pull/12/merge' }, 'PULL_REQUEST_RUN'],
    [{ ...finalMainContext, finalMainSha: 'c'.repeat(40) }, 'NOT_FINAL_MAIN_SHA'],
    [{ ...finalMainContext, cleanTree: false }, 'DIRTY_TREE'],
    [
      {
        ...finalMainContext,
        runUrl: null,
        artifact: { ...finalMainContext.artifact, immutable: false },
      },
      'ARTIFACT_NOT_IMMUTABLE',
    ],
  ]) {
    const { summary, manifest } = run({ context });
    assert.deepEqual(summary.markers, [], blocker);
    assert.ok(summary.markerBlockers.includes(blocker), blocker);
    assert.equal(manifest.candidate, true);
    assert.equal(manifest.markers, undefined);
  }
});

test('check ที่ล้มหนึ่งตัวกัน marker และทำให้มิติของมันล้ม', () => {
  const { summary, manifest } = run({
    executeSuite: (suite) =>
      isScript(suite, 'src/cg5-observability.test.ts')
        ? { status: 'FAIL', durationMs: 1, detail: 'not ok 1 - telemetry' }
        : passingSuite(suite),
  });
  assert.deepEqual(summary.markers, []);
  assert.equal(summary.status, 'FAIL');
  assert.equal(manifest.checks.find(({ id }) => id === 'CG5-OB01').status, 'FAIL');
  assert.equal(manifest.dimensions.find(({ name }) => name === 'observability').status, 'FAIL');
});

test('conformance ของเฟสอื่นที่ล้มทำให้สถานะเป็น ABSENT และกัน marker', () => {
  const { summary, manifest } = run({
    executeSuite: (suite) =>
      isScript(suite, 'src/cg3-authorize-and-reserve.integration.ts')
        ? { status: 'FAIL', durationMs: 1, detail: 'not ok 1' }
        : passingSuite(suite),
  });
  assert.equal(manifest.phaseMarkers.cg3.status, 'ABSENT');
  assert.equal(manifest.phaseMarkers.j2.status, 'CONTRACT_COMPATIBLE');
  assert.ok(summary.markerBlockers.includes('PHASE_CONFORMANCE_NOT_PROVEN'));
});

test('marker ของเฟสอื่นนับเฉพาะ manifest บน SHA เดียวกันที่มี marker จริง', () => {
  const summary = cxaCg5DependencySummary({
    commitSha: SHA,
    manifests: {
      cg3: [{ commitSha: SHA, markers: ['CONTACT_GOVERNANCE_CG3_ACCEPTED'] }],
      cg4: [{ commitSha: 'c'.repeat(40), markers: ['CONTACT_GOVERNANCE_CG4_ACCEPTED'] }],
      j2: [{ commitSha: SHA, markers: [] }],
      j3: [],
    },
  });
  assert.equal(summary.phases.cg3.status, 'ACCEPTED_SAME_SHA');
  assert.equal(summary.phases.cg4.status, 'ABSENT');
  assert.equal(summary.phases.j2.status, 'ABSENT');
  assert.equal(summary.phases.j3.status, 'ABSENT');
});

test('validator ปฏิเสธ manifest ที่แต่ง status, marker ปลอม หรือ flag ถูกเปลี่ยน', () => {
  const { manifest } = run();

  const forged = rehash(structuredClone(manifest));
  forged.checks[0].status = 'FAIL';
  forged.checks[0].subchecks[0].status = 'FAIL';
  assert.throws(() => assertValidCxaCg5EvidenceManifest(rehash(forged)), /suite/);

  const flags = structuredClone(manifest);
  flags.flags.externalApiEnabled = true;
  assert.throws(() => assertValidCxaCg5EvidenceManifest(flags), /fixed flags/);

  const candidate = structuredClone(manifest);
  delete candidate.markers;
  candidate.candidate = false;
  assert.throws(() => assertValidCxaCg5EvidenceManifest(candidate), /candidate/);

  const pr = structuredClone(manifest);
  pr.pullRequest.number = 7;
  assert.throws(() => assertValidCxaCg5EvidenceManifest(pr), /PR run/);

  const phase = structuredClone(manifest);
  delete phase.phaseMarkers.j3;
  assert.throws(() => assertValidCxaCg5EvidenceManifest(phase), /CG3\/CG4\/J2\/J3/);

  const duplicate = structuredClone(manifest);
  duplicate.suites[1].command = duplicate.suites[0].command;
  assert.throws(() => assertValidCxaCg5EvidenceManifest(duplicate), /ซ้ำ/);
});

test('manifest ถูกตรวจว่าไม่มี PII', () => {
  const { manifest } = run();
  const leaked = structuredClone(manifest);
  leaked.checks[0].subchecks[0].detail = 'customer somchai@example.com 0812345678';
  assert.throws(() => assertValidCxaCg5EvidenceManifest(rehash(leaked)));
});

test('profile ปฏิเสธการเปิด external API, release หรือ provider traffic', () => {
  assert.throws(
    () => cxaCg5ProfileSummary({ CXA_CG5_EXTERNAL_API_ENABLED: 'true' }),
    /external API/,
  );
  assert.throws(() => cxaCg5ProfileSummary({ CXA_CG5_RELEASE_ENABLED: 'true' }), /releaseEnabled/);
  assert.throws(() => cxaCg5ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }), /provider/);
  assert.throws(() => cxaCg5ProfileSummary({ CXA_CG5_CONSOLE_PROFILE: 'DIRECT_DB' }), /console/);
});

test('MG01: migration จริงของ CG5 additive และ scanner จับ migration ที่ทำลาย canonical', () => {
  const summary = cxaCg5MigrationSummary(readCg5Migrations());
  assert.equal(summary.canonicalConcurrentIndexes, 1);
  const reasons = (sql) =>
    cg5MigrationReport([{ name: 'x_cg5_bad', sql }]).violations.map(({ reason }) => reason);
  assert.deepEqual(reasons('CREATE INDEX "i" ON "cg_decision_logs" ("tenant_id");'), [
    'CANONICAL_INDEX_NOT_CONCURRENT',
  ]);
  assert.deepEqual(reasons('ALTER TABLE "cg_decision_logs" ADD COLUMN "x" int;'), [
    'CANONICAL_TABLE_ALTERED',
  ]);
  assert.deepEqual(reasons('ALTER TABLE "cg5_metric_bucket" DROP COLUMN "x";'), [
    'DESTRUCTIVE_DDL',
  ]);
  assert.deepEqual(reasons('UPDATE "cg_decision_logs" SET decision = NULL;'), ['DATA_WRITE']);
  assert.deepEqual(
    reasons(
      'CREATE INDEX CONCURRENTLY "i" ON "cg_decision_logs" ("id"); CREATE TABLE "cg5_x" ("id" int);',
    ),
    ['CONCURRENT_INDEX_NOT_ISOLATED'],
  );
  assert.deepEqual(reasons('GRANT SELECT ON "cg_decision_logs" TO dcontact_app;'), [
    'CANONICAL_GRANT_CHANGED',
  ]);
});

test('ทุกไฟล์เทสต์ที่ registry อ้างมีอยู่จริง', () => {
  const packageRoots = {
    '@d-contact/contact-governance': 'apps/contact-governance',
    '@d-contact/api': 'apps/api',
    '@d-contact/console': 'apps/console',
    '@d-contact/cxa-contracts': 'packages/cxa-contracts',
  };
  const missing = [];
  for (const { command } of cg5SuitePlan()) {
    const file = command.at(-1);
    if (!/\.(test|integration|spec)\.(ts|mjs)$/.test(file)) continue;
    const root = command[1] === '--filter' ? packageRoots[command[2]] : '.';
    if (!existsSync(resolve(repositoryRoot, root, file))) missing.push(file);
  }
  assert.deepEqual(missing, []);
});
