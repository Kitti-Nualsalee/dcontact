import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHASE_ZERO_READINESS_CHECKS,
  createMemoizedExecuteCheck,
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
    ...Array.from({ length: 120 }, (_, index) => `      at frame ${index} ${'x'.repeat(1_000)}`),
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

test('บรรทัด not ok ที่อยู่กลาง TAP output ยาว ๆ ต้องไม่ถูกตัดทิ้ง', () => {
  // จำลอง TAP ของ suite ใหญ่: test ที่ล้มอยู่ตรงกลาง ไกลจากทั้งหัวและท้าย output
  // เคสนี้เกิดจริงตอนไล่ J2 acceptance — เห็นแค่ "# fail 1" แต่ไม่รู้ว่า test ไหนล้ม
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('not ok 61 - ตัวที่ล้มจริงซ่อนอยู่กลาง output');
  lines.push("  error: 'เงื่อนไขไม่เป็นจริงภายในเวลาที่กำหนด'");
  for (let i = 62; i <= 140; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('# tests 140', '# pass 139', '# fail 1');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout: lines.join('\n'),
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(diagnostic.detail, /not ok 61 - ตัวที่ล้มจริงซ่อนอยู่กลาง output/);
  assert.match(diagnostic.detail, /เงื่อนไขไม่เป็นจริงภายในเวลาที่กำหนด/);
  // ยังต้องตัดอยู่ ไม่ใช่เก็บทุกบรรทัด
  assert.match(diagnostic.detail, /diagnostic output truncated/);
  assert.equal(diagnostic.detail.includes('ok 100 - passing case 100'), false);
});

test('signal/exitCode ของ test file ที่ process ตาย ต้องรอดจากการ truncate', () => {
  // เจอจริงตอนไล่ J2/S1: journey-owner-ack-escalator ล้มแบบ file-level โดยเทสข้างในผ่านหมด
  // เหลือแต่ failureType/error ที่เหมือนกันทุกเคส ไม่มีอะไรบอกว่าเป็น SIGSEGV หรือ exit 1
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('not ok 61 - src/journey-owner-ack-escalator.integration.ts');
  lines.push("  failureType: 'testCodeFailure'");
  lines.push("  error: 'test failed'");
  lines.push("  code: 'ERR_TEST_FAILURE'");
  lines.push("  signal: 'SIGSEGV'");
  lines.push('  exitCode: 1');
  for (let i = 62; i <= 140; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('# tests 140', '# pass 139', '# fail 1');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout: lines.join('\n'),
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(diagnostic.detail, /signal: 'SIGSEGV'/);
  assert.match(diagnostic.detail, /exitCode: 1/);
  assert.match(diagnostic.detail, /diagnostic output truncated/);
});

test('บรรทัด # Error ของ async activity หลังเทสจบ ต้องรอดจากการ truncate', () => {
  // รูปนี้คัดมาจาก output จริงของ node --test ที่จำลอง promise reject หลัง test body จบ
  // เป็นอาการที่เจอบน CI: ตัวเทสรายงาน ok แต่ "ไฟล์" ล้มโดยไม่มีอะไรบอกสาเหตุ
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('ok 61 - เทสที่ผ่านแต่ทิ้ง async activity ไว้');
  lines.push(
    '# Error: Test "เทสที่ผ่านแต่ทิ้ง async activity ไว้" at src/x.integration.ts:3:1 generated' +
      ' asynchronous activity after the test ended. This activity created the error "Error:' +
      ' connection closed" and would have caused the test to fail, but instead triggered an' +
      ' unhandledRejection event.',
  );
  lines.push('not ok 61 - src/x.integration.ts');
  lines.push("  failureType: 'testCodeFailure'");
  for (let i = 62; i <= 140; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('# tests 140', '# pass 139', '# fail 1');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout: lines.join('\n'),
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(diagnostic.detail, /generated asynchronous activity after the test ended/);
  assert.match(diagnostic.detail, /connection closed/);
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

test('memoized executor รันคำสั่งซ้ำแค่ครั้งเดียวต่อ process แต่ผลลัพธ์ยังตรงกับคำสั่งนั้น', () => {
  let calls = 0;
  const execute = (check) => {
    calls += 1;
    return { status: 'PASS', durationMs: 1, command: check.command };
  };
  const memoized = createMemoizedExecuteCheck(execute);

  const first = memoized({ command: ['pnpm', 'a'] });
  const second = memoized({ command: ['pnpm', 'a'] });
  const third = memoized({ command: ['pnpm', 'b'] });

  assert.equal(calls, 2);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, third);
});

test('memoized executor ไม่แชร์ cache กันข้าม instance', () => {
  let calls = 0;
  const execute = (check) => {
    calls += 1;
    return { status: 'PASS', command: check.command };
  };

  createMemoizedExecuteCheck(execute)({ command: ['pnpm', 'a'] });
  createMemoizedExecuteCheck(execute)({ command: ['pnpm', 'a'] });

  assert.equal(calls, 2);
});
