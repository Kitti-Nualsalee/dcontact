import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import type { PeopleWorkerClaim } from './tenant-people-worker.js';
import type { PeopleInvitationAttempt } from './tenant-people-invitation-worker.js';

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
    { outcome: 'UNKNOWN', reasonCode: 'CORRELATION_CONFLICT' },
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
  const invitation = adapter.invitationPort();
  const firstAttempt: PeopleInvitationAttempt = {
    tenantId,
    operationId: claim.operationId,
    userId: claim.userId,
    generation: 1,
    providerAttemptRef: randomUUID(),
    payloadDigest: claim.payloadDigest,
    fencingToken: '1',
    leaseOwner: 'adapter-generation-one',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    command: claim.command,
  };
  async function readSent(attempt: PeopleInvitationAttempt) {
    for (let retry = 0; retry < 40; retry++) {
      const outcome = await invitation.readOutcome(attempt);
      if (outcome.outcome === 'SENT') return outcome;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('ต้องได้ exact SENT receipt ของ generation ที่ร้องขอ');
  }
  await invitation.dispatch(firstAttempt);
  const firstSent = await readSent(firstAttempt);
  const secondAttempt = {
    ...firstAttempt,
    generation: 2,
    providerAttemptRef: randomUUID(),
    fencingToken: '2',
    leaseOwner: 'adapter-generation-two',
  };
  const issuer = required('B2_KEYCLOAK_ISSUER');
  const tokenResponse = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: required('B2_KEYCLOAK_CLIENT_ID'),
      client_secret: required('B2_KEYCLOAK_CLIENT_SECRET'),
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(tokenResponse.status, 200);
  const token: unknown = await tokenResponse.json();
  assert.ok(
    token &&
      typeof token === 'object' &&
      'access_token' in token &&
      typeof token.access_token === 'string',
  );
  const headers = {
    authorization: `Bearer ${token.access_token}`,
    'content-type': 'application/json',
  };
  const correlation = {
    tenantId,
    targetUserId: secondAttempt.userId,
    payloadDigest: secondAttempt.payloadDigest,
    providerAttemptRef: secondAttempt.providerAttemptRef,
    fencingToken: secondAttempt.fencingToken,
    leaseOwner: secondAttempt.leaseOwner,
  };
  const descriptor = {
    ...correlation,
    email: claim.command.email,
    displayName: claim.command.displayName,
    role: claim.command.role,
  };
  const endpoint = `${issuer}/dc-tenant-people/operations/${claim.operationId}/invitations/2`;
  const prepared = await fetch(`${endpoint}/intent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(descriptor),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(prepared.status, 200);
  let reached = false;
  for (let retry = 0; retry < 40; retry++) {
    const readback = await fetch(`${endpoint}/intent?${new URLSearchParams(correlation)}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(readback.status, 200);
    const proof: unknown = await readback.json();
    assert.ok(
      proof &&
        typeof proof === 'object' &&
        'serverEpoch' in proof &&
        typeof proof.serverEpoch === 'number' &&
        'notBeforeEpoch' in proof &&
        typeof proof.notBeforeEpoch === 'number',
    );
    if (proof.serverEpoch >= proof.notBeforeEpoch) {
      reached = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(reached, true);
  const sent = await fetch(`${endpoint}/dispatch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(descriptor),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(sent.status, 200);
  const secondSent = await readSent(secondAttempt);
  assert.equal(secondSent.generation, 2);
  assert.equal(secondSent.providerAttemptRef, secondAttempt.providerAttemptRef);
  assert.ok(
    secondSent.notBeforeEpoch !== null &&
      firstSent.issuedAtEpoch !== null &&
      secondSent.notBeforeEpoch > firstSent.issuedAtEpoch,
  );
  assert.deepEqual(await invitation.readOutcome(firstAttempt), firstSent);
  await assert.rejects(invitation.dispatch(secondAttempt), /GENERATION_NOT_READY/);
});
