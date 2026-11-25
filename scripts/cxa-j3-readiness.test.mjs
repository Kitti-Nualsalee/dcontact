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

test('J3 registry has 16 checks across 9 dimensions per #208', () => {
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

test('the suite plan merges repeated commands and runs each suite once', () => {
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

test('J3-F04 and J3-CC02 cover the real Kafka owner-result boundary', () => {
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
    assert.ok(check, `${checkId} must be in the registry`);
    assert.ok(
      check.commands.some((candidate) => JSON.stringify(candidate) === command),
      `${checkId} must reference the owner-result suite through Kafka`,
    );
  }
});

test('J3 authorization checks cover IAM revoke at the inbound and outbound boundaries', () => {
  const command = (file) =>
    JSON.stringify([
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      '--filter',
      '@d-contact/journey',
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      `src/${file}`,
    ]);
  const au01 = CXA_J3_READINESS_CHECKS.find(({ id }) => id === 'J3-AU01');
  const au02 = CXA_J3_READINESS_CHECKS.find(({ id }) => id === 'J3-AU02');
  assert.ok(au01 && au02, 'J3-AU01/AU02 must be in the registry');
  assert.ok(
    au01.commands.some(
      (candidate) => JSON.stringify(candidate) === command('journey-send-executor.integration.ts'),
    ),
    'AU01 must prove CONTACT revoke before Governance/Delivery',
  );
  assert.ok(
    au02.commands.some(
      (candidate) =>
        JSON.stringify(candidate) === command('journey-iam-scope-consumer.integration.ts'),
    ),
    'AU02 must prove IAM invalidation in the Kafka consumer',
  );
});

test('manifest keeps the TAP count and the title digest, with the marker, when final main passes fully', () => {
  const result = run();
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, [J3_MARKER]);
  assert.ok(result.manifest.suites.some((suite) => suite.tap?.titlesSha256));
  assert.doesNotThrow(() => assertValidCxaJ3EvidenceManifest(result.manifest));
});

test('validator rejects a check with a forged status that does not match the referenced suite', () => {
  const result = run();
  const invalid = structuredClone(result.manifest);
  invalid.checks[0].status = 'FAIL';
  assert.throws(() => assertValidCxaJ3EvidenceManifest(invalid), /status that does not match/);
});

test('TAP with a skip, todo, cancel or no tests does not pass even when the process exits 0', () => {
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

test('owner profile rejects claiming IAM is integrated or enabling provider traffic', () => {
  assert.throws(
    () => cxaJ3ProfileSummary({ CXA_J3_IAM_PROFILE: 'IAM_INTEGRATED' }),
    /iam profile TEST_ADAPTER/,
  );
  assert.throws(
    () => cxaJ3ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /CXA_PROVIDER_TRAFFIC_ENABLED/,
  );
});

test('J3-TI01 passes the DB integration as an executable and a single argv set to the runner', () => {
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
