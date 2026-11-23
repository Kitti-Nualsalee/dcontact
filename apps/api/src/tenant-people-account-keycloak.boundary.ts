import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  TenantPeopleAccountKeycloak,
  type PeopleAccountAttempt,
} from './tenant-people-account-keycloak.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_BOUNDARY_CONFIGURATION:${name}`);
  return value;
}

test('#998 real Keycloak account adapter อ่าน receipt ของ UPDATE_PROFILE/ENABLE_ACCOUNT หลัง commit โดยไม่ resend', async () => {
  const tenantId = required('B2_KEYCLOAK_TENANT_ID');
  let mutations = 0;
  const request: typeof fetch = (input, options) => {
    if (
      String(input).includes('/dc-tenant-people/account/') &&
      !String(input).endsWith('/check') &&
      options?.method === 'POST'
    )
      mutations++;
    return fetch(input, options);
  };
  const adapter = new TenantPeopleAccountKeycloak(
    {
      issuer: required('B2_KEYCLOAK_ISSUER'),
      tenantId,
      clientId: required('B2_KEYCLOAK_CLIENT_ID'),
      clientSecret: required('B2_KEYCLOAK_CLIENT_SECRET'),
    },
    request,
  );
  const profile: PeopleAccountAttempt = {
    step: 'UPDATE_PROFILE',
    tenantId,
    operationId: required('P998_PROFILE_OPERATION_ID'),
    userId: required('P998_PROFILE_USER_ID'),
    identityId: required('P998_PROFILE_USER_ID'),
    payloadDigest: required('P998_PROFILE_PAYLOAD_DIGEST'),
    fencingToken: '1',
    role: 'AGENT',
    displayName: required('P998_PROFILE_DISPLAY_NAME'),
    reconcileOnly: true,
  };
  assert.deepEqual(await adapter.readOutcome(profile), {
    outcome: 'SUCCEEDED',
    reasonCode: 'PROFILE_UPDATED',
    receiptRef: required('P998_PROFILE_RECEIPT_REF'),
    identityId: profile.identityId,
  });
  // ชื่อที่ไม่ตรง descriptor เป็น correlation conflict (409) → UNKNOWN
  assert.deepEqual(await adapter.readOutcome({ ...profile, displayName: 'ชื่ออื่น' }), {
    outcome: 'UNKNOWN',
  });
  const enable: PeopleAccountAttempt = {
    step: 'ENABLE_ACCOUNT',
    tenantId,
    operationId: required('P998_ENABLE_OPERATION_ID'),
    userId: required('P998_ENABLE_USER_ID'),
    identityId: required('P998_ENABLE_USER_ID'),
    payloadDigest: required('P998_ENABLE_PAYLOAD_DIGEST'),
    fencingToken: '1',
    role: 'AGENT',
    displayName: null,
    reconcileOnly: true,
  };
  assert.deepEqual(await adapter.readOutcome(enable), {
    outcome: 'SUCCEEDED',
    reasonCode: 'ENABLED',
    receiptRef: required('P998_ENABLE_RECEIPT_REF'),
    identityId: enable.identityId,
  });
  assert.deepEqual(await adapter.readOutcome({ ...enable, payloadDigest: '0'.repeat(64) }), {
    outcome: 'UNKNOWN',
  });
  assert.deepEqual(await adapter.readOutcome({ ...enable, operationId: randomUUID() }), {
    outcome: 'UNKNOWN',
  });
  assert.throws(() => adapter.mutate(enable), /RECONCILIATION_REQUIRES_READ/);
  assert.equal((await adapter.probe({ ...enable, reconcileOnly: false })).outcome, 'REJECTED');
  assert.equal(mutations, 0);
});
