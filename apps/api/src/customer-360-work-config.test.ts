import assert from 'node:assert/strict';
import { test } from 'node:test';
import { c360WorkReadiness, resolveC360WorkConfig } from './customer-360-work-config.js';

const SECRET = 'unit-test-only-secret';

test('#916 no client set = Cus360 work is off and the log states the cause and the missing env', () => {
  for (const env of [{}, { KEYCLOAK_C360_CLIENT_ID: '', KEYCLOAK_C360_CLIENT_SECRET: '' }]) {
    const config = resolveC360WorkConfig(env);
    assert.deepEqual(config, { configured: false });
    const status = c360WorkReadiness(config, true);
    assert.ok(status.status === 'DISABLED');
    assert.deepEqual(status.reasons, ['KEYCLOAK_C360_CLIENT_NOT_CONFIGURED']);
    assert.deepEqual(status.missingEnv, ['KEYCLOAK_C360_CLIENT_ID', 'KEYCLOAK_C360_CLIENT_SECRET']);
    assert.match(status.remediation, /docs\/agent-usecase-dev\.md/);
  }
});

test('#916 incompletely set = stop at start, naming the missing env and not printing a secret', () => {
  assert.throws(
    () => resolveC360WorkConfig({ KEYCLOAK_C360_CLIENT_ID: 'c360-client' }),
    /incomplete: missing KEYCLOAK_C360_CLIENT_SECRET$/,
  );
  assert.throws(
    () => resolveC360WorkConfig({ KEYCLOAK_C360_CLIENT_SECRET: SECRET }),
    (error: Error) =>
      /missing KEYCLOAK_C360_CLIENT_ID$/.test(error.message) && !error.message.includes(SECRET),
  );
});

test('#916 fully set and the write runtime ready = ENABLED with a diagnostic that has only the client id', () => {
  const config = resolveC360WorkConfig({
    KEYCLOAK_C360_CLIENT_ID: 'c360-client',
    KEYCLOAK_C360_CLIENT_SECRET: SECRET,
  });
  assert.deepEqual(config, { configured: true, clientId: 'c360-client', clientSecret: SECRET });
  const status = c360WorkReadiness(config, true);
  assert.deepEqual(status, {
    event: 'customer_360.work.readiness',
    status: 'ENABLED',
    clientId: 'c360-client',
  });
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

test('#916 the write runtime not ready = DISABLED even when the client is set, and no secret is printed', () => {
  const configured = resolveC360WorkConfig({
    KEYCLOAK_C360_CLIENT_ID: 'c360-client',
    KEYCLOAK_C360_CLIENT_SECRET: SECRET,
  });
  const status = c360WorkReadiness(configured, false);
  assert.ok(status.status === 'DISABLED');
  assert.deepEqual(status.reasons, ['C360_WRITE_RUNTIME_NOT_READY']);
  assert.deepEqual(status.missingEnv, []);
  assert.ok(!JSON.stringify(status).includes(SECRET));

  const both = c360WorkReadiness({ configured: false }, false);
  assert.ok(both.status === 'DISABLED');
  assert.deepEqual(both.reasons, [
    'KEYCLOAK_C360_CLIENT_NOT_CONFIGURED',
    'C360_WRITE_RUNTIME_NOT_READY',
  ]);
});
