import assert from 'node:assert/strict';
import test from 'node:test';
import { lockHostOrigin, parseEmbedConfig, resolveHostOrigin } from './embed/origin-lock.js';

const config = parseEmbedConfig(
  JSON.stringify({ v: 1, tenant: 'demo', allowedHostOrigins: ['https://crm.example.test'] }),
);

test('config: รับเฉพาะ v1 ที่มี allowlist เป็น string', () => {
  assert.equal(parseEmbedConfig(null), null);
  assert.equal(parseEmbedConfig('{'), null);
  assert.equal(parseEmbedConfig(JSON.stringify({ v: 2, allowedHostOrigins: [] })), null);
  assert.equal(parseEmbedConfig(JSON.stringify({ v: 1, allowedHostOrigins: [1] })), null);
  assert.deepEqual(config?.allowedHostOrigins, ['https://crm.example.test']);
});

test('host origin: ancestorOrigins ก่อน referrer', () => {
  assert.equal(
    resolveHostOrigin({
      ancestorOrigins: ['https://crm.example.test'],
      referrer: 'https://x.test/a',
    }),
    'https://crm.example.test',
  );
  assert.equal(
    resolveHostOrigin({ referrer: 'https://crm.example.test/app?x=1' }),
    'https://crm.example.test',
  );
  assert.equal(resolveHostOrigin({ referrer: '' }), null);
});

test('origin ที่ไม่อยู่ใน allowlist ไม่เริ่มทำงาน; หลังล็อกรับเฉพาะ exact origin จาก parent จนถูกเพิกถอน', () => {
  const parent = {};
  assert.equal(lockHostOrigin(config, 'https://evil.example.test', parent), null);
  assert.equal(lockHostOrigin(config, 'https://crm.example.test.evil.test', parent), null);
  assert.equal(lockHostOrigin(null, 'https://crm.example.test', parent), null);

  const lock = lockHostOrigin(config, 'https://crm.example.test', parent)!;
  assert.equal(lock.accepts({ origin: 'https://crm.example.test', source: parent }), true);
  assert.equal(lock.accepts({ origin: 'https://crm.example.test', source: {} }), false);
  assert.equal(lock.accepts({ origin: 'https://other.example.test', source: parent }), false);
  assert.equal(lock.revoke('https://other.example.test'), false);
  assert.equal(lock.revoke('https://crm.example.test'), true);
  assert.equal(lock.accepts({ origin: 'https://crm.example.test', source: parent }), false);
});
