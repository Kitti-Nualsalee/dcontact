import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  TenantPeopleAccountKeycloak,
  type PeopleAccountAttempt,
} from './tenant-people-account-keycloak.js';

function fixture(step: PeopleAccountAttempt['step'] = 'UPDATE_PROFILE') {
  const tenantId = randomUUID();
  const attempt: PeopleAccountAttempt = {
    step,
    tenantId,
    operationId: randomUUID(),
    userId: randomUUID(),
    identityId: randomUUID(),
    payloadDigest: 'a'.repeat(64),
    fencingToken: '2',
    role: 'AGENT',
    displayName: step === 'UPDATE_PROFILE' ? 'สมชาย ใจดี' : null,
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
    reasonCode: step === 'UPDATE_PROFILE' ? 'PROFILE_UPDATED' : 'ENABLED',
    tenantId,
    operationId: attempt.operationId,
    userId: attempt.userId,
    payloadDigest: attempt.payloadDigest,
    identityId: attempt.identityId,
  };
  return { attempt, configuration, proof };
}

test('UPDATE_PROFILE ส่ง descriptor ที่ frozen และรับเฉพาะ receipt ที่ correlate ตรง', async () => {
  const { attempt, configuration, proof } = fixture();
  const calls: { url: string; body: unknown }[] = [];
  const request: typeof fetch = async (input, options) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    calls.push({ url: String(input), body: JSON.parse(String(options?.body)) });
    return Response.json(proof);
  };
  const adapter = new TenantPeopleAccountKeycloak(configuration, request);
  assert.deepEqual(await adapter.mutate(attempt), {
    outcome: 'SUCCEEDED',
    receiptRef: proof.receiptRef,
    reasonCode: 'PROFILE_UPDATED',
    identityId: attempt.identityId,
  });
  assert.equal(
    calls[0]!.url,
    `${configuration.issuer}/dc-tenant-people/account/UPDATE_PROFILE/${attempt.operationId}`,
  );
  assert.deepEqual(calls[0]!.body, {
    tenantId: attempt.tenantId,
    targetUserId: attempt.userId,
    identityId: attempt.identityId,
    payloadDigest: attempt.payloadDigest,
    role: 'AGENT',
    displayName: 'สมชาย ใจดี',
    fencingToken: '2',
  });
});

test('ENABLE_ACCOUNT ไม่ส่ง displayName และ reconcile อ่าน GET อย่างเดียว', async () => {
  const { attempt, configuration, proof } = fixture('ENABLE_ACCOUNT');
  let mutations = 0;
  const urls: string[] = [];
  const request: typeof fetch = async (input, options) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    urls.push(String(input));
    if (options?.method === 'POST') {
      mutations++;
      assert.equal('displayName' in JSON.parse(String(options.body)), false);
      throw new Error('response lost after commit');
    }
    return Response.json(proof);
  };
  const adapter = new TenantPeopleAccountKeycloak(configuration, request);
  assert.deepEqual(await adapter.mutate(attempt), { outcome: 'UNKNOWN' });
  assert.equal(
    (await adapter.readOutcome({ ...attempt, reconcileOnly: true })).outcome,
    'SUCCEEDED',
  );
  assert.equal(mutations, 1);
  const read = new URL(urls[1]!);
  assert.equal(read.searchParams.get('identityId'), attempt.identityId);
  assert.equal(read.searchParams.get('role'), 'AGENT');
  assert.equal(read.searchParams.has('displayName'), false);
  assert.throws(() => adapter.mutate({ ...attempt, reconcileOnly: true }), /REQUIRES_READ/);
});

test('คำตอบที่ไม่ตรงสัญญาเป๊ะเป็น UNKNOWN ไม่ใช่ความสำเร็จ', async () => {
  const { attempt, configuration, proof } = fixture();
  for (const variant of [
    { ...proof, extra: true },
    { ...proof, identityId: randomUUID() },
    { ...proof, operationId: randomUUID() },
    { ...proof, reasonCode: 'ENABLED' },
    { ...proof, receiptRef: 'short' },
    { ...proof, outcome: 'REJECTED_NO_EFFECT', reasonCode: 'CREDENTIALS_NOT_READY' },
  ]) {
    const request: typeof fetch = async (input) =>
      String(input).endsWith('/token')
        ? Response.json({ access_token: 'synthetic-token' })
        : Response.json(variant);
    const adapter = new TenantPeopleAccountKeycloak(configuration, request);
    assert.deepEqual(
      await adapter.mutate(attempt),
      { outcome: 'UNKNOWN' },
      JSON.stringify(variant),
    );
  }
});

test('probe แยก READY/REJECTED และปฏิเสธ scope ที่ไม่ตรงก่อนเรียก network', async () => {
  const { attempt, configuration } = fixture('ENABLE_ACCOUNT');
  let calls = 0;
  const request: typeof fetch = async (input) => {
    calls++;
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
    assert.match(String(input), /\/account\/ENABLE_ACCOUNT\/check$/);
    return Response.json({
      version: 1,
      outcome: 'REJECTED',
      reasonCode: 'CREDENTIALS_NOT_READY',
      tenantId: attempt.tenantId,
      userId: attempt.userId,
      identityId: attempt.identityId,
      payloadDigest: attempt.payloadDigest,
    });
  };
  const adapter = new TenantPeopleAccountKeycloak(configuration, request);
  assert.deepEqual(await adapter.probe(attempt), {
    outcome: 'REJECTED',
    reasonCode: 'CREDENTIALS_NOT_READY',
  });
  calls = 0;
  await assert.rejects(adapter.probe({ ...attempt, tenantId: randomUUID() }), /SCOPE_MISMATCH/);
  await assert.rejects(adapter.probe({ ...attempt, displayName: 'x' }), /SCOPE_MISMATCH/);
  await assert.rejects(
    adapter.probe({ ...attempt, step: 'UPDATE_PROFILE', displayName: ' มีช่องว่าง' }),
    /SCOPE_MISMATCH/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => new TenantPeopleAccountKeycloak({ ...configuration, clientId: 'dcontact-console' }),
    /INVALID_PEOPLE_ACCOUNT_CONFIGURATION/,
  );
});
