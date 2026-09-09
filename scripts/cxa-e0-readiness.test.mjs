import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CXA_E0_READINESS_CHECKS,
  assertPiiSafeEvidence,
  assertValidEvidenceManifest,
  createCxaE0EvidenceManifest,
  cxaE0Summary,
  runCxaE0Readiness,
} from './cxa-e0-readiness.mjs';
import { cxaE0AdapterProfileSummary } from './cxa-e0-profile-readiness.mjs';

const context = {
  repository: 'Kitti-Nualsalee/dcontact',
  pullRequest: 70,
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
  };
}

function runFixture(options = {}) {
  return runCxaE0Readiness({
    context,
    now: () => new Date('2026-09-10T00:00:00.000Z'),
    executeCheck: options.executeCheck ?? passingExecutor,
    emit: () => undefined,
    writeManifest: false,
  });
}

test('E0 readiness ครอบคลุม acceptance matrix ทั้งเก้ามิติและ regression gate', () => {
  assert.deepEqual(
    CXA_E0_READINESS_CHECKS.map(({ dimension }) => dimension),
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
  const serialized = JSON.stringify(CXA_E0_READINESS_CHECKS);
  for (const boundary of [
    'DC_EXPR V1',
    'cross-tenant ID swap',
    'scope allow/deny',
    'concurrent event',
    'crash before/after commit',
    'V1 legacy decode',
    'no raw PII key/header/log',
    'CX Automation Phase 1',
  ]) {
    assert.match(serialized, new RegExp(boundary, 'i'));
  }
});

test('marker ออกเฉพาะเมื่อ mandatory E0 checks ผ่านทั้งหมด', () => {
  const allPassing = CXA_E0_READINESS_CHECKS.map(({ id, dimension }) => ({
    checkId: id,
    dimension,
    status: 'PASS',
  }));
  assert.equal(cxaE0Summary(allPassing).entryCondition, 'CX_AUTOMATION_E0_CONTRACTS_ACCEPTED');
  assert.equal(cxaE0Summary(allPassing.slice(1)).entryCondition, 'NOT_READY');
  assert.equal(cxaE0Summary([...allPassing, { status: 'FAIL' }]).entryCondition, 'NOT_READY');
});

test('เมื่อแต่ละมิติล้ม marker ต้องไม่ออก', () => {
  for (const failedCheck of CXA_E0_READINESS_CHECKS) {
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
    assert.equal(result.summary.entryCondition, 'NOT_READY', failedCheck.dimension);
    assert.equal(result.manifest.marker, undefined, failedCheck.dimension);
  }
});

test('manifest ผูก check artifact กับ commit เดียวและปฏิเสธ SHA/commit mismatch', () => {
  const result = runFixture();
  assert.equal(result.manifest.marker, 'CX_AUTOMATION_E0_CONTRACTS_ACCEPTED');
  assert.doesNotThrow(() => assertValidEvidenceManifest(result.manifest));

  const changedCommit = structuredClone(result.manifest);
  changedCommit.artifacts[0].commitSha = 'c'.repeat(40);
  assert.throws(() => assertValidEvidenceManifest(changedCommit), /commit ไม่ตรง/);

  const changedHash = structuredClone(result.manifest);
  changedHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertValidEvidenceManifest(changedHash), /SHA-256/);
});

test('evidence manifest ปฏิเสธ PII และ credential', () => {
  assert.throws(() => assertPiiSafeEvidence({ value: 'customer@example.test' }), /PII/);
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'do-not-record' }), /field ต้องห้าม/);
});

test('E0 adapter profile fail closed และห้าม actual provider traffic', () => {
  assert.deepEqual(cxaE0AdapterProfileSummary({}), {
    type: 'adapter-profile.readiness',
    workflow: 'cx-automation-e0-adapter-profile',
    status: 'PASS',
    adapterProfile: 'TEST_ADAPTER',
    actualProviderTraffic: false,
  });
  assert.throws(
    () => cxaE0AdapterProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /ห้ามเปิด actual provider traffic/,
  );
  assert.throws(
    () => cxaE0AdapterProfileSummary({ CXA_E0_ADAPTER_PROFILE: 'LIVE_PROVIDER' }),
    /TEST_ADAPTER เท่านั้น/,
  );
});

test('manifest factory ระบุ migration และ rollback evidence จาก check เดียวกัน', () => {
  const diagnostics = [
    {
      checkId: 'migration-compatibility',
      dimension: 'migration-compatibility',
      status: 'PASS',
      boundaries: [],
      durationMs: 1,
    },
  ];
  const manifest = createCxaE0EvidenceManifest(
    context,
    diagnostics,
    cxaE0Summary(diagnostics, new Date('2026-09-10T00:00:00.000Z')),
  );
  assert.equal(manifest.migration.status, 'PASS');
  assert.equal(manifest.rollback.decoder, 'Kafka V1_LEGACY compatibility');
});
