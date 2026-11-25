import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHASE_ZERO_READINESS_CHECKS,
  createMemoizedExecuteCheck,
  executeReadinessCheck,
  redactRunId,
  sanitizeDiagnostic,
  skippedDiagnostic,
} from './phase-zero-readiness.mjs';

test('the readiness plan covers the Phase 0 dependencies and adds no Phase 1 feature', () => {
  const serialized = JSON.stringify(PHASE_ZERO_READINESS_CHECKS);
  for (const dependency of [
    'PostgreSQL',
    'Redis',
    'Object storage',
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

test('the diagnostic does not reveal a token, password, secret or connection credential', () => {
  const unsafe =
    'authorization=Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature password=hello client_secret:world postgresql://app:db-pass@localhost/db';
  const safe = sanitizeDiagnostic(unsafe);

  assert.doesNotMatch(safe, /eyJ|hello|world|db-pass/);
  assert.match(safe, /REDACTED/);
});

test('the diagnostic replaces a GitHub run ID that happens to look like a phone number, so the PII guard does not fail the manifest', () => {
  const output = 'evidence: artifacts/cxa-e0/36683968610.json';
  assert.match(output, /(?:\+?66|0)\d{8,9}\b/);
  const safe = redactRunId(output, '36683968610');
  assert.equal(safe, 'evidence: artifacts/cxa-e0/[RUN_ID].json');
  assert.doesNotMatch(safe, /(?:\+?66|0)\d{8,9}\b/);
  assert.equal(redactRunId(output, 'local-x'), output);
});

test('a failed check states the dependency, boundary and remediation in a structured way', () => {
  const check = PHASE_ZERO_READINESS_CHECKS[2];
  const diagnostic = executeReadinessCheck(check, () => ({
    status: 1,
    stdout: '',
    stderr: '✗ Object storage has bucket recordings: password=do-not-print',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.dependency, 'Phase 0 infrastructure');
  assert.ok(diagnostic.boundaries.includes('Object storage buckets (S3 HeadBucket)'));
  assert.match(diagnostic.remediation, /dependency/);
  assert.doesNotMatch(diagnostic.detail, /do-not-print/);
});

test('a failed check keeps the assertion message, not just the last summary line', () => {
  const assertionMessage = 'Expected: "Audio device ready" Received: "Checking audio device"';
  const stdout = [
    '  1) [chromium] › e2e/media-readiness.spec.ts:3:1 › Agent accepts calls',
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
  assert.match(diagnostic.detail, /Expected: "Audio device ready"/);
  assert.match(diagnostic.detail, /2 failed/);
  assert.match(diagnostic.detail, /diagnostic output truncated/);
});

test('a not ok line in the middle of a long TAP output must not be cut off', () => {
  // simulate the TAP of a big suite: the failing test is in the middle, far from both the head and the tail of the output
  // this case happened for real while chasing the J2 acceptance - only "# fail 1" was visible with no way to tell which test failed
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('not ok 61 - the really failing one hidden in the middle of the output');
  lines.push("  error: 'condition not met within the allotted time'");
  for (let i = 62; i <= 140; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('# tests 140', '# pass 139', '# fail 1');

  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => ({
    status: 1,
    stdout: lines.join('\n'),
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'FAIL');
  assert.match(
    diagnostic.detail,
    /not ok 61 - the really failing one hidden in the middle of the output/,
  );
  assert.match(diagnostic.detail, /condition not met within the allotted time/);
  // it must still be truncated, not keep every line
  assert.match(diagnostic.detail, /diagnostic output truncated/);
  assert.equal(diagnostic.detail.includes('ok 100 - passing case 100'), false);
});

test('the signal/exitCode of a test file whose process died must survive truncation', () => {
  // found for real while chasing J2/S1: journey-owner-ack-escalator failed at file level while every inner test passed
  // leaving only the failureType/error that is the same in every case, with nothing saying it was SIGSEGV or exit 1
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

test('the # Error line of async activity after a test ends must survive truncation', () => {
  // this shape is taken from the real output of node --test simulating a promise reject after the test body ended
  // the symptom seen on CI: the test reports ok but the "file" fails with nothing saying why
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case ${i}`);
  lines.push('ok 61 - a test that passed but left async activity behind');
  lines.push(
    '# Error: Test "a test that passed but left async activity behind" at src/x.integration.ts:3:1 generated' +
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

test('a successful check does not echo child output that may have a dev credential', () => {
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[0], () => ({
    status: 0,
    stdout: 'password=dev-only',
    stderr: '',
  }));

  assert.equal(diagnostic.status, 'PASS');
  assert.equal('detail' in diagnostic, false);
});

test('a successful check keeps only the structured evidence whose prefix is declared', () => {
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

test('a downstream check shows a blocker when a prerequisite fails', () => {
  const diagnostic = skippedDiagnostic(PHASE_ZERO_READINESS_CHECKS[4], 'database-baseline');

  assert.deepEqual(
    { status: diagnostic.status, blockedBy: diagnostic.blockedBy },
    { status: 'SKIP', blockedBy: 'database-baseline' },
  );
});

test('the memoized executor runs a repeated command only once per process, while the result still matches that command', () => {
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

test('the memoized executor does not share a cache across instances', () => {
  let calls = 0;
  const execute = (check) => {
    calls += 1;
    return { status: 'PASS', command: check.command };
  };

  createMemoizedExecuteCheck(execute)({ command: ['pnpm', 'a'] });
  createMemoizedExecuteCheck(execute)({ command: ['pnpm', 'a'] });

  assert.equal(calls, 2);
});

test('an assertion message that follows a failure line must survive truncation, not leave only an error code', () => {
  // this shape is taken from CG4-OB02, which failed on CI during the J2 acceptance: it used to leave only code: 'ERR_ASSERTION'
  // with no way to tell which assert failed, forcing a guess at why it was flaky
  const lines = [];
  for (let index = 1; index <= 60; index += 1) lines.push(`ok ${index} - passing case ${index}`);
  lines.push('not ok 61 - CG4-OB02: the negative scan finds no PII');
  lines.push("  failureType: 'testCodeFailure'");
  lines.push('  error: |-');
  lines.push('    metrics contain 0812345678');
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
  assert.match(diagnostic.detail, /metrics contain 0812345678/);
  assert.match(diagnostic.detail, /\+ actual - expected/);
  // lines of passed tests outside the window must not be pulled back in and bury the cause
  assert.doesNotMatch(diagnostic.detail, /passing case 100/);
});

/**
 * retry only a process that died by a signal - the rule must be narrow enough that a red assertion is not re-run until it disappears
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
    '# Subtest: metrics must contain no PII',
    'not ok 1 - metrics must contain no PII',
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

test('a process that died by a signal with no red assertion is re-run once and can pass', () => {
  const observed = [];
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], (...call) => {
    observed.push(call[0]);
    return observed.length === 1
      ? { status: 1, stdout: signalCrashOutput(), stderr: '' }
      : { status: 0, stdout: '1..1\n# pass 1\n# fail 0', stderr: '' };
  });

  assert.equal(observed.length, 2, 'must re-run exactly once');
  assert.equal(diagnostic.status, 'PASS');
  assert.equal(diagnostic.retriedAfterSignal, 'SIGSEGV');
});

test('a repeated signal on the second round counts as truly red and the diagnostic still says it was re-run', () => {
  let calls = 0;
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
    calls += 1;
    return { status: 1, stdout: signalCrashOutput(), stderr: '' };
  });

  assert.equal(calls, 2, 'may re-run only once, never loop forever');
  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.retriedAfterSignal, 'SIGSEGV');
  assert.match(diagnostic.detail, /signal: 'SIGSEGV'/);
});

test('a really red assertion is not re-run even when a file that died by a signal is mixed in', () => {
  for (const stdout of [
    assertionFailureOutput(),
    [signalCrashOutput(), assertionFailureOutput()].join('\n'),
  ]) {
    let calls = 0;
    const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
      calls += 1;
      return { status: 1, stdout, stderr: '' };
    });

    assert.equal(calls, 1, 'a red assertion must run once');
    assert.equal(diagnostic.status, 'FAIL');
    assert.equal(diagnostic.retriedAfterSignal, undefined);
  }
});

test('a command that fails with no TAP failure block at all (e.g. a build error) is not re-run', () => {
  let calls = 0;
  const diagnostic = executeReadinessCheck(PHASE_ZERO_READINESS_CHECKS[2], () => {
    calls += 1;
    return { status: 1, stdout: '', stderr: 'error TS2345: type mismatch' };
  });

  assert.equal(calls, 1);
  assert.equal(diagnostic.status, 'FAIL');
  assert.equal(diagnostic.retriedAfterSignal, undefined);
});
