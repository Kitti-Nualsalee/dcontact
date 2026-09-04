import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHASE_ZERO_READINESS_CHECKS,
  executeReadinessCheck,
  sanitizeDiagnostic,
  skippedDiagnostic,
} from './phase-zero-readiness.mjs';

test('readiness plan ครอบคลุม Phase 0 dependencies และไม่เพิ่ม feature ของ Phase 1', () => {
  const serialized = JSON.stringify(PHASE_ZERO_READINESS_CHECKS);
  for (const dependency of [
    'PostgreSQL',
    'Redis',
    'MinIO',
    'Redpanda',
    'FreeSWITCH',
    'Keycloak',
    'dcontact_app',
    '@d-contact/kafka',
  ]) {
    assert.match(serialized, new RegExp(dependency.replaceAll('@', '\\@')));
  }
  assert.doesNotMatch(
    serialized,
    /Router|Queue|Agent Workspace|recording\/QM|IVR|production deployment/,
  );
});

test('diagnostic ไม่เผย token, password, secret หรือ connection credential', () => {
  const unsafe =
    'authorization=Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature password=hello client_secret:world postgresql://app:db-pass@localhost/db';
  const safe = sanitizeDiagnostic(unsafe);

  assert.doesNotMatch(safe, /eyJ|hello|world|db-pass/);
  assert.match(safe, /REDACTED/);
});

test('failed check ระบุ dependency, boundary และ remediation แบบ structured', () => {
  const check = PHASE_ZERO_READINESS_CHECKS[2];
  const diagnostic = executeReadinessCheck(check, () => ({
    status: 1,
    stdout: '',
    stderr: '✗ MinIO recordings bucket: password=do-not-print',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.dependency, 'Phase 0 infrastructure');
  assert.ok(diagnostic.boundaries.includes('MinIO recordings bucket'));
  assert.match(diagnostic.remediation, /dependency/);
  assert.doesNotMatch(diagnostic.detail, /do-not-print/);
});

test('successful check ไม่สะท้อน child output ที่อาจมี dev credential', () => {
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[0], () => ({
    status: 0,
    stdout: 'password=dev-only',
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'PASS');
  assert.equal('detail' in diagnostic, false);
});

test('downstream check แสดง blocker เมื่อ prerequisite ล้มเหลว', () => {
  const diagnostic = skippedDiagnostic(PHASE_ZERO_READINESS_CHECKS[4], 'database-baseline');

  assert.deepEqual(
    { status: diagnostic.status, blockedBy: diagnostic.blockedBy },
    { status: 'SKIP', blockedBy: 'database-baseline' },
  );
});
