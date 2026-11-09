import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C360ServiceProofAuthority,
  C360ServiceProofError,
  type C360ServiceProofContext,
} from './customer-360-service-proof.js';

const context: C360ServiceProofContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  issuer: 'https://identity.example.test/realms/m3',
  subject: 'synthetic-service-subject',
  clientId: 'reference-client',
  bindingId: '22222222-2222-4222-8222-222222222222',
  authzEpoch: '1',
};
const read = 'customer360.contacts.read' as const;
const create = 'customer360.contacts.create' as const;
function fixture() {
  let now = Date.now();
  const claims = {
    iss: context.issuer,
    sub: context.subject,
    azp: context.clientId,
    preferred_username: `service-account-${context.clientId}`,
    tenant_id: context.tenantId,
    tenant_slug: 'm3-fixture',
    organization: { 'm3-fixture': { tenant_id: [context.tenantId] } },
    realm_access: { roles: ['service'] },
    scope: `${read} ${create}`,
    exp: Math.floor(now / 1_000) + 60,
  };
  const verified: string[] = [];
  const introspected: string[] = [];
  const verifier = {
    async verifyAccessToken(token: string) {
      verified.push(token);
      return claims;
    },
  };
  const introspector = {
    async introspect(token: string) {
      introspected.push(token);
      return { active: true };
    },
  };
  const authority = new C360ServiceProofAuthority(verifier, introspector, {
    issuer: context.issuer,
    now: () => now,
    timeoutMs: 20,
  });
  return {
    authority,
    claims,
    verified,
    introspected,
    verifier,
    setTime: (value: number) => {
      now = value;
    },
    now,
  };
}

test('service mutation ตรวจ exact token ทุกครั้ง ไม่ cache และไม่รับ proof ที่ปลอม/ข้าม authority/scope', async () => {
  const f = fixture();
  const proof = await f.authority.check('synthetic-exact-token', context, read);
  await f.authority.check('rotated-synthetic-token', context, read);
  assert.deepEqual(f.verified, ['synthetic-exact-token', 'rotated-synthetic-token']);
  assert.deepEqual(f.introspected, f.verified);
  f.authority.assert(proof, context, read);
  assert.throws(() => f.authority.assert({ ...proof }, context, read), C360ServiceProofError);
  assert.throws(() => fixture().authority.assert(proof, context, read), C360ServiceProofError);
  assert.throws(() => f.authority.assert(proof, context, create), C360ServiceProofError);
});

test('rebind/revoke หรือ context คนละ tenant/client/binding ทำให้ proof เดิมใช้ไม่ได้', async () => {
  const f = fixture();
  const proof = await f.authority.check('synthetic-token', context, create);
  for (const key of [
    'tenantId',
    'issuer',
    'subject',
    'clientId',
    'bindingId',
    'authzEpoch',
  ] as const) {
    assert.throws(
      () => f.authority.assert(proof, { ...context, [key]: 'changed' }, create),
      C360ServiceProofError,
    );
  }
});

test('effect/receipt หลัง deadline หรือ clock ย้อนกลับต้องปฏิเสธ proof', async () => {
  const f = fixture();
  const proof = await f.authority.check('synthetic-token', context, create);
  f.setTime(f.now + 4_999);
  f.authority.assert(proof, context, create);
  f.setTime(f.now + 5_000);
  assert.throws(() => f.authority.assert(proof, context, create), C360ServiceProofError);
  f.setTime(f.now - 1);
  assert.throws(() => f.authority.assert(proof, context, create), C360ServiceProofError);
});

test('token หมดอายุ, mixed human claims หรือ scope ไม่พอไม่ผ่าน machine boundary', async () => {
  for (const variant of ['expiry', 'human', 'scope', 'tenant'] as const) {
    const f = fixture();
    const claims = variant === 'human' ? { ...f.claims, dc_user_id: 'human-user' } : f.claims;
    if (variant === 'expiry') claims.exp = Math.floor(f.now / 1_000) - 1;
    if (variant === 'scope') claims.scope = read;
    if (variant === 'tenant') claims.tenant_id = 'other-tenant';
    const authority = new C360ServiceProofAuthority(
      { verifyAccessToken: async () => claims },
      {
        introspect: async () => {
          throw new Error('must not introspect rejected identity');
        },
      },
      { issuer: context.issuer },
    );
    await assert.rejects(
      () => authority.check('synthetic-token', context, create),
      (error: unknown) =>
        error instanceof C360ServiceProofError && [401, 403].includes(error.status),
    );
  }
});

test('inactive token และ IdP timeout ปิดสิทธิ์ โดย error ไม่เผย token/credentials', async () => {
  const f = fixture();
  for (const variant of ['inactive', 'timeout', 'error'] as const) {
    const authority = new C360ServiceProofAuthority(
      f.verifier,
      {
        introspect: async () => {
          if (variant === 'timeout') return new Promise<Record<string, unknown>>(() => {});
          if (variant === 'error') throw new Error('synthetic-private-token-and-secret');
          return { active: false };
        },
      },
      { issuer: context.issuer, timeoutMs: 10 },
    );
    await assert.rejects(
      () => authority.check('synthetic-private-token', context, create),
      (error: unknown) =>
        error instanceof C360ServiceProofError && !String(error).includes('synthetic-private'),
    );
  }
});

test('dependency ที่โยน error ชนิดเดียวกับ authority ต้องไม่ส่ง code ที่มี secret ออกไป', async () => {
  const f = fixture();
  for (const source of ['verifier', 'introspector'] as const) {
    const sentinel = 'synthetic-credential-sentinel';
    const authority = new C360ServiceProofAuthority(
      source === 'verifier'
        ? {
            verifyAccessToken: async () => {
              throw new C360ServiceProofError(503, sentinel);
            },
          }
        : f.verifier,
      {
        introspect: async () => {
          throw new C360ServiceProofError(503, sentinel);
        },
      },
      { issuer: context.issuer },
    );
    await assert.rejects(
      () => authority.check('synthetic-token', context, create),
      (error: unknown) =>
        error instanceof C360ServiceProofError && !String(error).includes(sentinel),
    );
  }
});
