import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { LocalAccountAccessTokenVerifier } from './local-account-verifier.js';

const tenantId = '4e342ec5-d35b-41ed-bd44-1cf47a41af4b';
const userId = '619b9c43-8495-420d-b3d3-34d9fd0b5b89';
const claims: VerifiedOidcClaims = {
  tenant_id: tenantId,
  tenant_slug: 'demo',
  organization: { demo: { tenant_id: [tenantId] } },
  dc_user_id: userId,
  sid: 'existing-session',
  exp: 2_000_000_000,
  realm_access: { roles: ['admin'] },
};

test('JWT เดิมถูกปฏิเสธทันทีหลัง local disable โดยไม่ cache ผล active', async () => {
  let active = true;
  const calls: string[][] = [];
  const verifier = new LocalAccountAccessTokenVerifier(
    { verifyAccessToken: async () => claims },
    async (tenant, user) => {
      calls.push([tenant, user]);
      return active;
    },
  );
  assert.equal(await verifier.verifyAccessToken('same-token'), claims);
  active = false;
  await assert.rejects(verifier.verifyAccessToken('same-token'));
  assert.deepEqual(calls, [
    [tenantId, userId],
    [tenantId, userId],
  ]);
});

test('สถานะบัญชีอ่านไม่ได้ต้อง fail closed', async () => {
  const verifier = new LocalAccountAccessTokenVerifier(
    { verifyAccessToken: async () => claims },
    async () => {
      throw new Error('database unavailable');
    },
  );
  await assert.rejects(verifier.verifyAccessToken('token'), /workspace/i);
});

test('signature verification ต้องผ่านก่อนอ่าน local account', async () => {
  let reads = 0;
  const verifier = new LocalAccountAccessTokenVerifier(
    {
      verifyAccessToken: async () => {
        throw new Error('invalid signature');
      },
    },
    async () => {
      reads++;
      return true;
    },
  );
  await assert.rejects(verifier.verifyAccessToken('invalid-token'), /invalid signature/);
  assert.equal(reads, 0);
});

test('service principal ที่ตรวจ shape แล้วไม่ต้องมี domain User', async () => {
  const { dc_user_id, sid, ...common } = claims;
  const service = {
    ...common,
    azp: 'governance-reader',
    sub: 'service-subject',
    preferred_username: 'service-account-governance-reader',
  };
  let reads = 0;
  const verifier = new LocalAccountAccessTokenVerifier(
    { verifyAccessToken: async () => service },
    async () => {
      reads++;
      return false;
    },
  );
  assert.equal(await verifier.verifyAccessToken('service-token'), service);
  assert.equal(reads, 0);
});

test('workspace token แอบมี service claims ไม่ข้าม local deny', async () => {
  const verifier = new LocalAccountAccessTokenVerifier(
    {
      verifyAccessToken: async () => ({
        ...claims,
        azp: 'client',
        sub: 'subject',
        preferred_username: 'service-account-client',
      }),
    },
    async () => false,
  );
  await assert.rejects(verifier.verifyAccessToken('disabled-user-token'));
});
