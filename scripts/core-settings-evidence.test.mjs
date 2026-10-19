import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTap } from './core-settings-evidence.mjs';
const pass = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('Core evidence ยอมรับเฉพาะ TAP ที่มีผลครบและไม่มี skip/fail', () => {
  assert.equal(summarizeTap(pass).result, 'PASS');
  assert.equal(
    summarizeTap(pass.replace('# pass 2', '# pass 1').replace('# fail 0', '# fail 1')).result,
    'FAIL',
  );
  assert.equal(summarizeTap(pass.replace('# skipped 0', '# skipped 1')).result, 'NOT_RUN');
});
test('Core evidence ห้ามให้ PASS เมื่อยังไม่รัน ไม่มี summary หรือไม่มี tests', () => {
  assert.equal(summarizeTap('TAP version 13\n').result, 'NOT_RUN');
  assert.equal(summarizeTap(pass.replace('# tests 2', '# tests 0')).result, 'NOT_RUN');
  assert.equal(summarizeTap(pass.replace('# pass 2\n', '')).result, 'NOT_RUN');
});
