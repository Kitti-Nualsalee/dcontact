import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantConsoleContext, tenantConsoleContextFromEnv } from './tenant-console-context.js';

test('รับ issuer ของ realm และ client ของ tenant Console', () => {
  assert.deepEqual(
    tenantConsoleContextFromEnv({
      PLATFORM_TENANT_CONSOLE_ISSUER: 'https://dcontact-uat.osd.co.th/auth/realms/dcontact',
      PLATFORM_TENANT_CONSOLE_CLIENT_ID: 'dcontact-uat-console',
    }),
    {
      issuer: 'https://dcontact-uat.osd.co.th/auth/realms/dcontact',
      clientId: 'dcontact-uat-console',
    },
  );
  assert.equal(
    tenantConsoleContext('http://localhost:8081/realms/dcontact', 'console').clientId,
    'console',
  );
});

test('ไม่ตั้งค่าหรือค่าผิดรูปแบบ = worker ไม่ start', () => {
  assert.throws(() => tenantConsoleContextFromEnv({}), /PLATFORM_TENANT_CONSOLE_ISSUER/);
  assert.throws(
    () => tenantConsoleContext('https://dcontact-uat.osd.co.th/auth', 'console'),
    /PLATFORM_TENANT_CONSOLE_ISSUER/,
  );
  assert.throws(
    () => tenantConsoleContext('https://host/realms/dcontact', 'console client'),
    /PLATFORM_TENANT_CONSOLE_CLIENT_ID/,
  );
});

test('ห้ามใช้ client ของ platform หรือ Keycloak เป็น tenant Console', () => {
  for (const client of [
    'platform-console',
    'dcontact-platform-api',
    'realm-management',
    'admin-cli',
  ]) {
    assert.throws(
      () => tenantConsoleContext('https://host/realms/dcontact', client),
      /PLATFORM_TENANT_CONSOLE_CLIENT_ID/,
    );
  }
});
