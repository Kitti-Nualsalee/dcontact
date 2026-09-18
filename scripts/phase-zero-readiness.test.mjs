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

test('ข้อความ assertion ที่ตามหลังบรรทัด failure ต้องรอดจากการ truncate ไม่ใช่เหลือแค่ error code', () => {
  // รูปนี้คัดมาจาก CG4-OB02 ที่ล้มบน CI ระหว่าง J2 acceptance: เดิมเหลือแค่ code: 'ERR_ASSERTION'
  // จนบอกไม่ได้ว่า assert ตัวไหนล้ม ต้องเดาเอาเองว่า flaky เพราะอะไร
  const lines = [];
  for (let index = 1; index <= 60; index += 1) lines.push(`ok ${index} - passing case ${index}`);
  lines.push('not ok 61 - CG4-OB02: negative scan ไม่พบ PII');
  lines.push("  failureType: 'testCodeFailure'");
  lines.push('  error: |-');
  lines.push('    metrics มี 0812345678');
  lines.push('    + actual - expected');
  lines.push('    + true');
  lines.push('    - false');
  lines.push("  code: 'ERR_ASSERTION'");
  for (let index = 62; index <= 140; index += 1) lines.push(`ok ${index} - passing case ${index}`);
  lines.push('# tests 140', '# pass 139', '# fail 1');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout: lines.join('\n'),
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(diagnostic.detail, /CG4-OB02/);
  assert.match(diagnostic.detail, /metrics มี 0812345678/);
  assert.match(diagnostic.detail, /\+ actual - expected/);
  // บรรทัดของเทสที่ผ่านซึ่งอยู่นอก window ต้องไม่ถูกดึงกลับมาปนจนกลบสาเหตุ
  assert.doesNotMatch(diagnostic.detail, /passing case 100/);
});

/**
 * retry เฉพาะ process ที่ตายด้วย signal — กติกาต้องแคบพอที่ assertion แดงจะไม่ถูกรันซ้ำจนหายไป
 */
function signalCrashOutput(file = 'src/contact-governance-api.integration.ts') {
  return [
    'TAP version 13',
    `# Subtest: ${file}`,
    `not ok 1 - ${file}`,
    '  ---',
    '  duration_ms: 1569.606711',
    "  failureType: 'testCodeFailure'",
    '  exitCode: ~',
    "  signal: 'SIGSEGV'",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n');
}

function assertionFailureOutput() {
  return [
    'TAP version 13',
    '# Subtest: metrics ต้องไม่มี PII',
    'not ok 1 - metrics ต้องไม่มี PII',
    '  ---',
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n');
}

test('process ที่ตายด้วย signal โดยไม่มี assertion แดง ถูกรันซ้ำหนึ่งครั้งและผ่านได้', () => {
  const observed = [];
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], (...call) => {
    observed.push(call[0]);
    return observed.length === 1
      ? { status: 1, stdout: signalCrashOutput(), stderr: '' }
      : { status: 0, stdout: '1..1\n# pass 1\n# fail 0', stderr: '' };
  });

  assert.equal(observed.length, 2, 'ต้องรันซ้ำพอดีหนึ่งครั้ง');
  assert.equal(diagnostic.status, 'PASS');
  assert.equal(diagnostic.retriedAfterSignal, 'SIGSEGV');
});

test('signal ซ้ำรอบสองถือว่าแดงจริง และ diagnostic ยังบอกว่ามีการรันซ้ำ', () => {
  let calls = 0;
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
    calls += 1;
    return { status: 1, stdout: signalCrashOutput(), stderr: '' };
  });

  assert.equal(calls, 2, 'รันซ้ำได้ครั้งเดียว ไม่วนไม่จบ');
  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.retriedAfterSignal, 'SIGSEGV');
  assert.match(diagnostic.detail, /signal: 'SIGSEGV'/);
});

test('assertion ที่แดงจริงไม่ถูกรันซ้ำ แม้จะมีไฟล์ที่ตายด้วย signal ปนอยู่', () => {
  for (const stdout of [
    assertionFailureOutput(),
    [signalCrashOutput(), assertionFailureOutput()].join('\n'),
  ]) {
    let calls = 0;
    const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
      calls += 1;
      return { status: 1, stdout, stderr: '' };
    });

    assert.equal(calls, 1, 'assertion แดงต้องรันครั้งเดียว');
    assert.equal(diagnostic.status, 'FAIL');
    assert.equal(diagnostic.retriedAfterSignal, undefined);
  }
});

test('คำสั่งที่ล้มโดยไม่มี TAP failure block เลย (เช่น build error) ไม่ถูกรันซ้ำ', () => {
  let calls = 0;
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
    calls += 1;
    return { status: 1, stdout: '', stderr: 'error TS2345: type mismatch' };
  });

  assert.equal(calls, 1);
  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.retriedAfterSignal, undefined);
});
