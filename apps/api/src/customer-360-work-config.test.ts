import assert from 'node:assert/strict';
import { test } from 'node:test';
import { c360WorkReadiness, resolveC360WorkConfig } from './customer-360-work-config.js';

const SECRET = 'unit-test-only-secret';

test('#916 ไม่ตั้ง client = ปิด Cus360 work และ log บอกสาเหตุกับ env ที่ขาด', () => {
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

test('#916 ตั้งไม่ครบ = หยุดตั้งแต่เริ่ม โดยระบุชื่อ env ที่ขาดและไม่พิมพ์ secret', () => {
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

test('#916 ตั้งครบและ write runtime พร้อม = ENABLED โดย diagnostic มีแค่ client id', () => {
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

test('#916 write runtime ไม่พร้อม = DISABLED แม้ตั้ง client แล้ว และไม่พิมพ์ secret', () => {
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
