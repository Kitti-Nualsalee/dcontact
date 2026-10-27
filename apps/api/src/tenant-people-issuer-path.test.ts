import assert from 'node:assert/strict';
import test from 'node:test';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import { TenantPeopleDisableKeycloak } from './tenant-people-disable-keycloak.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const configuration = {
  tenantId,
  clientId: `dcontact-tenant-people-${tenantId}`,
  clientSecret: 'synthetic-service-secret',
};

for (const prefix of ['', '/auth']) {
  test(`People readiness รักษา canonical ${prefix}/realms prefix`, async () => {
    const paths: string[] = [];
    const identity = new TenantPeopleKeycloak(
      { ...configuration, issuer: `https://identity.example.test${prefix}/realms/dcontact` },
      async (input, options) => {
        const endpoint = new URL(String(input));
        paths.push(endpoint.pathname);
        assert.equal(options?.redirect, 'error');
        return endpoint.pathname.endsWith('/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : Response.json({ version: 1, tenantId, ready: true });
      },
    );
    assert.equal(await identity.isReady(), true);
    assert.deepEqual(paths, [
      `${prefix}/realms/dcontact/protocol/openid-connect/token`,
      `${prefix}/realms/dcontact/dc-tenant-people/readiness`,
    ]);
    assert.doesNotThrow(
      () =>
        new TenantPeopleDisableKeycloak({
          ...configuration,
          issuer: `https://identity.example.test${prefix}/realms/dcontact/`,
        }),
    );
  });
  test(`People disable รักษา canonical ${prefix}/realms prefix และ trailing slash`, async () => {
    const paths: string[] = [];
    const adapter = new TenantPeopleDisableKeycloak(
      { ...configuration, issuer: `https://identity.example.test${prefix}/realms/dcontact/` },
      async (input) => {
        const endpoint = new URL(String(input));
        paths.push(endpoint.pathname);
        return endpoint.pathname.endsWith('/token')
          ? Response.json({ access_token: 'synthetic-token' })
          : new Response(null, { status: 503 });
      },
    );
    assert.deepEqual(
      await adapter.probe({
        tenantId,
        operationId: '10000000-0000-4000-8000-000000000002',
        userId: '10000000-0000-4000-8000-000000000003',
        identityId: '10000000-0000-4000-8000-000000000004',
        payloadDigest: 'a'.repeat(64),
        fencingToken: '1',
        role: 'AGENT',
        adminCandidates: [],
        reconcileOnly: false,
      }),
      { outcome: 'UNKNOWN' },
    );
    assert.deepEqual(paths, [
      `${prefix}/realms/dcontact/protocol/openid-connect/token`,
      `${prefix}/realms/dcontact/dc-tenant-people/disable/check`,
    ]);
  });
}

test('issuer path ไม่รับ arbitrary prefix, extra path หรือ credentials/query/hash', () => {
  for (const issuer of [
    'https://identity.example.test/other/realms/dcontact',
    'https://identity.example.test/auth/auth/realms/dcontact',
    'https://identity.example.test/auth/realms/dcontact/extra',
    'https://identity.example.test/auth/realms/',
    'https://identity.example.test/auth/realms/dcontact?query=1',
    'https://identity.example.test/auth/realms/dcontact#fragment',
    'https://user:password@identity.example.test/auth/realms/dcontact',
    'http://identity.example.test/auth/realms/dcontact',
  ]) {
    assert.throws(() => new TenantPeopleKeycloak({ ...configuration, issuer }), /CONFIGURATION/);
    assert.throws(
      () => new TenantPeopleDisableKeycloak({ ...configuration, issuer }),
      /CONFIGURATION/,
    );
  }
});
