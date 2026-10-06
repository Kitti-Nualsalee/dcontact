/**
 * AC1 (#594) บน Postgres จริงด้วย role ของแอป (`dcontact_app`, RLS):
 * ไม่มีแถว = ค่าเริ่มต้น, เฉพาะ ADMIN, audit ทุกการเปลี่ยน, revision/validation,
 * แยก tenant (ทั้งผ่าน API และอ่านตรงด้วย `dcontact_app`), audit แก้/ลบไม่ได้
 * และการบังคับ 2FA ต้อง sync ผ่าน port ได้ก่อนจึงบันทึก
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { ACCOUNT_POLICY_SERVICE, AccountPolicyController } from './account-policy-api.js';
import { AccountPolicyService, type OrganizationMfaPort } from './account-policy.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

function claims(token: string): VerifiedOidcClaims {
  const [tenantId, userId, role] = token.split('|');
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role!] },
  };
}

async function setup(t: TestContext, options: { mfa?: OrganizationMfaPort } = {}) {
  const tenants = [randomUUID(), randomUUID()] as const;
  const [tenantA, tenantB] = tenants;
  const slugs = tenants.map((id) => `acct-${id.slice(0, 8)}`);
  const users = {
    admin: randomUUID(),
    supervisor: randomUUID(),
    agent: randomUUID(),
    adminB: randomUUID(),
  };
  await owner.tenant.createMany({
    data: tenants.map((id, index) => ({
      id,
      name: slugs[index]!,
      slug: slugs[index]!,
      sipDomain: `${id}.account.test`,
    })),
  });
  await owner.user.createMany({
    data: [
      { id: users.admin, role: 'ADMIN' as const, tenantId: tenantA },
      { id: users.supervisor, role: 'SUPERVISOR' as const, tenantId: tenantA },
      { id: users.agent, role: 'AGENT' as const, tenantId: tenantA },
      { id: users.adminB, role: 'ADMIN' as const, tenantId: tenantB },
    ].map((user) => ({
      ...user,
      email: `${user.id}@account.test`,
      passwordHash: 'test',
      displayName: user.role,
    })),
  });
  const service = new AccountPolicyService(application, {
    now: () => new Date('2026-10-02T09:00:00.000Z'),
    ...(options.mfa ? { mfa: options.mfa } : {}),
  });

  @Module({
    controllers: [AccountPolicyController],
    providers: [
      { provide: ACCOUNT_POLICY_SERVICE, useValue: service },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async (token: string) => claims(token) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  t.after(async () => {
    await app.close();
    const ids = [...tenants];
    await owner.tenantAccountPolicyAuditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantAccountPolicy.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.user.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  });

  const token = {
    admin: `${tenantA}|${users.admin}|admin`,
    supervisor: `${tenantA}|${users.supervisor}|supervisor`,
    agent: `${tenantA}|${users.agent}|agent`,
    adminB: `${tenantB}|${users.adminB}|admin`,
  };
  const call = async (method: 'GET' | 'PUT', auth?: string, body?: unknown) => {
    const response = await fetch(`${base}${PATH}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        'x-correlation-id': 'corr-account-policy',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const audits = (tenantId: string) =>
    owner.tenantAccountPolicyAuditEvent.findMany({
      where: { tenantId },
      orderBy: { occurredAt: 'asc' },
    });
  return { tenantA, tenantB, users, token, call, audits };
}

const PATH = '/api/v1/tenant/account-policy';

test('ไม่มีแถว = ค่าเริ่มต้น (VERIFY, ไม่บังคับ 2FA, revision 0); เฉพาะ ADMIN เท่านั้น', async (t) => {
  const f = await setup(t);
  const initial = await f.call('GET', f.token.admin);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.deepEqual(initial.body, {
    emailChange: 'VERIFY',
    mfaRequired: false,
    revision: 0,
    updatedAt: null,
  });

  assert.equal((await f.call('GET')).status, 401);
  for (const role of ['supervisor', 'agent'] as const) {
    assert.equal((await f.call('GET', f.token[role])).status, 403, role);
    const denied = await f.call('PUT', f.token[role], {
      emailChange: 'IMMEDIATE',
      reason: 'ไม่ควรผ่าน',
      expectedRevision: 0,
    });
    assert.equal(denied.status, 403, role);
  }
  assert.equal(await owner.tenantAccountPolicy.count({ where: { tenantId: f.tenantA } }), 0);
  assert.equal((await f.audits(f.tenantA)).length, 0);
});

test('ADMIN แก้นโยบายได้พร้อม audit ก่อน/หลังทุกครั้ง; revision เก่า 409; ส่งค่าเดิมซ้ำไม่เขียนอะไร; ข้อมูลผิด 400', async (t) => {
  const f = await setup(t);
  const updated = await f.call('PUT', f.token.admin, {
    emailChange: 'IMMEDIATE',
    reason: '  ทีมเล็ก ไม่ต้องยืนยันอีเมล  ',
    expectedRevision: 0,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body, {
    emailChange: 'IMMEDIATE',
    mfaRequired: false,
    revision: 1,
    updatedAt: '2026-10-02T09:00:00.000Z',
  });
  assert.deepEqual((await f.call('GET', f.token.admin)).body, updated.body);

  const stale = await f.call('PUT', f.token.admin, {
    emailChange: 'ADMIN_ONLY',
    reason: 'admin อีกคนแก้ทับ',
    expectedRevision: 0,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { code: 'REVISION_CONFLICT' });

  const unchanged = await f.call('PUT', f.token.admin, {
    emailChange: 'IMMEDIATE',
    reason: 'กดบันทึกซ้ำ',
    expectedRevision: 1,
  });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.revision, 1);

  const second = await f.call('PUT', f.token.admin, {
    emailChange: 'ADMIN_ONLY',
    reason: 'ให้ admin แก้อีเมลแทน',
    expectedRevision: 1,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.revision, 2);

  const events = await f.audits(f.tenantA);
  assert.deepEqual(
    events.map((event) => [event.before, event.after, event.reason, event.actorUserId]),
    [
      [
        { emailChange: 'VERIFY', mfaRequired: false },
        { emailChange: 'IMMEDIATE', mfaRequired: false },
        'ทีมเล็ก ไม่ต้องยืนยันอีเมล',
        f.users.admin,
      ],
      [
        { emailChange: 'IMMEDIATE', mfaRequired: false },
        { emailChange: 'ADMIN_ONLY', mfaRequired: false },
        'ให้ admin แก้อีเมลแทน',
        f.users.admin,
      ],
    ],
  );
  assert.ok(events.every((event) => event.correlationId === 'corr-account-policy'));

  const invalid: Array<[unknown, Record<string, string>]> = [
    [
      { emailChange: 'VERIFY', expectedRevision: 2 },
      { field: 'reason', reason: 'REQUIRED' },
    ],
    [
      { emailChange: 'VERIFY', reason: 'ab', expectedRevision: 2 },
      { field: 'reason', reason: 'INVALID' },
    ],
    [
      { emailChange: 'VERIFY', reason: 'x'.repeat(501), expectedRevision: 2 },
      { field: 'reason', reason: 'INVALID' },
    ],
    [
      { emailChange: 'NEVER', reason: 'ค่าไม่รู้จัก', expectedRevision: 2 },
      { field: 'emailChange', reason: 'INVALID' },
    ],
    [
      { mfaRequired: 'yes', reason: 'ชนิดผิด', expectedRevision: 2 },
      { field: 'mfaRequired', reason: 'INVALID' },
    ],
    [
      { reason: 'ไม่มีอะไรให้แก้', expectedRevision: 2 },
      { field: 'body', reason: 'REQUIRED' },
    ],
    [
      { emailChange: 'VERIFY', reason: 'ไม่มี revision' },
      { field: 'expectedRevision', reason: 'REQUIRED' },
    ],
    [
      { emailChange: 'VERIFY', reason: 'revision ผิดชนิด', expectedRevision: '2' },
      { field: 'expectedRevision', reason: 'INVALID' },
    ],
  ];
  for (const [body, field] of invalid) {
    const response = await f.call('PUT', f.token.admin, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(response.body, { code: 'VALIDATION_FAILED', ...field });
  }
  assert.equal((await f.audits(f.tenantA)).length, 2);
});

test('แยก tenant: admin ของ tenant B เห็น/แก้ได้เฉพาะของตัวเอง และ dcontact_app อ่านข้าม tenant ได้ 0 แถว', async (t) => {
  const f = await setup(t);
  const updatedA = await f.call('PUT', f.token.admin, {
    emailChange: 'ADMIN_ONLY',
    reason: 'ตั้งค่า tenant A',
    expectedRevision: 0,
  });
  assert.equal(updatedA.status, 200);

  assert.deepEqual((await f.call('GET', f.token.adminB)).body, {
    emailChange: 'VERIFY',
    mfaRequired: false,
    revision: 0,
    updatedAt: null,
  });
  const updatedB = await f.call('PUT', f.token.adminB, {
    emailChange: 'IMMEDIATE',
    reason: 'ตั้งค่า tenant B',
    expectedRevision: 0,
  });
  assert.equal(updatedB.status, 200);
  assert.equal((await f.call('GET', f.token.admin)).body.emailChange, 'ADMIN_ONLY');
  assert.equal((await f.audits(f.tenantA)).length, 1);
  assert.equal((await f.audits(f.tenantB)).length, 1);

  const seenFromB = await withTenantDatabaseTransaction(application, f.tenantB, async (tx) => ({
    policies: await tx.tenantAccountPolicy.findMany({ where: { tenantId: f.tenantA } }),
    audits: await tx.tenantAccountPolicyAuditEvent.findMany({ where: { tenantId: f.tenantA } }),
  }));
  assert.deepEqual(seenFromB, { policies: [], audits: [] });

  // audit เขียนเพิ่มได้อย่างเดียว และนโยบายลบไม่ได้ (ถอยกลับ = แก้ค่าพร้อม audit)
  await assert.rejects(
    withTenantDatabaseTransaction(application, f.tenantA, (tx) =>
      tx.tenantAccountPolicyAuditEvent.updateMany({ data: { reason: 'แก้ประวัติ' } }),
    ),
    /permission denied/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, f.tenantA, (tx) =>
      tx.tenantAccountPolicyAuditEvent.deleteMany({}),
    ),
    /permission denied/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, f.tenantA, (tx) =>
      tx.tenantAccountPolicy.deleteMany({}),
    ),
    /permission denied/,
  );
});

test('บังคับ 2FA: ยังไม่มี port = 409 ไม่บันทึก; port ล้ม = rollback ทั้งนโยบายและ audit; port สำเร็จ = บันทึก', async (t) => {
  const withoutPort = await setup(t);
  const unavailable = await withoutPort.call('PUT', withoutPort.token.admin, {
    mfaRequired: true,
    reason: 'บังคับ 2FA ทั้ง tenant',
    expectedRevision: 0,
  });
  assert.equal(unavailable.status, 409);
  assert.deepEqual(unavailable.body, { code: 'MFA_ENFORCEMENT_UNAVAILABLE' });
  assert.equal((await withoutPort.call('GET', withoutPort.token.admin)).body.revision, 0);
  assert.equal((await withoutPort.audits(withoutPort.tenantA)).length, 0);

  const calls: Array<[string, boolean]> = [];
  let fail = true;
  const f = await setup(t, {
    mfa: {
      setMfaRequired: async (tenantId, required) => {
        calls.push([tenantId, required]);
        if (fail) throw new Error('identity unavailable');
      },
    },
  });
  const failed = await f.call('PUT', f.token.admin, {
    emailChange: 'IMMEDIATE',
    mfaRequired: true,
    reason: 'บังคับ 2FA ทั้ง tenant',
    expectedRevision: 0,
  });
  assert.equal(failed.status, 500);
  assert.deepEqual((await f.call('GET', f.token.admin)).body, {
    emailChange: 'VERIFY',
    mfaRequired: false,
    revision: 0,
    updatedAt: null,
  });
  assert.equal((await f.audits(f.tenantA)).length, 0);

  fail = false;
  const enforced = await f.call('PUT', f.token.admin, {
    mfaRequired: true,
    reason: 'บังคับ 2FA ทั้ง tenant',
    expectedRevision: 0,
  });
  assert.equal(enforced.status, 200, JSON.stringify(enforced.body));
  assert.deepEqual([enforced.body.mfaRequired, enforced.body.revision], [true, 1]);

  // เปลี่ยนเฉพาะ email ไม่เรียก port
  const emailOnly = await f.call('PUT', f.token.admin, {
    emailChange: 'ADMIN_ONLY',
    reason: 'เปลี่ยนเฉพาะอีเมล',
    expectedRevision: 1,
  });
  assert.equal(emailOnly.status, 200);
  assert.deepEqual(calls, [
    [f.tenantA, true],
    [f.tenantA, true],
  ]);
  assert.equal((await f.audits(f.tenantA)).length, 2);
});

test.after(async () => {
  await owner.$disconnect();
  await application.$disconnect();
});
