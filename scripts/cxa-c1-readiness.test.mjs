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

test('C1 readiness ครอบคลุม acceptance matrix ทั้งเก้ามิติและ regression gate', () => {
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

test('CG2_ACCEPTED และ J1_ACCEPTED ออกอิสระตาม check ของ domain ตัวเอง', () => {
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

test('CX_AUTOMATION_CORE_ACCEPTED ต้องรอทั้ง CG2/J1 sub-marker และ regression gate', () => {
  const withoutRegression = CXA_C1_READINESS_CHECKS.filter(({ id }) => id !== 'regression').map(
    ({ id }) => ({ checkId: id, status: 'PASS' }),
  );
  const summary = cxaC1Summary(withoutRegression);
  assert.deepEqual([...summary.markers].sort(), [CG2_MARKER, J1_MARKER].sort());
  assert.equal(summary.entryCondition, 'NOT_READY');
});

test('เมื่อแต่ละ check ล้ม marker ที่ขึ้นกับมันต้องไม่ออก', () => {
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

test('manifest ผูก check artifact กับ commit เดียวและปฏิเสธ SHA/commit mismatch', () => {
  const result = runFixture();
  assert.deepEqual(
    [...result.manifest.markers].sort(),
    [CG2_MARKER, CORE_MARKER, J1_MARKER].sort(),
  );
  assert.doesNotThrow(() => assertValidCxaC1EvidenceManifest(result.manifest));

  const changedCommit = structuredClone(result.manifest);
  changedCommit.artifacts[0].commitSha = 'c'.repeat(40);
  assert.throws(() => assertValidCxaC1EvidenceManifest(changedCommit), /commit ไม่ตรง/);

  const changedHash = structuredClone(result.manifest);
  changedHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertValidCxaC1EvidenceManifest(changedHash), /SHA-256/);
});

test('CORE marker ถูกปฏิเสธเมื่อ check, artifact หรือ adapter evidence ไม่ครบ', () => {
  const result = runFixture();

  const missingCheck = structuredClone(result.manifest);
  missingCheck.checks = [];
  missingCheck.artifacts = [];
  assert.throws(() => assertValidCxaC1EvidenceManifest(missingCheck), /check ครบทุกตัว/);

  const missingArtifact = structuredClone(result.manifest);
  missingArtifact.artifacts.pop();
  assert.throws(() => assertValidCxaC1EvidenceManifest(missingArtifact), /หนึ่งรายการต่อ check/);

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

test('evidence manifest ปฏิเสธ PII และ credential', () => {
  assert.throws(() => assertPiiSafeEvidence({ value: 'customer@example.test' }), /PII/);
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'do-not-record' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ contactRef: 'line-user-1234' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ lineId: 'U1234' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ crmId: 'crm-1234' }), /field ต้องห้าม/);
});

test('C1 adapter profile fail closed และห้าม actual provider traffic', () => {
  assert.deepEqual(cxaC1AdapterProfileSummary({}), {
    type: 'adapter-profile.readiness',
    workflow: 'cx-automation-c1-adapter-profile',
    status: 'PASS',
    adapterProfile: 'TEST_ADAPTER',
    actualProviderTraffic: false,
  });
  assert.throws(
    () => cxaC1AdapterProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /ห้ามเปิด actual provider traffic/,
  );
  assert.throws(
    () => cxaC1AdapterProfileSummary({ CXA_C1_ADAPTER_PROFILE: 'LIVE_PROVIDER' }),
    /TEST_ADAPTER เท่านั้น/,
  );
});

test('adapter profile evidence ถูกเก็บจาก child process ใน manifest diagnostic', () => {
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

test('manifest factory ระบุ migration evidence จาก check เดียวกัน', () => {
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
