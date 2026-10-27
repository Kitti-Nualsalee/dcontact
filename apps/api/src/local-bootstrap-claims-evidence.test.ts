import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { OidcAccessTokenVerifier, VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  withLocalBootstrapClaimsEvidence,
  type LocalBootstrapClaimsEvidence,
} from './local-bootstrap-claims-evidence.js';

const expected = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  subject: '10000000-0000-4000-8000-000000000003',
  tenantSlug: 'v1b-local-synthetic',
  organizationId: '10000000-0000-4000-8000-000000000004',
  clientId: 'dcontact-uat-console',
};
const issuer = 'https://console.dcontact.test/auth/realms/dcontact';
const environment = {
  DCONTACT_API_PROFILE: 'uat-workspace',
  KEYCLOAK_ISSUER: issuer,
  UAT_HOST: 'console.dcontact.test',
  LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON: JSON.stringify(expected),
};
function actual(
  overrides: Record<string, unknown> = {},
): VerifiedOidcClaims & Record<string, unknown> {
  return {
    iss: issuer,
    sub: expected.subject,
    azp: expected.clientId,
    tenant_id: expected.tenantId,
    dc_user_id: expected.userId,
    tenant_slug: expected.tenantSlug,
    organization: { [expected.tenantSlug]: { tenant_id: [expected.tenantId] } },
    dc_identity_class: 'TENANT_USER',
    sid: 'private-session',
    exp: Math.floor(Date.now() / 1000) + 3600,
    realm_access: { roles: ['admin'] },
    preferred_username: 'private-username@example.test',
    ...overrides,
  };
}

test('ปิด diagnostic คืน verifier เดิมโดยไม่ตรวจ config หรือ emit', async () => {
  const claims = actual();
  const verifier: OidcAccessTokenVerifier = { verifyAccessToken: async () => claims };
  const wrapped = withLocalBootstrapClaimsEvidence(verifier, {}, () =>
    assert.fail('unexpected evidence'),
  );
  assert.equal(wrapped, verifier);
  assert.equal(await wrapped.verifyAccessToken('private-token'), claims);
});

test('config ผิดและ nonlocal fail closed ด้วย error คงที่ที่ไม่เผย manifest', () => {
  const verifier = { verifyAccessToken: async () => actual() };
  for (const change of [
    { DCONTACT_API_PROFILE: 'default' },
    { DCONTACT_API_PROFILE: 'uat-e1' },
    { KEYCLOAK_ISSUER: 'https://identity.example.test/realms/dcontact' },
    { UAT_HOST: 'other.example.test' },
    { LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON: '' },
    { LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON: 'private-secret-invalid-json' },
    ...[
      null,
      [],
      {},
      { ...expected, clientId: 'admin-cli' },
      { ...expected, subject: 'invalid' },
      { ...expected, tenantId: 'invalid' },
      { ...expected, userId: 'invalid' },
      { ...expected, organizationId: 'invalid' },
      { ...expected, tenantSlug: '../bad' },
      { ...expected, password: 'private-secret' },
    ].map((manifest) => ({
      LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON: JSON.stringify(manifest),
    })),
  ]) {
    assert.throws(
      () => withLocalBootstrapClaimsEvidence(verifier, { ...environment, ...change }, () => {}),
      { message: 'LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_CONFIGURATION_INVALID' },
    );
  }
});

test('emit หลัง underlying verify ผ่านเท่านั้น และคืน claims object เดิม', async () => {
  const claims = actual({
    otp: 'private-otp',
    password: 'private-password',
    arbitrary: 'private-claim',
  });
  const evidence: LocalBootstrapClaimsEvidence[] = [];
  let verified = false;
  const wrapped = withLocalBootstrapClaimsEvidence(
    {
      async verifyAccessToken(token) {
        assert.equal(token, 'private-jwt');
        verified = true;
        return claims;
      },
    },
    environment,
    (value) => {
      assert.equal(verified, true);
      evidence.push(value);
    },
  );
  assert.equal(await wrapped.verifyAccessToken('private-jwt'), claims);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].matched, true);
  assert.equal(evidence[0].organizationIdSource, 'OPERATOR_MANIFEST_ONLY');
  assert.match(evidence[0].actualClaimTupleDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence[0].expectedManifestDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence[0].evidenceId, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(evidence[0].observedAt).toISOString(), evidence[0].observedAt);
  const serialized = JSON.stringify(evidence);
  for (const secret of ['private-', ...Object.values(expected), issuer])
    assert.ok(!serialized.includes(secret));
  assert.deepEqual(
    Object.keys(evidence[0]).sort(),
    [
      'event',
      'version',
      'evidenceId',
      'observedAt',
      'actualClaimTupleDigest',
      'expectedManifestDigest',
      'organizationIdSource',
      'issuerMatch',
      'clientMatch',
      'tenantMatch',
      'userMatch',
      'subjectMatch',
      'organizationContextMatch',
      'classificationPresent',
      'classificationAllowed',
      'workspaceIdentityValid',
      'callerMatch',
      'matched',
    ].sort(),
  );
});

test('mismatch/service/platform claims ไม่ matched และไม่เปลี่ยนผล underlying authentication', async () => {
  for (const override of [
    { iss: 'https://other.example.test/realms/dcontact' },
    { azp: 'other-console' },
    { tenant_id: expected.userId },
    { tenant_slug: 'other' },
    { dc_user_id: expected.tenantId },
    { sub: expected.userId },
    { sid: undefined },
    { organization: undefined },
    { organization: { [expected.tenantSlug]: { tenant_id: [expected.userId] } } },
    {
      organization: { [expected.tenantSlug]: { tenant_id: [expected.tenantId, expected.userId] } },
    },
    { organization: { [expected.tenantSlug]: { tenant_id: [expected.tenantId] }, foreign: {} } },
    { dc_identity_class: 'PLATFORM_OPERATOR' },
    { dc_identity_class: null },
    { serviceAccountClientId: 'service' },
    { preferred_username: 'service-account-client' },
    { resource_access: { 'realm-management': {} } },
    { resource_access: { 'dcontact-platform-api': {} } },
    { realm_access: { roles: ['platform_operator'] } },
    { realm_access: { roles: ['realm-admin'] } },
    { realm_access: { roles: ['create-realm'] } },
  ]) {
    const claims = actual(override);
    const evidence: LocalBootstrapClaimsEvidence[] = [];
    const wrapped = withLocalBootstrapClaimsEvidence(
      { verifyAccessToken: async () => claims },
      environment,
      (value) => {
        evidence.push(value);
      },
    );
    assert.equal(await wrapped.verifyAccessToken('token'), claims);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].matched, false, JSON.stringify(override));
  }
});

test('classification ที่ไม่มีคง semantics caller guard เดิมและไม่อ้างว่า observed classification', async () => {
  const evidence: LocalBootstrapClaimsEvidence[] = [];
  const wrapped = withLocalBootstrapClaimsEvidence(
    { verifyAccessToken: async () => actual({ dc_identity_class: undefined }) },
    environment,
    (value) => {
      evidence.push(value);
    },
  );
  await wrapped.verifyAccessToken('token');
  assert.equal(evidence[0].classificationPresent, false);
  assert.equal(evidence[0].classificationAllowed, true);
  assert.equal(evidence[0].matched, true);
});

test('underlying verification/admission reject คง error เดิมและไม่ emit', async () => {
  for (const reason of ['invalid signature', 'local account denied']) {
    const failure = new Error(reason);
    const wrapped = withLocalBootstrapClaimsEvidence(
      {
        verifyAccessToken: async () => {
          throw failure;
        },
      },
      environment,
      () => assert.fail('unexpected evidence'),
    );
    await assert.rejects(wrapped.verifyAccessToken('private-jwt'), (error) => error === failure);
  }
});

test('dedupe ไม่ผูก session/token และ bounded สูงสุด 32 events ต่อ process instance', async () => {
  let claims = actual();
  let count = 0;
  const wrapped = withLocalBootstrapClaimsEvidence(
    { verifyAccessToken: async () => claims },
    environment,
    () => {
      count++;
    },
  );
  await wrapped.verifyAccessToken('token-one');
  claims = actual({ sid: 'another-private-session', exp: Math.floor(Date.now() / 1000) + 7200 });
  await wrapped.verifyAccessToken('token-two');
  assert.equal(count, 1);
  for (let index = 0; index < 50; index++) {
    claims = actual({ sub: `private-subject-${index}` });
    await wrapped.verifyAccessToken('token');
  }
  assert.equal(count, 32);
});

test('sync/async sink failure ไม่เปลี่ยน authentication และไม่ emit ซ้ำ', async () => {
  const claims = actual();
  for (const sink of [
    () => {
      throw new Error('sink failed');
    },
    async () => {
      throw new Error('sink failed');
    },
  ]) {
    let count = 0;
    const wrapped = withLocalBootstrapClaimsEvidence(
      { verifyAccessToken: async () => claims },
      environment,
      () => {
        count++;
        return sink();
      },
    );
    assert.equal(await wrapped.verifyAccessToken('token'), claims);
    assert.equal(await wrapped.verifyAccessToken('token'), claims);
    assert.equal(count, 1);
  }
});

test('Organization UUID เปลี่ยนเฉพาะ manifest digest ไม่ปลอมเป็น actual JWT observation', async () => {
  const evidence: LocalBootstrapClaimsEvidence[] = [];
  const verifier: OidcAccessTokenVerifier = { verifyAccessToken: async () => actual() };
  for (const organizationId of [expected.organizationId, expected.userId]) {
    const wrapped = withLocalBootstrapClaimsEvidence(
      verifier,
      {
        ...environment,
        LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON: JSON.stringify({ ...expected, organizationId }),
      },
      (value) => {
        evidence.push(value);
      },
    );
    await wrapped.verifyAccessToken('token');
  }
  assert.equal(evidence[0].actualClaimTupleDigest, evidence[1].actualClaimTupleDigest);
  assert.notEqual(evidence[0].expectedManifestDigest, evidence[1].expectedManifestDigest);
  assert.equal(evidence[0].matched, true);
  assert.equal(evidence[1].matched, true);
});

test('UAT bootstrap ห่อ diagnostic นอก local account admission และไม่แก้ gateway guard', () => {
  const source = readFileSync(`${__dirname}/e1-uat-api.ts`, 'utf8');
  assert.match(
    source,
    /const verifier = withLocalBootstrapClaimsEvidence\(\s*withLocalAccountAdmission\(/,
  );
});
