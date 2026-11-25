import assert from 'node:assert/strict';
import test from 'node:test';
import {
  c360ServiceApiReadiness,
  resolveC360ServiceApiEnabled,
} from './customer-360-service-config.js';

test('the External customer API is off by default and enabled only when on is given', () => {
  assert.equal(resolveC360ServiceApiEnabled({}), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: '' }), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: 'off' }), false);
  assert.equal(resolveC360ServiceApiEnabled({ C360_SERVICE_API: 'on' }), true);
});

test('a misspelled value stops the API at start and is not interpreted as on or off', () => {
  for (const value of ['true', 'ON', '1', 'enabled'])
    assert.throws(() => resolveC360ServiceApiEnabled({ C360_SERVICE_API: value }));
});

test('readiness says create is off when there is no introspection client', () => {
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
