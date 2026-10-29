import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  TenantPeopleDisableKeycloak,
  type PeopleDisableAttempt,
} from './tenant-people-disable-keycloak.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_BOUNDARY_CONFIGURATION:${name}`);
  return value;
}

test('real Keycloak disable adapter อ่าน exact receipt หลัง commit และไม่ resend ระหว่าง reconcile', async () => {
  const tenantId = required('B2_KEYCLOAK_TENANT_ID');
  let mutations = 0;
  const request: typeof fetch = (input, options) => {
    if (String(input).includes('/dc-tenant-people/disable/') && options?.method === 'POST')
      mutations++;
    return fetch(input, options);
  };
  const adapter = new TenantPeopleDisableKeycloak(
    {
      issuer: required('B2_KEYCLOAK_ISSUER'),
      tenantId,
      clientId: required('B2_KEYCLOAK_CLIENT_ID'),
      clientSecret: required('B2_KEYCLOAK_CLIENT_SECRET'),
    },
    request,
  );
  const attempt: PeopleDisableAttempt = {
    tenantId,
    operationId: required('B6_DISABLE_OPERATION_ID'),
    userId: required('B6_DISABLE_USER_ID'),
    identityId: required('B6_DISABLE_USER_ID'),
    payloadDigest: required('B6_DISABLE_PAYLOAD_DIGEST'),
    fencingToken: '1',
    role: 'AGENT',
    adminCandidates: [],
    reconcileOnly: true,
  };
  assert.deepEqual(await adapter.readOutcome(attempt), {
    outcome: 'SUCCEEDED',
    reasonCode: 'DISABLED',
    receiptRef: required('B6_DISABLE_RECEIPT_REF'),
    identityId: attempt.identityId,
  });
  assert.deepEqual(await adapter.readOutcome({ ...attempt, payloadDigest: '0'.repeat(64) }), {
    outcome: 'UNKNOWN',
  });
  assert.deepEqual(await adapter.readOutcome({ ...attempt, operationId: randomUUID() }), {
    outcome: 'UNKNOWN',
  });
  assert.throws(() => adapter.disable(attempt), /RECONCILIATION_REQUIRES_READ/);
  assert.equal(mutations, 0);
});
