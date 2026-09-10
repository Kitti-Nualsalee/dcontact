import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DeliveryTestAdapter } from './delivery-test-adapter.js';

const FORBIDDEN_TOKENS = ['fetch(', 'node:http', 'node:https', 'axios', 'undici'];

test('DeliveryTestAdapter ยืนยันตัวเองเป็น TEST_ADAPTER', () => {
  const adapter = new DeliveryTestAdapter({} as never, {} as never);
  assert.equal(adapter.adapterProfile, 'TEST_ADAPTER');
});

test('source ของ adapter ไม่มี provider SDK, HTTP client หรือ network I/O จริง', async () => {
  const source = await readFile(new URL('delivery-test-adapter.ts', import.meta.url), 'utf8');
  for (const token of FORBIDDEN_TOKENS) {
    assert.equal(source.includes(token), false, `ต้องไม่มี ${token} ใน TEST_ADAPTER`);
  }
});
