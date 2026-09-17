import assert from 'node:assert/strict';
import test from 'node:test';
import {
  J3_DIMENSIONS,
  J3_MARKER,
  CXA_J3_READINESS_CHECKS,
  assertValidCxaJ3EvidenceManifest,
  j3SuitePlan,
  executeJ3Suite,
  parseTapSummary,
  runCxaJ3Readiness,
  sha256,
} from './cxa-j3-readiness.mjs';
import { cxaJ3ProfileSummary } from './cxa-j3-profile-readiness.mjs';

const SHA = 'a'.repeat(40);
const context = Object.freeze({
  repository: 'Kitti-Nualsalee/dcontact',
  defaultBranch: 'main',
  ref: 'refs/heads/main',
  pullRequest: null,
  baseSha: SHA,
  commitSha: SHA,
  finalMainSha: SHA,
  expectedCommitSha: SHA,
  cleanTree: true,
  runId: '123',
  attempt: 1,
  runUrl: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123/attempts/1',
  artifact: {
    name: `cxa-j3-evidence-${SHA}`,
    url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123/attempts/1#artifacts',
    immutable: true,
  },
});

function passingSuite(suite) {
  const profile = suite.command.at(-1) === 'scripts/cxa-j3-profile-readiness.mjs';
  return {
    status: 'PASS',
    durationMs: 1,
    ...(suite.command.includes('--test')
      ? {
          tap: {
            tests: 2,
            passed: 2,
            failed: 0,
            cancelled: 0,
            skipped: 0,
            todo: 0,
            titlesSha256: sha256(['first', 'second']),
            clean: true,
          },
        }
      : {}),
    ...(profile
      ? {
          evidence: [
            {
              type: 'owner-profile.readiness',
              profiles: {
                customer360: 'DURABLE_OWNER',
                journey: 'DURABLE_OWNER',
                iam: 'TEST_ADAPTER',
                governance: 'CG3_INTEGRATED',
                delivery: 'TEST_ADAPTER',
                kafka: 'REDPANDA',
              },
              flags: {
                developmentAcceptance: true,
                releaseEnabled: false,
                actualProviderTraffic: false,
                providerConformance: false,
                syntheticFixturesOnly: true,
              },
            },
          ],
        }
      : {}),
  };
}

function run(executeSuite = passingSuite) {
  return runCxaJ3Readiness({
    context,
    executeSuite,
    now: () => new Date('2099-01-01T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
    digests: { registry: 'b'.repeat(64), migrations: 'c'.repeat(64) },
  });
}

test('J3 registry มี 16 checks ครบ 9 dimensions ตาม #208', () => {
  assert.deepEqual(
    CXA_J3_READINESS_CHECKS.map(({ id }) => id),
    [
      'J3-F01',
      'J3-F02',
      'J3-F03',
      'J3-F04',
      'J3-TI01',
      'J3-AU01',
      'J3-AU02',
      'J3-ID01',
      'J3-ID02',
      'J3-CC01',
      'J3-CC02',
      'J3-RC01',
      'J3-RC02',
      'J3-MG01',
      'J3-OB01',
      'J3-REG01',
    ],
  );
  assert.deepEqual(
    [...new Set(CXA_J3_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
    [...J3_DIMENSIONS].sort(),
  );
});

test('suite plan รวมคำสั่งซ้ำและรันแต่ละ suite ครั้งเดียว', () => {
  const suites = j3SuitePlan();
  const references = CXA_J3_READINESS_CHECKS.reduce(
    (total, check) => total + check.commands.length,
    0,
  );
  assert.ok(suites.length < references);
  assert.equal(new Set(suites.map(({ command }) => JSON.stringify(command))).size, suites.length);
  const executions = new Map();
  const result = run((suite) => {
    executions.set(suite.id, (executions.get(suite.id) ?? 0) + 1);
    return passingSuite(suite);
  });
  assert.equal(executions.size, suites.length);
  assert.ok([...executions.values()].every((count) => count === 1));
  assert.equal(result.manifest.suites.length, suites.length);
});

test('J3-F04 และ J3-CC02 ครอบ Kafka owner-result boundary จริง', () => {
  const command = JSON.stringify([
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    '--filter',
    '@d-contact/journey',
    'exec',
    'tsx',
    '--test',
    '--test-concurrency=1',
    'src/journey-owner-result-consumer.integration.ts',
  ]);

  for (const checkId of ['J3-F04', 'J3-CC02']) {
    const check = CXA_J3_READINESS_CHECKS.find(({ id }) => id === checkId);
    assert.ok(check, `${checkId} ต้องอยู่ใน registry`);
    assert.ok(
      check.commands.some((candidate) => JSON.stringify(candidate) === command),
      `${checkId} ต้องอ้าง suite owner-result ผ่าน Kafka`,
    );
  }
});

test('manifest เก็บ TAP count และ digest ของ title พร้อม marker เมื่อ final main ผ่านครบ', () => {
  const result = run();
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, [J3_MARKER]);
  assert.ok(result.manifest.suites.some((suite) => suite.tap?.titlesSha256));
  assert.doesNotThrow(() => assertValidCxaJ3EvidenceManifest(result.manifest));
});

test('validator ปฏิเสธ check ที่ปลอม status ไม่ตรง suite ที่อ้าง', () => {
  const result = run();
  const invalid = structuredClone(result.manifest);
  invalid.checks[0].status = 'FAIL';
  assert.throws(() => assertValidCxaJ3EvidenceManifest(invalid), /status ไม่ตรงกับ suite/);
});

test('TAP ที่ skip, todo, cancel หรือไม่มี test ไม่ผ่านแม้ process exit 0', () => {
  for (const output of [
    '# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0',
    '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0',
    '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1',
  ]) {
    const tap = parseTapSummary(output);
    assert.ok(tap);
    assert.equal(tap.clean, false);
  }
});

test('owner profile ปฏิเสธการอ้างว่า IAM integrated หรือเปิด provider traffic', () => {
  assert.throws(
    () => cxaJ3ProfileSummary({ CXA_J3_IAM_PROFILE: 'IAM_INTEGRATED' }),
    /iam profile TEST_ADAPTER/,
  );
  assert.throws(
    () => cxaJ3ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /CXA_PROVIDER_TRAFFIC_ENABLED/,
  );
});

test('J3-TI01 ส่ง DB integration เป็น executable และ argv ชุดเดียวถึง runner', () => {
  const suites = j3SuitePlan().filter((suite) => suite.checkIds.includes('J3-TI01'));
  const calls = [];
  for (const suite of suites) {
    executeJ3Suite(suite, (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    });
  }
  assert.ok(
    calls.some(
      (call) =>
        JSON.stringify(call) ===
        JSON.stringify([
          process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
          '--filter',
          '@d-contact/db',
          'test:integration',
        ]),
    ),
  );
  assert.ok(suites.every((suite) => Array.isArray(suite.command)));
});
