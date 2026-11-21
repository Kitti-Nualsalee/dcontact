import assert from 'node:assert/strict';
import test from 'node:test';
import {
  c360ServiceApiReadiness,
  resolveC360ServiceApiEnabled,
} from './customer-360-service-config.js';

test('External customer API ปิดเป็นค่าเริ่มต้น และเปิดเฉพาะเมื่อระบุ on', () => {
  assert.equal(resolveC360ServiceApiEnabled({}), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: '' }), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: 'off' }), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: 'on' }), true);
});

test('ค่าที่สะกดผิดหยุด API ตั้งแต่เริ่ม ไม่ถูกตีความเป็นเปิดหรือปิด', () => {
  for (const value of ['true', 'ON', '1', 'enabled'])
    assert.throws(() => resolveC360ServiceApiEnabled({ C360_SERVICE_API: value }));
});

test('readiness บอกว่า create ปิดเมื่อไม่มี introspection client', () => {
  assert.deepEqual(c360ServiceApiReadiness(false, true), {
    event: 'customer_360.service_api.readiness',
    status: 'DISABLED',
  });
  assert.equal(
    (c360ServiceApiReadiness(true, false) as { create: string }).create,
    'DISABLED_NO_INTROSPECTION_CLIENT',
  );
  assert.equal((c360ServiceApiReadiness(true, true) as { create: string }).create, 'ENABLED');
});
