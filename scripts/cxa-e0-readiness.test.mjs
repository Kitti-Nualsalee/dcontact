import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CXA_E0_READINESS_CHECKS,
  assertPiiSafeEvidence,
  assertValidEvidenceManifest,
  createCxaE0EvidenceManifest,
  cxaE0Summary,
  runCxaE0Readiness,
  sha256,
} from './cxa-e0-readiness.mjs';
import { cxaE0AdapterProfileSummary } from './cxa-e0-profile-readiness.mjs';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

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

test('subcheck ที่ล้มส่งต่อ diagnostic ที่ sanitize แล้วลง evidence manifest', () => {
  const result = runFixture({
    executeCheck(check) {
      if (check.id === 'regression' && check.command.at(-1) === 'cxa:phase1:acceptance') {
        return {
          checkId: check.id,
          status: 'FAIL',
          durationMs: 1,
          detail: 'Phase 1 acceptance failed at service identity boundary.',
          remediation: 'Inspect the Phase 1 readiness diagnostic.',
        };
      }
      return passingExecutor(check);
    },
  });
  const regression = result.manifest.checks.find((check) => check.id === 'regression');
  const failure = regression.subchecks.find(
    (check) => check.command.at(-1) === 'cxa:phase1:acceptance',
  );
  assert.equal(failure.detail, 'Phase 1 acceptance failed at service identity boundary.');
  assert.equal(failure.remediation, 'Inspect the Phase 1 readiness diagnostic.');
  assert.equal(result.manifest.marker, undefined);
  assert.doesNotThrow(() => assertValidEvidenceManifest(result.manifest));
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

test('marker ถูกปฏิเสธเมื่อ mandatory check, artifact หรือ adapter evidence ไม่ครบ', () => {
  const result = runFixture();

  const missingCheck = structuredClone(result.manifest);
  missingCheck.checks = [];
  missingCheck.artifacts = [];
  assert.throws(() => assertValidEvidenceManifest(missingCheck), /mandatory E0 checks/);

  const missingArtifact = structuredClone(result.manifest);
  missingArtifact.artifacts.pop();
  assert.throws(() => assertValidEvidenceManifest(missingArtifact), /หนึ่งรายการต่อ check/);

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
  assert.throws(() => assertValidEvidenceManifest(missingProfileEvidence), /TEST_ADAPTER/);
});

test('evidence manifest ปฏิเสธ PII และ credential', () => {
  assert.throws(() => assertPiiSafeEvidence({ value: 'customer@example.test' }), /PII/);
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'do-not-record' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ contactRef: 'line-user-1234' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ lineId: 'U1234' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ crmId: 'crm-1234' }), /field ต้องห้าม/);
});

test('GitHub Actions run metadata ไม่ใช่ PII แต่เลขเดียวกันใน business evidence ยังถูกปฏิเสธ', () => {
  const runId = '35063553495';
  assert.doesNotThrow(() => assertPiiSafeEvidence({ run: { id: runId, attempt: 1 } }));
  assert.throws(() => assertPiiSafeEvidence({ value: runId }), /PII/);
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

test('adapter profile evidence ถูกเก็บจาก child process ใน manifest diagnostic', () => {
  const profileCheck = CXA_E0_READINESS_CHECKS.find(
    ({ id }) => id === 'observability-pii-redaction',
  );
  const diagnostic = executeReadinessCheck({
    ...profileCheck,
    command: profileCheck.commands[1],
  });
  assert.equal(diagnostic.status, 'PASS');
  assert.deepEqual(diagnostic.evidence, [
    {
      type: 'adapter-profile.readiness',
      workflow: 'cx-automation-e0-adapter-profile',
      status: 'PASS',
      adapterProfile: 'TEST_ADAPTER',
      actualProviderTraffic: false,
    },
  ]);
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
