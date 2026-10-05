import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./e1-18-real-call-acceptance.mjs', import.meta.url), 'utf8');

test('E1 real-call acceptance เปิดเฉพาะ embed flag ที่ยังใช้งานอยู่', () => {
  assert.match(source, /'dphone\.embed\.enabled',true/);
  assert.doesNotMatch(source, /workSession\.lease\.enforced/);
});
