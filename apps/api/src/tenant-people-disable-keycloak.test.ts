import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  TenantPeopleDisableKeycloak,
  type PeopleDisableAttempt,
} from './tenant-people-disable-keycloak.js';

function fixture() {
  const tenantId = randomUUID();
  const attempt: PeopleDisableAttempt = {
    tenantId,
    operationId: randomUUID(),
    userId: randomUUID(),
    identityId: randomUUID(),
    payloadDigest: 'a'.repeat(64),
    fencingToken: '1',
    role: 'ADMIN',
    adminCandidates: [{ userId: randomUUID(), identityId: randomUUID() }],
    reconcileOnly: false,
  };
  const configuration = {
    issuer: 'https://identity.example.test/realms/dcontact',
    tenantId,
    clientId: `dcontact-tenant-people-${tenantId}`,
    clientSecret: 'synthetic-service-secret',
  };
  const proof = {
    version: 1,
    outcome: 'SUCCEEDED',
    receiptRef: 'b'.repeat(64),
    reasonCode: 'DISABLED',
    tenantId,
    operationId: attempt.operationId,
    userId: attempt.userId,
    payloadDigest: attempt.payloadDigest,
    identityId: attempt.identityId,
  };
  return { attempt, configuration, proof };
}

test('disable sends a frozen descriptor and returns only the exactly correlated receipt', async () => {
  const { attempt, configuration, proof } = fixture();
  const bodies: unknown[] = [];
  const request: typeof fetch = async (input, options) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json(proof);
  };
  const adapter = new TenantPeopleDisableKeycloak(configuration, request);
  assert.deepEqual(await adapter.disable(attempt), {
    outcome: 'SUCCEEDED',
    receiptRef: proof.receiptRef,
    reasonCode: 'DISABLED',
    identityId: attempt.identityId,
  });
  assert.deepEqual(bodies, [
    {
      tenantId: attempt.tenantId,
      targetUserId: attempt.userId,
      payloadDigest: attempt.payloadDigest,
      identityId: attempt.identityId,
      fencingToken: '1',
      role: 'ADMIN',
      adminCandidates: `${attempt.adminCandidates[0].userId}:${attempt.adminCandidates[0].identityId}`,
    },
  ]);
});

test('a lost response is UNKNOWN and reconcile reads GET without POSTing again', async () => {
  const { attempt, configuration, proof } = fixture();
  let mutations = 0;
  const request: typeof fetch = async (input, options) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    if (options?.method === 'POST') {
      mutations++;
      throw new Error('response lost after commit');
    }
    const endpoint = new URL(String(input));
    assert.equal(endpoint.searchParams.get('payloadDigest'), attempt.payloadDigest);
    return Response.json(proof);
  };
  const adapter = new TenantPeopleDisableKeycloak(configuration, request);
  assert.deepEqual(await adapter.disable(attempt), { outcome: 'UNKNOWN' });
  assert.throws(
    () => adapter.disable({ ...attempt, reconcileOnly: true }),
    /RECONCILIATION_REQUIRES_READ/,
  );
  assert.equal(
    (await adapter.readOutcome({ ...attempt, reconcileOnly: true })).outcome,
    'SUCCEEDED',
  );
  assert.equal(mutations, 1);
});

test('a proof with a wrong digest/tenant/shape/reason is not evidence of success or compensation', async () => {
  const { attempt, configuration, proof } = fixture();
  for (const invalid of [
    { ...proof, payloadDigest: '0'.repeat(64) },
    { ...proof, tenantId: randomUUID() },
    { ...proof, extra: true },
    { ...proof, version: 2 },
    { ...proof, identityId: randomUUID() },
    { ...proof, outcome: 'REJECTED_NO_EFFECT', reasonCode: 'TIMEOUT' },
    { ...proof, receiptRef: 'invalid' },
  ]) {
    const request: typeof fetch = async (input) =>
      String(input).endsWith('/token')
        ? Response.json({ access_token: 'synthetic-token' })
        : Response.json(invalid);
    assert.deepEqual(
      await new TenantPeopleDisableKeycloak(configuration, request).readOutcome(attempt),
      { outcome: 'UNKNOWN' },
    );
  }
});

test('a durable REJECTED_NO_EFFECT must bind only to the original operation/digest', async () => {
  const { attempt, configuration, proof } = fixture();
  const request: typeof fetch = async (input) =>
    String(input).endsWith('/token')
      ? Response.json({ access_token: 'synthetic-token' })
      : Response.json({ ...proof, outcome: 'REJECTED_NO_EFFECT', reasonCode: 'LAST_USABLE_ADMIN' });
  assert.deepEqual(
    await new TenantPeopleDisableKeycloak(configuration, request).readOutcome(attempt),
    {
      outcome: 'REJECTED_NO_EFFECT',
      reasonCode: 'LAST_USABLE_ADMIN',
      receiptRef: proof.receiptRef,
      identityId: attempt.identityId,
    },
  );
});

test('a malformed tenant or candidate is rejected before the network', async () => {
  const { attempt, configuration } = fixture();
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    throw new Error('unexpected network');
  };
  const adapter = new TenantPeopleDisableKeycloak(configuration, request);
  await assert.rejects(
    adapter.readOutcome({ ...attempt, tenantId: randomUUID() }),
    /SCOPE_MISMATCH/,
  );
  await assert.rejects(
    adapter.readOutcome({
      ...attempt,
      adminCandidates: [attempt.adminCandidates[0], attempt.adminCandidates[0]],
    }),
    /SCOPE_MISMATCH/,
  );
  assert.equal(requests, 0);
  assert.throws(
    () =>
      new TenantPeopleDisableKeycloak({
        ...configuration,
        issuer: 'http://192.168.1.1/realms/dcontact',
      }),
    /INVALID_PEOPLE_DISABLE_CONFIGURATION/,
  );
});

test('preflight uses check and accepts only a fresh proof that matches the descriptor', async () => {
  const { attempt, configuration } = fixture();
  const proof = {
    version: 1,
    outcome: 'READY',
    reasonCode: 'READY',
    tenantId: attempt.tenantId,
    userId: attempt.userId,
    identityId: attempt.identityId,
    payloadDigest: attempt.payloadDigest,
  };
  for (const [response, expected] of [
    [proof, { outcome: 'READY' }],
    [
      { ...proof, outcome: 'REJECTED', reasonCode: 'LAST_USABLE_ADMIN' },
      { outcome: 'REJECTED', reasonCode: 'LAST_USABLE_ADMIN' },
    ],
    [{ ...proof, tenantId: randomUUID() }, { outcome: 'UNKNOWN' }],
    [{ ...proof, payloadDigest: '0'.repeat(64) }, { outcome: 'UNKNOWN' }],
    [{ ...proof, receiptRef: 'b'.repeat(64) }, { outcome: 'UNKNOWN' }],
    [{ ...proof, outcome: 'SUCCEEDED', reasonCode: 'DISABLED' }, { outcome: 'UNKNOWN' }],
  ]) {
    const request: typeof fetch = async (input, options) => {
      if (String(input).endsWith('/token'))
        return Response.json({ access_token: 'synthetic-token' });
      assert.equal(new URL(String(input)).pathname.endsWith('/disable/check'), true);
      assert.equal(options?.method, 'POST');
      return Response.json(response);
    };
    assert.deepEqual(
      await new TenantPeopleDisableKeycloak(configuration, request).probe(attempt),
      expected,
    );
  }
});
