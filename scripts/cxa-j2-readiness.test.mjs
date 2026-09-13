import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CXA_J2_READINESS_CHECKS,
  J2_MARKER,
  assertPiiSafeEvidence,
  assertValidCxaJ2EvidenceManifest,
  createCxaJ2EvidenceManifest,
  cxaJ2Summary,
  runCxaJ2Readiness,
  sha256,
} from './cxa-j2-readiness.mjs';
import { cxaJ2ProfileSummary } from './cxa-j2-profile-readiness.mjs';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const defaultBranchContext = {
  repository: 'Kitti-Nualsalee/dcontact',
  pullRequest: null,
  baseSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  runId: 'test-run',
  attempt: 1,
  isDefaultBranchRun: true,
};

const prContext = { ...defaultBranchContext, pullRequest: 87, isDefaultBranchRun: false };

function passingExecutor(check) {
  return {
    checkId: check.id,
    boundaries: check.boundaries,
    status: 'PASS',
    durationMs: 1,
    ...(check.id === 'J2-OB01'
      ? {
          evidence: [
            {
              type: 'owner-profile.readiness',
              casesOwnerProfile: 'DURABLE_OWNER',
              dialerOwnerProfile: 'DURABLE_OWNER',
              governanceProfile: 'TEST_ADAPTER',
              deliveryProfile: 'TEST_ADAPTER',
              actualProviderTraffic: false,
              providerConformance: false,
              releaseEnabled: false,
            },
          ],
        }
      : {}),
  };
}

function runFixture(options = {}) {
  return runCxaJ2Readiness({
    context: options.context ?? defaultBranchContext,
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    executeCheck: options.executeCheck ?? passingExecutor,
    emit: () => undefined,
    writeManifest: false,
  });
}

test('J2 readiness ครอบคลุม acceptance matrix ทั้ง 16 check ตาม #138', () => {
  assert.equal(CXA_J2_READINESS_CHECKS.length, 16);
  assert.deepEqual(
    CXA_J2_READINESS_CHECKS.map(({ id }) => id),
    [
      'J2-F01',
      'J2-F02',
      'J2-F03',
      'J2-F04',
      'J2-TI01',
      'J2-AU01',
      'J2-AU02',
      'J2-ID01',
      'J2-ID02',
      'J2-CC01',
      'J2-CC02',
      'J2-RC01',
      'J2-RC02',
      'J2-MG01',
      'J2-OB01',
      'J2-REG01',
    ],
  );
  const serialized = JSON.stringify(CXA_J2_READINESS_CHECKS);
  for (const boundary of [
    'canonical request/result hash',
    'enrollment + action intent atomic',
    'canonical Case writer',
    'originate barrier TEST_ADAPTER only',
    'cross-tenant rejection',
    'WORK scope',
    'ไม่ reuse admission decision',
    'version gap wait/reconcile',
    'IDENTITY_UNRESOLVED',
    'reconciler apply terminal-precedence',
    'TOO_LATE เมื่อ irreversible',
    'WAITING_FOR_GAP reevaluation',
    'JrRecoveryAudit append-only',
    'fresh migration',
    'no raw PII',
    'C1 acceptance',
  ]) {
    assert.match(serialized, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('JOURNEY_J2_ACCEPTED ออกเฉพาะเมื่อ check ครบ 16 ตัว PASS พร้อมกัน', () => {
  const allPassing = CXA_J2_READINESS_CHECKS.map(({ id }) => ({ checkId: id, status: 'PASS' }));
  const summary = cxaJ2Summary(allPassing, defaultBranchContext);
  assert.deepEqual(summary.markers, [J2_MARKER]);
  assert.equal(summary.entryCondition, J2_MARKER);

  const onePartialFail = allPassing.map((diagnostic, index) =>
    index === 3 ? { ...diagnostic, status: 'FAIL' } : diagnostic,
  );
  const partial = cxaJ2Summary(onePartialFail, defaultBranchContext);
  assert.deepEqual(partial.markers, []);
  assert.equal(partial.entryCondition, 'NOT_READY');
});

test('PR run (มี pullRequest) ไม่ออก marker แม้ check ทุกตัว PASS — ได้แค่ candidate manifest', () => {
  const result = runFixture({ context: prContext });
  assert.deepEqual(result.summary.markers, []);
  assert.equal(result.manifest.markers, undefined);
});

test('default-branch run ที่ check ครบ 16 ตัว PASS ออก JOURNEY_J2_ACCEPTED', () => {
  const result = runFixture();
  assert.deepEqual(result.manifest.markers, [J2_MARKER]);
  assert.doesNotThrow(() => assertValidCxaJ2EvidenceManifest(result.manifest));
});

test('เมื่อ check ใดก็ตามล้ม marker ต้องไม่ออก', () => {
  for (const failedCheck of CXA_J2_READINESS_CHECKS) {
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
    assert.equal(result.manifest.markers?.includes(J2_MARKER) ?? false, false, failedCheck.id);
  }
});

test('manifest ผูก check artifact กับ commit เดียวและปฏิเสธ SHA/commit mismatch', () => {
  const result = runFixture();
  assert.doesNotThrow(() => assertValidCxaJ2EvidenceManifest(result.manifest));

  const changedCommit = structuredClone(result.manifest);
  changedCommit.artifacts[0].commitSha = 'c'.repeat(40);
  assert.throws(() => assertValidCxaJ2EvidenceManifest(changedCommit), /commit ไม่ตรง/);

  const changedHash = structuredClone(result.manifest);
  changedHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertValidCxaJ2EvidenceManifest(changedHash), /SHA-256/);
});

test('marker ถูกปฏิเสธเมื่อ check, artifact หรือ owner profile evidence ไม่ครบ', () => {
  const result = runFixture();

  const missingCheck = structuredClone(result.manifest);
  missingCheck.checks = [];
  missingCheck.artifacts = [];
  assert.throws(() => assertValidCxaJ2EvidenceManifest(missingCheck), /check ครบทั้ง 16 ตัว/);

  const missingArtifact = structuredClone(result.manifest);
  missingArtifact.artifacts.pop();
  assert.throws(() => assertValidCxaJ2EvidenceManifest(missingArtifact), /หนึ่งรายการต่อ check/);

  const missingProfileEvidence = structuredClone(result.manifest);
  missingProfileEvidence.checks
    .find(({ id }) => id === 'J2-OB01')
    .subchecks.forEach((subcheck) => {
      subcheck.evidence = [];
    });
  missingProfileEvidence.artifacts = missingProfileEvidence.checks.map((check) => ({
    id: `check:${check.id}`,
    kind: 'readiness-diagnostic',
    commitSha: defaultBranchContext.commitSha,
    sha256: sha256(check),
  }));
  assert.throws(
    () => assertValidCxaJ2EvidenceManifest(missingProfileEvidence),
    /actual provider traffic\/release/,
  );
});

test('evidence manifest ปฏิเสธ PII และ credential', () => {
  assert.throws(() => assertPiiSafeEvidence({ value: 'customer@example.test' }), /PII/);
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'do-not-record' }), /field ต้องห้าม/);
  assert.throws(() => assertPiiSafeEvidence({ contactRef: 'line-user-1234' }), /field ต้องห้าม/);
});

test('J2 owner profile fail closed เมื่อ Cases/Dialer ไม่ใช่ DURABLE_OWNER หรือเปิด provider traffic/release', () => {
  assert.deepEqual(cxaJ2ProfileSummary({}), {
    type: 'owner-profile.readiness',
    workflow: 'cx-automation-j2-owner-profile',
    status: 'PASS',
    casesOwnerProfile: 'DURABLE_OWNER',
    dialerOwnerProfile: 'DURABLE_OWNER',
    governanceProfile: 'TEST_ADAPTER',
    deliveryProfile: 'TEST_ADAPTER',
    developmentAcceptance: true,
    actualProviderTraffic: false,
    providerConformance: false,
    releaseEnabled: false,
  });
  assert.throws(
    () => cxaJ2ProfileSummary({ CXA_J2_CASES_OWNER_PROFILE: 'IN_MEMORY' }),
    /Cases owner profile/,
  );
  assert.throws(
    () => cxaJ2ProfileSummary({ CXA_J2_DIALER_OWNER_PROFILE: 'IN_MEMORY' }),
    /Dialer owner profile/,
  );
  assert.throws(
    () => cxaJ2ProfileSummary({ CXA_J2_GOVERNANCE_PROFILE: 'LIVE_PROVIDER' }),
    /governance profile/,
  );
  assert.throws(
    () => cxaJ2ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /ห้ามเปิด actual provider traffic/,
  );
  assert.throws(() => cxaJ2ProfileSummary({ CXA_J2_RELEASE_ENABLED: 'true' }), /releaseEnabled/);
  assert.equal(
    cxaJ2ProfileSummary({ CXA_J2_GOVERNANCE_PROFILE: 'CG3_INTEGRATED' }).governanceProfile,
    'CG3_INTEGRATED',
  );
});

test('owner profile evidence ถูกเก็บจาก child process ใน manifest diagnostic', () => {
  const profileCheck = CXA_J2_READINESS_CHECKS.find(({ id }) => id === 'J2-OB01');
  const diagnostic = executeReadinessCheck({
    ...profileCheck,
    command: profileCheck.commands[2],
  });
  assert.equal(diagnostic.status, 'PASS');
  assert.equal(diagnostic.evidence?.[0]?.type, 'owner-profile.readiness');
  assert.equal(diagnostic.evidence?.[0]?.actualProviderTraffic, false);
});

test('manifest factory ระบุ dimension ครบตาม check matrix', () => {
  const diagnostics = CXA_J2_READINESS_CHECKS.map(({ id, dimension }) => ({
    checkId: id,
    dimension,
    status: 'PASS',
    boundaries: [],
    durationMs: 1,
    ...(id === 'J2-OB01'
      ? {
          subchecks: [
            {
              command: [],
              status: 'PASS',
              durationMs: 1,
              evidence: [
                {
                  type: 'owner-profile.readiness',
                  actualProviderTraffic: false,
                  providerConformance: false,
                  releaseEnabled: false,
                },
              ],
            },
          ],
        }
      : {}),
  }));
  const manifest = createCxaJ2EvidenceManifest(
    defaultBranchContext,
    diagnostics,
    cxaJ2Summary(diagnostics, defaultBranchContext, new Date('2026-09-13T00:00:00.000Z')),
  );
  assert.equal(manifest.migration.status, 'PASS');
  assert.deepEqual(
    [...new Set(manifest.dimensions.map(({ name }) => name))].sort(),
    [...new Set(CXA_J2_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
  );
  assert.ok(manifest.dimensions.every(({ status }) => status === 'PASS'));
});
