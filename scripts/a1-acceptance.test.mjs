import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  A1_CHECKS,
  NON_WAIVABLE_GATES,
  judge,
  parsePlaywright,
  parseTap,
  redactLog,
  runA1Acceptance,
} from './a1-acceptance.mjs';

const tap = (pass, extra = {}) =>
  [
    '# tests 3',
    `# pass ${pass}`,
    `# fail ${extra.fail ?? 0}`,
    `# cancelled 0`,
    `# skipped ${extra.skipped ?? 0}`,
    `# todo ${extra.todo ?? 0}`,
  ].join('\n');

test('parseTap: ผ่านเมื่อ pass > 0 และไม่มี fail/skip/todo; ไม่มี summary = UNKNOWN', () => {
  assert.equal(parseTap(tap(3)).status, 'PASS');
  assert.equal(parseTap(`${tap(3)}\n${tap(2)}`).counters.pass, 5);
  assert.equal(parseTap(tap(3, { fail: 1 })).status, 'FAIL');
  assert.equal(parseTap(tap(3, { skipped: 1 })).status, 'SKIPPED');
  assert.equal(parseTap(tap(3, { todo: 1 })).status, 'SKIPPED');
  assert.equal(parseTap(tap(0)).status, 'UNKNOWN');
  assert.equal(parseTap('ELIFECYCLE Command failed').status, 'UNKNOWN');
});

test('parsePlaywright/judge: flaky/skipped ไม่ผ่าน และ exit code ≠ 0 ชนะ summary', () => {
  assert.equal(parsePlaywright('  6 passed (10.2s)').status, 'PASS');
  assert.equal(parsePlaywright('  5 passed\n  1 flaky').status, 'SKIPPED');
  assert.equal(parsePlaywright('  1 failed\n  5 passed').status, 'FAIL');
  assert.equal(parsePlaywright('no tests found').status, 'UNKNOWN');
  const check = A1_CHECKS.find((entry) => entry.parser === 'tap');
  assert.equal(judge(check, 1, tap(3)).status, 'FAIL');
  assert.equal(judge({ parser: 'exit' }, 0, '').status, 'PASS');
});

test('redactLog: ตัด JWT, email, credential ใน URL และ action token', () => {
  const redacted = redactLog(
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc owner@example.test postgresql://u:secret@db/x ' +
      'http://kc/login-actions/action-token?key=abc.def&client=x',
  );
  for (const leaked of ['eyJhbGciOiJIUzI1NiJ9', 'owner@example.test', 'secret@', 'key=abc']) {
    assert.equal(redacted.includes(leaked), false, leaked);
  }
});

test('ทุก non-waivable gate มี check ครอบใน fast profile', () => {
  const fast = A1_CHECKS.filter((check) => check.profile === 'fast');
  for (const gate of NON_WAIVABLE_GATES) {
    assert.ok(
      fast.some((check) => check.gates.includes(gate)),
      gate,
    );
  }
  assert.equal(new Set(A1_CHECKS.map((check) => check.id)).size, A1_CHECKS.length);
});

test('runA1Acceptance: skip = FAIL, manifest ผูก commit/config digest และเก็บ log ที่ redact แล้วเฉพาะ check ที่ล้ม', () => {
  const outputs = new Map([
    ['A1-F-CONTRACT', tap(4)],
    ['A1-F-SCHEMA-REGISTRY', tap(4, { skipped: 1 })],
  ]);
  const manifest = runA1Acceptance({
    profile: 'fast',
    only: ['A1-F-CONTRACT', 'A1-F-SCHEMA-REGISTRY'],
    runId: `test-run-${process.pid}`,
    execute: (_command, args) => {
      const id = args.includes('scripts/a1-schema-readiness.test.mjs')
        ? 'A1-F-SCHEMA-REGISTRY'
        : 'A1-F-CONTRACT';
      return {
        status: 0,
        stdout: `${outputs.get(id)}\nfailure for owner@example.test`,
        stderr: '',
      };
    },
  });
  assert.equal(manifest.status, 'FAIL');
  assert.deepEqual(
    manifest.checks.map((check) => [check.checkId, check.status]),
    [
      ['A1-F-CONTRACT', 'PASS'],
      ['A1-F-SCHEMA-REGISTRY', 'SKIPPED'],
    ],
  );
  // gate ที่ check ใน run นี้ไม่ครอบ = UNCOVERED (ไม่ถือว่าผ่าน)
  assert.equal(manifest.nonWaivable.isolation, 'UNCOVERED');
  assert.match(manifest.source.config.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.artifacts.length, 1);
  const log = readFileSync(`artifacts/a1/${manifest.run.id}/${manifest.artifacts[0].file}`, 'utf8');
  assert.equal(log.includes('owner@example.test'), false);
});
