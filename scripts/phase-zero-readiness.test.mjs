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

test('failed check เก็บข้อความ assertion ไว้ ไม่ใช่แค่บรรทัดสรุปท้ายสุด', () => {
  const assertionMessage = 'Expected: "อุปกรณ์เสียงพร้อม" Received: "กำลังตรวจอุปกรณ์"';
  const stdout = [
    '  1) [chromium] › e2e/media-readiness.spec.ts:3:1 › Agent เปิดรับสาย',
    `    Error: ${assertionMessage}`,
    ...Array.from({ length: 120 }, (_, index) => `      at frame ${index}`),
    '  2 failed',
    '  5 passed (13.5s)',
  ].join('\n');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout,
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(diagnostic.detail, /Expected: "อุปกรณ์เสียงพร้อม"/);
  assert.match(diagnostic.detail, /2 failed/);
  assert.match(diagnostic.detail, /diagnostic output truncated/);
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

test('successful check เก็บเฉพาะ structured evidence ที่ประกาศ prefix ไว้', () => {
  const diagnostic = executeReadinessCheck(
    { ...PHASE_ZERO_READINESS_CHECKS[0], evidencePrefix: 'PHASE_ONE_EVIDENCE ' },
    () => ({
      status: 0,
      stdout: 'password=dev-only\nPHASE_ONE_EVIDENCE {"kind":"thai-baseline","latencyMs":42}\n',
      stderr: '',
    }),
  );

  assert.deepEqual(diagnostic.evidence, [{ kind: 'thai-baseline', latencyMs: 42 }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /dev-only/);
});

test('downstream check แสดง blocker เมื่อ prerequisite ล้มเหลว', () => {
  const diagnostic = skippedDiagnostic(PHASE_ZERO_READINESS_CHECKS[4], 'database-baseline');

  assert.deepEqual(
    { status: diagnostic.status, blockedBy: diagnostic.blockedBy },
    { status: 'SKIP', blockedBy: 'database-baseline' },
  );
});
