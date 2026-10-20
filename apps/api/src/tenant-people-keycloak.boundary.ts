import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import type { PeopleWorkerClaim } from './tenant-people-worker.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_BOUNDARY_CONFIGURATION:${name}`);
  return value;
}

test('real Keycloak service client creates once and reads the immutable outcome', async () => {
  const tenantId = required('B2_KEYCLOAK_TENANT_ID');
  const adapter = new TenantPeopleKeycloak({
    issuer: required('B2_KEYCLOAK_ISSUER'),
    tenantId,
    clientId: required('B2_KEYCLOAK_CLIENT_ID'),
    clientSecret: required('B2_KEYCLOAK_CLIENT_SECRET'),
  });
  const email = `${randomUUID()}@example.test`;
  assert.equal(await adapter.isReady(), true);
  const claim: PeopleWorkerClaim = {
    tenantId,
    operationId: randomUUID(),
    userId: randomUUID(),
    correlationId: randomUUID(),
    payloadDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    fencingToken: '1',
    owner: 'boundary-worker',
    step: 'CREATE_IDENTITY',
    reconcileOnly: false,
    command: {
      commandId: randomUUID(),
      displayName: 'ทดสอบ adapter B2',
      email,
      username: email,
      role: 'AGENT',
      teamId: randomUUID(),
      extension: null,
    },
  };
  assert.deepEqual(await adapter.readOutcome({ ...claim, reconcileOnly: true }), {
    outcome: 'UNKNOWN',
  });
  const created = await adapter.mutateStep(claim);
  assert.equal(created.outcome, 'SUCCEEDED');
  assert.deepEqual(await adapter.mutateStep({ ...claim, step: 'ORG_MEMBERSHIP' }), {
    outcome: 'UNKNOWN',
  });
  assert.deepEqual(await adapter.mutateStep(claim), created);
  assert.deepEqual(await adapter.readOutcome({ ...claim, reconcileOnly: true }), created);
  const roleClaim: PeopleWorkerClaim = { ...claim, step: 'TENANT_ROLE', fencingToken: '2' };
  const granted = await adapter.mutateStep(roleClaim);
  assert.equal(granted.outcome, 'SUCCEEDED');
  assert.deepEqual(await adapter.readOutcome({ ...roleClaim, reconcileOnly: true }), granted);
  const organizationClaim: PeopleWorkerClaim = {
    ...claim,
    step: 'ORG_MEMBERSHIP',
    fencingToken: '3',
  };
  const joined = await adapter.mutateStep(organizationClaim);
  assert.equal(joined.outcome, 'SUCCEEDED');
  assert.deepEqual(await adapter.mutateStep(organizationClaim), joined);
  assert.deepEqual(
    await adapter.readOutcome({ ...organizationClaim, reconcileOnly: true }),
    joined,
  );
  assert.deepEqual(
    await adapter.readOutcome({ ...claim, payloadDigest: '0'.repeat(64), reconcileOnly: true }),
    { outcome: 'UNKNOWN' },
  );
  const mappingClaim: PeopleWorkerClaim = { ...claim, step: 'VERIFY_MAPPING', fencingToken: '4' };
  const verified = await adapter.mutateStep(mappingClaim);
  assert.ok(verified.outcome === 'SUCCEEDED' && verified.identityId === claim.userId);
  assert.deepEqual(await adapter.readOutcome({ ...mappingClaim, reconcileOnly: true }), verified);
  const terminalClaim: PeopleWorkerClaim = {
    ...claim,
    step: 'VERIFY_PROVISIONED',
    fencingToken: '5',
  };
  const provisioned = await adapter.mutateStep(terminalClaim);
  assert.ok(provisioned.outcome === 'SUCCEEDED' && provisioned.identityId === claim.userId);
  await assert.rejects(
    adapter.readOutcome({ ...claim, tenantId: randomUUID(), reconcileOnly: true }),
    /SCOPE_MISMATCH/,
  );
});
