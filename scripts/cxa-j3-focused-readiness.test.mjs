import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidCxaJ3FocusedEvidenceManifest,
  CXA_J3_FOCUSED_CHECKS,
  j3FocusedSuitePlan,
  runCxaJ3FocusedReadiness,
} from './cxa-j3-focused-readiness.mjs';
import { sha256 } from './cxa-j3-readiness.mjs';

const SHA = 'a'.repeat(40);
const context = Object.freeze({
  repository: 'Kitti-Nualsalee/dcontact',
  ref: 'refs/heads/codex/j3-focused-candidate',
  commitSha: SHA,
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

test('J3 focused รัน 15 checks ของ J3 และไม่ schedule S1/J2/CG4', () => {
  assert.equal(CXA_J3_FOCUSED_CHECKS.length, 15);
  assert.ok(CXA_J3_FOCUSED_CHECKS.every((check) => check.id !== 'J3-REG01'));
  const plan = j3FocusedSuitePlan();
  const commands = plan.map((suite) => JSON.stringify(suite.command));
  for (const script of ['s1:acceptance', 'cxa:j2:acceptance', 'cxa:cg4:acceptance'])
    assert.ok(!commands.some((command) => command.includes(script)));
});

test('J3 focused evidence เป็น candidate เท่านั้นและ marker ออกไม่ได้', () => {
  const result = runCxaJ3FocusedReadiness({
    context,
    executeSuite: passingSuite,
    now: () => new Date('2099-01-01T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
  });
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, []);
  assert.equal(result.summary.candidateOnly, true);
  assert.doesNotThrow(() => assertValidCxaJ3FocusedEvidenceManifest(result.manifest));

  const invalid = structuredClone(result.manifest);
  invalid.checks.push({ id: 'J3-REG01' });
  assert.throws(() => assertValidCxaJ3FocusedEvidenceManifest(invalid), /15 J3 checks/);

  const markerAttempt = structuredClone(result.manifest);
  markerAttempt.markers = ['JOURNEY_J3_ACCEPTED'];
  assert.throws(
    () => assertValidCxaJ3FocusedEvidenceManifest(markerAttempt),
    /scope หรือ marker policy/,
  );

  const urlAttempt = structuredClone(result.manifest);
  urlAttempt.run.url = 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/35090448437';
  assert.throws(
    () => assertValidCxaJ3FocusedEvidenceManifest(urlAttempt),
    /PII|scope หรือ marker policy/,
  );
});

test('J3 focused candidate ยอมรับ GitHub Actions run URL ที่มีเลขคล้ายเบอร์โทร', () => {
  const githubActionsContext = {
    ...context,
    runId: '35090448437',
    runUrl: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/35090448437/attempts/1',
    artifact: {
      ...context.artifact,
      url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/35090448437/attempts/1#artifacts',
    },
  };
  assert.doesNotThrow(() =>
    runCxaJ3FocusedReadiness({
      context: githubActionsContext,
      executeSuite: passingSuite,
      now: () => new Date('2099-01-01T00:00:00.000Z'),
      emit: () => undefined,
      writeManifest: false,
    }),
  );
});
