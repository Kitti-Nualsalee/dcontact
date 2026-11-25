import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG2_MARKER,
  CORE_MARKER,
  CXA_C1_READINESS_CHECKS,
  J1_MARKER,
  assertPiiSafeEvidence,
  assertValidCxaC1EvidenceManifest,
  createCxaC1EvidenceManifest,
  cxaC1Summary,
  runCxaC1Readiness,
  sha256,
} from './cxa-c1-readiness.mjs';
import { cxaC1AdapterProfileSummary } from './cxa-c1-profile-readiness.mjs';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const context = {
  repository: 'Kitti-Nualsalee/dcontact',
  pullRequest: 87,
  baseSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  runId: 'test-run',
  attempt: 1,
};

function passingExecutor(check) {
  return {
    checkId: check.id,
    boundaries: check.boundaries,
    status: 'PASS',
    durationMs: 1,
    ...(check.id === 'observability-pii-redaction'
      ? {
          evidence: [
            {
              type: 'adapter-profile.readiness',
              adapterProfile: 'TEST_ADAPTER',
              actualProviderTraffic: false,
            },
          ],
        }
      : {}),
  };
}

function runFixture(options = {}) {
  return runCxaC1Readiness({
    context,
    now: () => new Date('2026-09-10T00:00:00.000Z'),
    executeCheck: options.executeCheck ?? passingExecutor,
    emit: () => undefined,
    writeManifest: false,
  });
}

test('C1 readiness covers all nine dimensions of the acceptance matrix and the regression gate', () => {
  assert.deepEqual(
    [...new Set(CXA_C1_READINESS_CHECKS.map(({ dimension }) => dimension))],
    [
      'functional',
      'tenant-isolation',
      'authorization',
      'idempotency',
      'concurrency',
      'recovery',
      'migration-compatibility',
      'observability-pii-redaction',
      'regression',
    ],
  );
  const serialized = JSON.stringify(CXA_C1_READINESS_CHECKS);
  for (const boundary of [
    'claim/renew/begin/confirm/release/settle',
    'graph entry/terminal/reachability',
    'cross-tenant ID swap',
    'scope ALLOW/DENY',
    'concurrent enqueue',
    'submission barrier reconcile',
    'fresh migration',
    'no raw PII',
    'Inbound Voice',
  ]) {
    assert.match(serialized, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('CG2_ACCEPTED and J1_ACCEPTED are issued independently by the checks of their own domain', () => {
  const allPassing = CXA_C1_READINESS_CHECKS.map(({ id }) => ({ checkId: id, status: 'PASS' }));
  const summary = cxaC1Summary(allPassing);
  assert.deepEqual([...summary.markers].sort(), [CG2_MARKER, CORE_MARKER, J1_MARKER].sort());
  assert.equal(summary.entryCondition, CORE_MARKER);

  const j1FunctionalFailed = allPassing.map((diagnostic) =>
    diagnostic.checkId === 'j1-functional' ? { ...diagnostic, status: 'FAIL' } : diagnostic,
  );
  const partial = cxaC1Summary(j1FunctionalFailed);
  assert.deepEqual(partial.markers, [CG2_MARKER]);
  assert.equal(partial.entryCondition, 'NOT_READY');
});

test('CX_AUTOMATION_CORE_ACCEPTED must wait for both the CG2/J1 sub-markers and the regression gate', () => {
  const withoutRegression = CXA_C1_READINESS_CHECKS.filter(({ id }) => id !== 'regression').map(
    ({ id }) => ({ checkId: id, status: 'PASS' }),
  );
  const summary = cxaC1Summary(withoutRegression);
  assert.deepEqual([...summary.markers].sort(), [CG2_MARKER, J1_MARKER].sort());
  assert.equal(summary.entryCondition, 'NOT_READY');
});

test('when each check fails, the markers that depend on it must not be issued', () => {
  for (const failedCheck of CXA_C1_READINESS_CHECKS) {
    const result = runFixture({
      executeCheck(check) {
        return {
          checkId: check.id,
          boundaries: check.boundaries,
          status: check.id === failedCheck.id ? 'FAIL' : 'PASS',
          durationMs: 1,
        };
      },
    });
    for (const marker of failedCheck.markers) {
      assert.ok(!result.summary.markers.includes(marker), `${failedCheck.id} -> ${marker}`);
    }
    assert.equal(result.manifest.markers?.includes(CORE_MARKER) ?? false, false, failedCheck.id);
  }
});

test('manifest binds check artifacts to a single commit and rejects SHA/commit mismatch', () => {
  const result = runFixture();
  assert.deepEqual(
    [...result.manifest.markers].sort(),
    [CG2_MARKER, CORE_MARKER, J1_MARKER].sort(),
  );
  assert.doesNotThrow(() => assertValidCxaC1EvidenceManifest(result.manifest));

  const changedCommit = structuredClone(result.manifest);
  changedCommit.artifacts[0].commitSha = 'c'.repeat(40);
  assert.throws(
    () => assertValidCxaC1EvidenceManifest(changedCommit),
    /commit that does not match/,
  );

  const changedHash = structuredClone(result.manifest);
  changedHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertValidCxaC1EvidenceManifest(changedHash), /SHA-256/);
});

test('CORE marker is rejected when check, artifact or adapter evidence is incomplete', () => {
  const result = runFixture();

  const missingCheck = structuredClone(result.manifest);
  missingCheck.checks = [];
  missingCheck.artifacts = [];
  assert.throws(() => assertValidCxaC1EvidenceManifest(missingCheck), /every check/);

  const missingArtifact = structuredClone(result.manifest);
  missingArtifact.artifacts.pop();
  assert.throws(
    () => assertValidCxaC1EvidenceManifest(missingArtifact),
    /one evidence artifact per check/,
  );

  const missingProfileEvidence = structuredClone(result.manifest);
  missingProfileEvidence.checks
    .find(({ id }) => id === 'observability-pii-redaction')
    .subchecks.forEach((subcheck) => {
      subcheck.evidence = [];
    });
  missingProfileEvidence.artifacts = missingProfileEvidence.checks.map((check) => ({
    id: `check:${check.id}`,
    kind: 'readiness-diagnostic',
    commitSha: context.commitSha,
    sha256: sha256(check),
  }));
  assert.throws(() => assertValidCxaC1EvidenceManifest(missingProfileEvidence), /TEST_ADAPTER/);
});

test('evidence manifest rejects PII and credentials', () => {
  assert.throws(() => assertPiiSafeEvidence({ value: 'customer@example.test' }), /PII/);
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'do-not-record' }), /forbidden field/);
  assert.throws(() => assertPiiSafeEvidence({ contactRef: 'line-user-1234' }), /forbidden field/);
  assert.throws(() => assertPiiSafeEvidence({ lineId: 'U1234' }), /forbidden field/);
  assert.throws(() => assertPiiSafeEvidence({ crmId: 'crm-1234' }), /forbidden field/);
});

test('GitHub Actions run metadata is not PII, but the same number in business evidence is still rejected', () => {
  const runId = '35056293603';
  assert.doesNotThrow(() => assertPiiSafeEvidence({ run: { id: runId, attempt: 1 } }));
  assert.throws(() => assertPiiSafeEvidence({ value: runId }), /PII/);
});

test('C1 adapter profile fails closed and must not enable actual provider traffic', () => {
  assert.deepEqual(cxaC1AdapterProfileSummary({}), {
    type: 'adapter-profile.readiness',
    workflow: 'cx-automation-c1-adapter-profile',
    status: 'PASS',
    adapterProfile: 'TEST_ADAPTER',
    actualProviderTraffic: false,
  });
  assert.throws(
    () => cxaC1AdapterProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /must not enable actual provider traffic/,
  );
  assert.throws(
    () => cxaC1AdapterProfileSummary({ CXA_C1_ADAPTER_PROFILE: 'LIVE_PROVIDER' }),
    /supports only the TEST_ADAPTER/,
  );
});

test('adapter profile evidence is collected from a child process in the manifest diagnostic', () => {
  const profileCheck = CXA_C1_READINESS_CHECKS.find(
    ({ id }) => id === 'observability-pii-redaction',
  );
  const diagnostic = executeReadinessCheck({
    ...profileCheck,
    command: profileCheck.commands[2],
  });
  assert.equal(diagnostic.status, 'PASS');
  assert.deepEqual(diagnostic.evidence, [
    {
      type: 'adapter-profile.readiness',
      workflow: 'cx-automation-c1-adapter-profile',
      status: 'PASS',
      adapterProfile: 'TEST_ADAPTER',
      actualProviderTraffic: false,
    },
  ]);
});

test('manifest factory identifies migration evidence from the same check', () => {
  const diagnostics = CXA_C1_READINESS_CHECKS.map(({ id, dimension, markers }) => ({
    checkId: id,
    dimension,
    markers,
    status: 'PASS',
    boundaries: [],
    durationMs: 1,
    ...(id === 'observability-pii-redaction'
      ? {
          subchecks: [
            {
              command: [],
              status: 'PASS',
              durationMs: 1,
              evidence: [
                {
                  type: 'adapter-profile.readiness',
                  adapterProfile: 'TEST_ADAPTER',
                  actualProviderTraffic: false,
                },
              ],
            },
          ],
        }
      : {}),
  }));
  const manifest = createCxaC1EvidenceManifest(
    context,
    diagnostics,
    cxaC1Summary(diagnostics, new Date('2026-09-10T00:00:00.000Z')),
  );
  assert.equal(manifest.migration.status, 'PASS');
  assert.deepEqual(
    manifest.dimensions.map(({ name }) => name),
    [
      'functional',
      'tenant-isolation',
      'authorization',
      'idempotency',
      'concurrency',
      'recovery',
      'migration-compatibility',
      'observability-pii-redaction',
      'regression',
    ],
  );
  assert.ok(manifest.dimensions.every(({ status }) => status === 'PASS'));
});
