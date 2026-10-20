import assert from 'node:assert/strict';
import test from 'node:test';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import type { PeopleWorkerClaim } from './tenant-people-worker.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const claim: PeopleWorkerClaim = {
  tenantId,
  operationId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  payloadDigest: 'a'.repeat(64),
  fencingToken: '1',
  owner: 'test-worker',
  step: 'CREATE_IDENTITY',
  reconcileOnly: false,
  command: {
    commandId: '00000000-0000-4000-8000-000000000005',
    displayName: 'Synthetic person',
    email: 'synthetic@example.test',
    username: 'synthetic@example.test',
    role: 'ADMIN',
    teamId: '00000000-0000-4000-8000-000000000006',
    extension: null,
  },
};
const configuration = {
  issuer: 'https://identity.example.test/realms/test',
  tenantId,
  clientId: `dcontact-tenant-people-${tenantId}`,
  clientSecret: 'synthetic-secret',
};

test('unknown readback never retries a mutation', async () => {
  const methods: string[] = [];
  const request: typeof fetch = async (_input, options) => {
    methods.push(options?.method ?? 'GET');
    return Response.json(
      methods.length === 1 ? { access_token: 'synthetic-token' } : { outcome: 'UNKNOWN' },
    );
  };
  const adapter = new TenantPeopleKeycloak(configuration, request);
  assert.deepEqual(await adapter.readOutcome({ ...claim, reconcileOnly: true }), {
    outcome: 'UNKNOWN',
  });
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.throws(() => adapter.mutateStep({ ...claim, reconcileOnly: true }), /RECONCILIATION/);
});

test('scope and unsupported steps fail before network access', async () => {
  const adapter = new TenantPeopleKeycloak(configuration, async () => {
    assert.fail('unexpected network access');
  });
  await assert.rejects(adapter.mutateStep({ ...claim, tenantId: 'foreign' }), /SCOPE/);
  await assert.rejects(adapter.mutateStep({ ...claim, step: 'INVITATION_INTENT' }), /SCOPE/);
});

test('receipt must identify the intended user and mutation runs only once', async () => {
  let calls = 0;
  const adapter = new TenantPeopleKeycloak(configuration, async (_input, options) => {
    calls++;
    assert.equal(options?.redirect, 'error');
    if (calls === 1) return Response.json({ access_token: 'synthetic-token' });
    assert.equal(options?.method, 'POST');
    return Response.json({
      outcome: 'SUCCEEDED',
      receiptRef: 'b'.repeat(64),
      identityId: 'foreign',
    });
  });
  assert.deepEqual(await adapter.mutateStep(claim), {
    outcome: 'UNKNOWN',
    reasonCode: 'IDENTITY_MAPPING_CONFLICT',
  });
  assert.equal(calls, 2);
});

for (const code of ['CORRELATION_CONFLICT', 'IDENTITY_MAPPING_CONFLICT'] as const)
  test(`${code} is explicit and never retried as a mutation`, async () => {
    const methods: string[] = [];
    const adapter = new TenantPeopleKeycloak(configuration, async (_input, options) => {
      methods.push(options?.method ?? 'GET');
      if (String(_input).endsWith('/token'))
        return Response.json({ access_token: 'synthetic-token' });
      return Response.json({ code }, { status: 409 });
    });
    assert.deepEqual(await adapter.readOutcome({ ...claim, reconcileOnly: true }), {
      outcome: 'UNKNOWN',
      reasonCode: code,
    });
    assert.deepEqual(methods, ['POST', 'GET']);
  });

test('plaintext non-loopback issuer is rejected', () => {
  assert.throws(
    () =>
      new TenantPeopleKeycloak({
        ...configuration,
        issuer: 'http://identity.example.test/realms/test',
      }),
    /CONFIGURATION/,
  );
});

test('identity readiness requires the exact tenant/version and never calls a mutation endpoint', async () => {
  for (const result of [
    { ready: true, version: 1, tenantId },
    { ready: true, version: 1, tenantId: 'foreign' },
    { ready: true, version: 2, tenantId },
    { ready: false, version: 1, tenantId },
  ]) {
    const adapter = new TenantPeopleKeycloak(configuration, async (input, options) => {
      if (String(input).endsWith('/token'))
        return Response.json({ access_token: 'synthetic-token' });
      const endpoint = new URL(String(input));
      assert.equal(endpoint.pathname, '/realms/test/dc-tenant-people/readiness');
      assert.equal(endpoint.searchParams.get('tenantId'), tenantId);
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      return Response.json(result);
    });
    assert.equal(
      await adapter.isReady(),
      result.ready && result.version === 1 && result.tenantId === tenantId,
    );
  }
});

test('identity readiness fails closed on service authentication and transport failure', async () => {
  assert.equal(
    await new TenantPeopleKeycloak(
      configuration,
      async () => new Response(null, { status: 401 }),
    ).isReady(),
    false,
  );
  assert.equal(
    await new TenantPeopleKeycloak(configuration, async () => {
      throw new Error('synthetic transport failure');
    }).isReady(),
    false,
  );
});

test('readiness for a different tenant fails before obtaining a service token', async () => {
  let requests = 0;
  const adapter = new TenantPeopleKeycloak(configuration, async () => {
    requests++;
    return new Response(null, { status: 401 });
  });
  assert.equal(await adapter.isReady('foreign'), false);
  assert.equal(requests, 0);
});

test('tenant role uses the correlated step endpoint', async () => {
  const adapter = new TenantPeopleKeycloak(configuration, async (input) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    assert.ok(String(input).endsWith('/steps/TENANT_ROLE'));
    return Response.json({
      outcome: 'SUCCEEDED',
      receiptRef: 'c'.repeat(64),
      identityId: claim.userId,
    });
  });
  assert.deepEqual(await adapter.mutateStep({ ...claim, step: 'TENANT_ROLE' }), {
    outcome: 'SUCCEEDED',
    receiptRef: 'c'.repeat(64),
  });
});
