import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantConsoleContext, tenantConsoleContextFromEnv } from './tenant-console-context.js';

test('accepts the realm issuer and the tenant Console client', () => {
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

test('missing or malformed values = the worker does not start', () => {
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

test('a platform or Keycloak client must not be used as the tenant Console', () => {
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

test('origin must not have a path or query', () => {
  for (const origin of ['https://host/', 'https://host/console', 'https://host?x=1', 'host']) {
    assert.throws(
      () => tenantConsoleContext('https://host/realms/dcontact', 'console', origin),
      /PLATFORM_TENANT_CONSOLE_ORIGIN/,
    );
  }
});
