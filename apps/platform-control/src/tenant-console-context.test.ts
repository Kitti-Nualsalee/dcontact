import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantConsoleContext, tenantConsoleContextFromEnv } from './tenant-console-context.js';

test('รับ issuer ของ realm และ client ของ tenant Console', () => {
  assert.deepEqual(
    tenantConsoleContextFromEnv({
      PLATFORM_TENANT_CONSOLE_ISSUER: 'https://dcontact-uat.osd.co.th/auth/realms/dcontact',
      PLATFORM_TENANT_CONSOLE_CLIENT_ID: 'dcontact-uat-console',
      PLATFORM_TENANT_CONSOLE_ORIGIN: 'https://dcontact-uat.osd.co.th',
    }),
    {
      issuer: 'https://dcontact-uat.osd.co.th/auth/realms/dcontact',
      clientId: 'dcontact-uat-console',
      origin: 'https://dcontact-uat.osd.co.th',
    },
  );
  assert.equal(
    tenantConsoleContext(
      'http://localhost:8081/realms/dcontact',
      'console',
      'http://localhost:5173',
    ).clientId,
    'console',
  );
});

test('ไม่ตั้งค่าหรือค่าผิดรูปแบบ = worker ไม่ start', () => {
  assert.throws(() => tenantConsoleContextFromEnv({}), /PLATFORM_TENANT_CONSOLE_ISSUER/);
  assert.throws(
    () => tenantConsoleContext('https://dcontact-uat.osd.co.th/auth', 'console', 'https://h'),
    /PLATFORM_TENANT_CONSOLE_ISSUER/,
  );
  assert.throws(
    () => tenantConsoleContext('https://host/realms/dcontact', 'console client', 'https://h'),
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
      () => tenantConsoleContext('https://host/realms/dcontact', client, 'https://h'),
      /PLATFORM_TENANT_CONSOLE_CLIENT_ID/,
    );
  }
});

test('origin ต้องไม่มี path หรือ query', () => {
  for (const origin of ['https://host/', 'https://host/console', 'https://host?x=1', 'host']) {
    assert.throws(
      () => tenantConsoleContext('https://host/realms/dcontact', 'console', origin),
      /PLATFORM_TENANT_CONSOLE_ORIGIN/,
    );
  }
});
