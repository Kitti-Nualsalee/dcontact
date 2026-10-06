/**
 * AC4 (#597) ครบทุก endpoint ของ `/api/v1/me/account` กับ Keycloak 26.7.5 จริง + Postgres (`dcontact_app`, RLS)
 * ต้องมี dev stack + `pnpm infra:bootstrap` (org/tenant `demo`, `demo-two`) + extension `dc-account`
 *
 * - ชื่อ: `users.display_name` + Keycloak; identity ล้ม = DB ไม่เปลี่ยน (compensation)
 * - รหัสผ่าน: policy → `PASSWORD_POLICY_VIOLATION` + rules[], สำเร็จ = audit + email แจ้ง, rate limit 5/ชม.
 * - email: VERIFY (token hash, ยืนยัน, หมดอายุ, ใช้ซ้ำไม่ได้), IMMEDIATE, ADMIN_ONLY, EMAIL_IN_USE, ยกเลิก
 * - TOTP: enrolment เข้ารหัส, code ผิด, ครบ 5 ครั้ง, หมดอายุ, สำเร็จ, ห้ามลบอุปกรณ์สุดท้ายเมื่อบังคับ 2FA
 * - ข้ามผู้ใช้/ข้าม tenant ไม่ได้; agent ใช้ได้ทุก endpoint; ไม่มีรหัสผ่าน/secret/token/email ใน audit
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { ACCOUNT_SELF_SERVICE, AccountController } from './account-api.js';
import { AccountSecretBox, KeycloakAccountIdentity } from './account-identity.js';
import { AccountSelfService, tokenHash } from './account-self-service.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { KeycloakAccountServiceClient } from './keycloak-account-service.js';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const ISSUER = `${KEYCLOAK}/realms/dcontact`;
const ADMIN = `${KEYCLOAK}/admin/realms/dcontact`;
const ACCOUNT_SECRET =
  process.env.KEYCLOAK_ACCOUNT_SERVICE_SECRET ?? 'dcontact-account-service-dev-secret';
const KEY = randomBytes(32).toString('base64');
const PASSWORD = `Ac4-${randomBytes(6).toString('hex')}`;

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

let adminAccessToken = '';
async function admin<T = unknown>(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminAccessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${path} → ${response.status}`);
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : undefined) as T, headers: response.headers };
}

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
    realm_access: { roles: role ? [role] : [] },
  };
}

/** RFC 6238 จาก secret Base32 ที่ API คืนให้แอป authenticator */
function totpFromBase32(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function wrongCode(secret: string) {
  const valid = new Set(
    [-1, 0, 1].map((step) => totpFromBase32(secret, Date.now() + step * 30_000)),
  );
  let code = '000000';
  for (let n = 0; valid.has(code); n += 1) code = String(n).padStart(6, '0');
  return code;
}

type Tenant = { id: string; slug: string; organizationId: string };
type Account = { id: string; keycloakId: string; email: string; tenant: Tenant };

const state = {
  app: undefined as unknown as INestApplication,
  base: '',
  demo: undefined as unknown as Tenant,
  demoTwo: undefined as unknown as Tenant,
  accounts: [] as Account[],
  originalPasswordPolicy: '',
  originalPolicies: [] as Array<Record<string, unknown>>,
  secrets: [] as string[],
};

async function tenant(slug: string): Promise<Tenant> {
  const row = await owner.tenant.findFirstOrThrow({ where: { slug }, select: { id: true } });
  const { body } = await admin<Array<{ id: string; alias: string }>>(
    'GET',
    '/organizations?first=0&max=100',
  );
  const organization = body.find((candidate) => candidate.alias === slug);
  assert.ok(organization, `ต้องมี org ${slug} (pnpm infra:bootstrap)`);
  const { body: full } = await admin<{ attributes?: Record<string, string[]> }>(
    'GET',
    `/organizations/${organization.id}`,
  );
  assert.equal(full.attributes?.tenant_id?.[0], row.id, `org ${slug} ต้องผูกกับ tenant ใน DB`);
  return { id: row.id, slug, organizationId: organization.id };
}

async function account(of: Tenant, name: string): Promise<Account> {
  const id = randomUUID();
  const email = `ac4-${name}-${randomBytes(3).toString('hex')}@${of.slug}.local`;
  const { headers } = await admin('POST', '/users', {
    username: email,
    email,
    emailVerified: true,
    enabled: true,
    firstName: 'AC4',
    lastName: name,
    attributes: { tenant_id: [of.id], tenant_slug: [of.slug], dc_user_id: [id] },
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
  });
  const keycloakId = headers.get('location')!.split('/').pop()!;
  await admin('POST', `/organizations/${of.organizationId}/members`, keycloakId);
  await owner.user.create({
    data: {
      id,
      keycloakId,
      tenantId: of.id,
      email,
      passwordHash: '-',
      displayName: `AC4 ${name}`,
      role: 'AGENT',
    },
  });
  const created = { id, keycloakId, email, tenant: of };
  state.accounts.push(created);
  return created;
}

const token = (who: Account, role = 'agent') => `${who.tenant.id}|${who.id}|${role}`;

async function call(method: string, path: string, auth?: string, body?: unknown) {
  const response = await fetch(`${state.base}/api/v1/me/account${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      'x-correlation-id': 'corr-ac4',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, any>) : undefined,
  };
}

async function setPolicy(of: Tenant, policy: { emailChangePolicy: string; mfaRequired: boolean }) {
  await owner.tenantAccountPolicy.upsert({
    where: { tenantId: of.id },
    create: {
      tenantId: of.id,
      ...policy,
      revision: 1,
      updatedBy: randomUUID(),
      updatedAt: new Date(),
    },
    update: policy,
  });
}

const keycloakUser = (who: Account) =>
  admin<{ email: string; emailVerified: boolean; firstName: string; lastName: string }>(
    'GET',
    `/users/${who.keycloakId}`,
  ).then(({ body }) => body);

before(async () => {
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  adminAccessToken = ((await response.json()) as { access_token: string }).access_token;
  state.demo = await tenant('demo');
  state.demoTwo = await tenant('demo-two');
  state.originalPolicies = await owner.tenantAccountPolicy.findMany({
    where: { tenantId: { in: [state.demo.id, state.demoTwo.id] } },
  });
  const { body: realm } = await admin<{ passwordPolicy?: string }>('GET', '');
  state.originalPasswordPolicy = realm.passwordPolicy ?? '';

  const service = new AccountSelfService(
    application,
    new KeycloakAccountIdentity(
      new KeycloakAccountServiceClient({ issuer: ISSUER, clientSecret: ACCOUNT_SECRET }),
    ),
    new AccountSecretBox(KEY),
  );
  @Module({
    controllers: [AccountController],
    providers: [
      { provide: ACCOUNT_SELF_SERVICE, useValue: service },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async (value: string) => claims(value) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  state.app = await NestFactory.create(TestModule, { logger: false });
  await state.app.listen(0, '127.0.0.1');
  state.base = `http://127.0.0.1:${(state.app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await state.app?.close();
  await admin('PUT', '', { passwordPolicy: state.originalPasswordPolicy }).catch(() => undefined);
  const userIds = state.accounts.map((item) => item.id);
  const tenants = [state.demo.id, state.demoTwo.id];
  await owner.accountEmailOutbox.deleteMany({ where: { userId: { in: userIds } } });
  await owner.accountAuditEvent.deleteMany({ where: { userId: { in: userIds } } });
  await owner.user.deleteMany({ where: { id: { in: userIds } } });
  await owner.tenantAccountPolicy.deleteMany({ where: { tenantId: { in: tenants } } });
  for (const original of state.originalPolicies) {
    await owner.tenantAccountPolicy.create({ data: original as never });
  }
  for (const item of state.accounts) {
    await admin('DELETE', `/users/${item.keycloakId}`).catch(() => undefined);
  }
  await owner.$disconnect();
  await application.$disconnect();
});

test('GET: ข้อมูลของเจ้าของ token, agent ใช้ได้, ไม่มี role ของ tenant = 403', async () => {
  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: false });
  const me = await account(state.demo, 'get');
  const response = await call('GET', '', token(me));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    firstName: 'AC4',
    lastName: 'get',
    email: me.email,
    pendingEmail: null,
    mfa: { enrolled: false, required: false, devices: [] },
    policy: { emailChange: 'VERIFY' },
  });
  assert.equal((await call('GET', '')).status, 401);
  assert.equal((await call('GET', '', token(me, 'platform-operator'))).status, 403);
  // dc_user_id ของผู้ใช้ tenant demo แต่ token ของ tenant demo-two → ไม่พบผู้ใช้ใน tenant นั้น (RLS)
  const crossTenant = await call('GET', '', `${state.demoTwo.id}|${me.id}|agent`);
  assert.deepEqual([crossTenant.status, crossTenant.body], [503, { code: 'IDENTITY_UNAVAILABLE' }]);
});

test('PATCH profile: users.display_name + Keycloak; identity ล้ม = DB ไม่เปลี่ยน', async () => {
  const me = await account(state.demo, 'profile');
  const updated = await call('PATCH', '/profile', token(me), {
    firstName: '  สมชาย ',
    lastName: 'ใจดี',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body, { firstName: 'สมชาย', lastName: 'ใจดี' });
  const row = await owner.user.findUniqueOrThrow({ where: { id: me.id } });
  assert.equal(row.displayName, 'สมชาย ใจดี');
  const kc = await keycloakUser(me);
  assert.deepEqual([kc.firstName, kc.lastName], ['สมชาย', 'ใจดี']);

  for (const [body, field] of [
    [{ lastName: 'x' }, 'firstName'],
    [{ firstName: 'x', lastName: 'y'.repeat(101) }, 'lastName'],
  ] as const) {
    const invalid = await call('PATCH', '/profile', token(me), body);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body?.field, field);
  }

  // ผู้ใช้ที่ identity หายไป: Keycloak ปฏิเสธ → transaction ถูกยกเลิก
  const orphan = await account(state.demo, 'orphan');
  await admin('DELETE', `/users/${orphan.keycloakId}`);
  const failed = await call('PATCH', '/profile', token(orphan), { firstName: 'X', lastName: 'Y' });
  assert.deepEqual([failed.status, failed.body], [503, { code: 'IDENTITY_UNAVAILABLE' }]);
  assert.equal(
    (await owner.user.findUniqueOrThrow({ where: { id: orphan.id } })).displayName,
    'AC4 orphan',
  );
  assert.equal(await owner.accountAuditEvent.count({ where: { userId: orphan.id } }), 0);
  assert.equal(
    (await owner.accountAuditEvent.findMany({ where: { userId: me.id } }))
      .map((e) => e.action)
      .join(),
    'profile.updated',
  );
});

test('POST password: policy → rules[], สำเร็จ = audit + email แจ้ง, เกิน 5 ครั้ง/ชม. = 429', async () => {
  const me = await account(state.demo, 'password');
  await admin('PUT', '', { passwordPolicy: 'length(12) and upperCase(1) and digits(1)' });
  try {
    const weak = await call('POST', '/password', token(me), { newPassword: 'alllowercase1234' });
    assert.equal(weak.status, 400);
    assert.deepEqual(weak.body, {
      code: 'PASSWORD_POLICY_VIOLATION',
      rules: [{ rule: 'UPPER_CASE', value: 1 }],
    });
    assert.equal(await owner.accountAuditEvent.count({ where: { userId: me.id } }), 0);
    assert.equal(await owner.accountEmailOutbox.count({ where: { userId: me.id } }), 0);

    const { body: before } = await admin<Array<{ type: string; createdDate: number }>>(
      'GET',
      `/users/${me.keycloakId}/credentials`,
    );
    const strong = 'Strong-Password-2026';
    const changed = await call('POST', '/password', token(me), { newPassword: strong });
    assert.equal(changed.status, 204, JSON.stringify(changed.body));
    const { body: afterChange } = await admin<Array<{ type: string; createdDate: number }>>(
      'GET',
      `/users/${me.keycloakId}/credentials`,
    );
    const createdOf = (list: typeof before) =>
      list.find((item) => item.type === 'password')!.createdDate;
    assert.ok(createdOf(afterChange) > createdOf(before), 'รหัสผ่านใหม่ถูกตั้งใน Keycloak');

    const outbox = await owner.accountEmailOutbox.findMany({ where: { userId: me.id } });
    assert.deepEqual(
      outbox.map((row) => [row.template, row.recipient, row.locale]),
      [['password-changed-notice', me.email, 'th']],
    );
    const audit = await owner.accountAuditEvent.findMany({ where: { userId: me.id } });
    assert.deepEqual(
      audit.map((event) => [event.action, event.correlationId]),
      [['password.changed', 'corr-ac4']],
    );
    assert.ok(!JSON.stringify(audit).includes(strong));
    assert.ok(!JSON.stringify(outbox).includes(strong));
  } finally {
    await admin('PUT', '', { passwordPolicy: state.originalPasswordPolicy });
  }

  const limited = await account(state.demo, 'ratelimit');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(
      (await call('POST', '/password', token(limited), { newPassword: `Another-Pass-${attempt}x` }))
        .status,
      204,
    );
  }
  const sixth = await call('POST', '/password', token(limited), { newPassword: 'Another-Pass-6x' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body?.code, 'RATE_LIMITED');
  assert.ok(Number(sixth.headers.get('retry-after')) > 0);
});

test('email VERIFY: ส่งลิงก์ไป email ใหม่, ยืนยันแล้วเปลี่ยนทั้ง Keycloak/DB, แจ้ง email เดิม, token ใช้ซ้ำไม่ได้', async () => {
  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: false });
  const me = await account(state.demo, 'verify');
  const other = await account(state.demo, 'other');
  const newEmail = `ac4-new-${randomBytes(3).toString('hex')}@demo.local`;

  const requested = await call('POST', '/email-change', token(me), {
    newEmail: newEmail.toUpperCase(),
  });
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  assert.equal(requested.body?.status, 'PENDING');
  assert.equal(requested.body?.pendingEmail, newEmail);
  assert.equal((await call('GET', '', token(me))).body?.pendingEmail, newEmail);
  assert.equal((await keycloakUser(me)).email, me.email, 'ยังไม่เปลี่ยนจนกว่าจะยืนยัน');

  const [verify] = await owner.accountEmailOutbox.findMany({
    where: { userId: me.id, template: 'verify-new-email' },
  });
  assert.equal(verify?.recipient, newEmail);
  const linkToken = (verify!.variables as { token: string }).token;
  state.secrets.push(linkToken);
  const change = await owner.accountEmailChange.findFirstOrThrow({ where: { userId: me.id } });
  assert.equal(change.tokenHash, tokenHash(linkToken), 'DB เก็บแค่ hash');
  assert.ok(change.expiresAt.getTime() - change.requestedAt.getTime() === 24 * 60 * 60 * 1000);

  // ผู้ใช้อื่นใช้ token นี้ไม่ได้ และ token ผิดตอบแบบเดียวกัน
  for (const [who, value] of [
    [other, linkToken],
    [me, 'not-the-token'],
  ] as const) {
    const rejected = await call('POST', '/email-change/confirm', token(who), { token: value });
    assert.deepEqual([rejected.status, rejected.body], [410, { code: 'EMAIL_CHANGE_EXPIRED' }]);
  }

  const confirmed = await call('POST', '/email-change/confirm', token(me), { token: linkToken });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.deepEqual(confirmed.body, { email: newEmail });
  const kc = await keycloakUser(me);
  assert.deepEqual([kc.email, kc.emailVerified], [newEmail, true]);
  assert.equal((await owner.user.findUniqueOrThrow({ where: { id: me.id } })).email, newEmail);
  const notice = await owner.accountEmailOutbox.findFirstOrThrow({
    where: { userId: me.id, template: 'email-changed-notice' },
  });
  assert.equal(notice.recipient, me.email);

  const reused = await call('POST', '/email-change/confirm', token(me), { token: linkToken });
  assert.equal(reused.status, 410);

  // email ซ้ำกับผู้ใช้อื่น / เหมือนเดิม
  const inUse = await call('POST', '/email-change', token(other), { newEmail });
  assert.deepEqual([inUse.status, inUse.body], [409, { code: 'EMAIL_IN_USE' }]);
  const same = await call('POST', '/email-change', token(other), { newEmail: other.email });
  assert.deepEqual([same.status, same.body?.reason], [400, 'SAME']);

  // หมดอายุ: แถวถูกปิดเป็น EXPIRED
  const late = await account(state.demo, 'late');
  await call('POST', '/email-change', token(late), {
    newEmail: `ac4-late-${randomUUID().slice(0, 6)}@demo.local`,
  });
  const pending = await owner.accountEmailOutbox.findFirstOrThrow({
    where: { userId: late.id, template: 'verify-new-email' },
  });
  await owner.accountEmailChange.updateMany({
    where: { userId: late.id, status: 'PENDING' },
    data: {
      requestedAt: new Date(Date.now() - 3 * 86_400_000),
      expiresAt: new Date(Date.now() - 1_000),
    },
  });
  const expired = await call('POST', '/email-change/confirm', token(late), {
    token: (pending.variables as { token: string }).token,
  });
  assert.equal(expired.status, 410);
  assert.equal(
    (await owner.accountEmailChange.findFirstOrThrow({ where: { userId: late.id } })).status,
    'EXPIRED',
  );

  // ยกเลิก
  const cancel = await account(state.demo, 'cancel');
  await call('POST', '/email-change', token(cancel), {
    newEmail: `ac4-c-${randomUUID().slice(0, 6)}@demo.local`,
  });
  assert.equal((await call('DELETE', '/email-change', token(cancel))).status, 204);
  assert.equal((await call('GET', '', token(cancel))).body?.pendingEmail, null);
  assert.deepEqual(
    (
      await owner.accountAuditEvent.findMany({
        where: { userId: cancel.id },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((event) => event.action),
    ['email.change.requested', 'email.change.cancelled'],
  );
});

test('email IMMEDIATE เปลี่ยนทันที; ADMIN_ONLY = 403; เกิน 3 ครั้ง/ชม. = 429', async () => {
  const me = await account(state.demo, 'immediate');
  await setPolicy(state.demo, { emailChangePolicy: 'IMMEDIATE', mfaRequired: false });
  const newEmail = `ac4-imm-${randomBytes(3).toString('hex')}@demo.local`;
  const changed = await call('POST', '/email-change', token(me), { newEmail });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body, { status: 'CHANGED', email: newEmail });
  assert.equal((await keycloakUser(me)).email, newEmail);
  assert.equal((await owner.user.findUniqueOrThrow({ where: { id: me.id } })).email, newEmail);

  await setPolicy(state.demo, { emailChangePolicy: 'ADMIN_ONLY', mfaRequired: false });
  const denied = await call('POST', '/email-change', token(me), {
    newEmail: `ac4-x-${randomUUID().slice(0, 6)}@demo.local`,
  });
  assert.deepEqual([denied.status, denied.body], [403, { code: 'EMAIL_CHANGE_NOT_ALLOWED' }]);
  // ครั้งที่ 3 ยังอยู่ในโควตา (ถูกปฏิเสธด้วยนโยบาย) — ครั้งที่ 4 ใน 1 ชม. ถูกจำกัด
  const third = await call('POST', '/email-change', token(me), {
    newEmail: `ac4-z-${randomUUID().slice(0, 6)}@demo.local`,
  });
  assert.equal(third.status, 403);
  const limited = await call('POST', '/email-change', token(me), {
    newEmail: `ac4-y-${randomUUID().slice(0, 6)}@demo.local`,
  });
  assert.equal(limited.status, 429);
  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: false });
});

test('TOTP: secret เข้ารหัส, code ผิด, ครบ 5 ครั้ง, หมดอายุ, สำเร็จ, ห้ามลบอุปกรณ์สุดท้ายเมื่อบังคับ 2FA', async () => {
  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: false });
  const me = await account(state.demo, 'totp');
  const other = await account(state.demo, 'totp-other');

  const started = await call('POST', '/mfa/totp/enrolments', token(me));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const { enrolmentId, secret, otpauthUri } = started.body as Record<string, string>;
  state.secrets.push(secret!);
  assert.match(secret!, /^[A-Z2-7]+$/);
  assert.equal(new URL(otpauthUri!).searchParams.get('secret'), secret);
  const stored = await owner.accountTotpEnrolment.findUniqueOrThrow({ where: { id: enrolmentId } });
  assert.ok(stored.secretCiphertext.startsWith('v1.'));
  assert.ok(stored.expiresAt.getTime() - stored.createdAt.getTime() === 10 * 60 * 1000);

  // ผู้ใช้อื่นยืนยัน enrolment นี้ไม่ได้
  const foreign = await call('POST', `/mfa/totp/enrolments/${enrolmentId}/confirm`, token(other), {
    code: totpFromBase32(secret!),
    label: 'x',
  });
  assert.deepEqual([foreign.status, foreign.body], [410, { code: 'ENROLMENT_EXPIRED' }]);

  const wrong = await call('POST', `/mfa/totp/enrolments/${enrolmentId}/confirm`, token(me), {
    code: wrongCode(secret!),
    label: 'โทรศัพท์',
  });
  assert.deepEqual([wrong.status, wrong.body], [400, { code: 'INVALID_OTP_CODE' }]);
  const created = await call('POST', `/mfa/totp/enrolments/${enrolmentId}/confirm`, token(me), {
    code: totpFromBase32(secret!),
    label: 'โทรศัพท์',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const firstDevice = created.body!.credentialId as string;
  assert.equal(await owner.accountTotpEnrolment.count({ where: { userId: me.id } }), 0);
  const view = await call('GET', '', token(me));
  assert.equal(view.body?.mfa.enrolled, true);
  assert.deepEqual(
    view.body?.mfa.devices.map((device: { id: string; label: string }) => [
      device.id,
      device.label,
    ]),
    [[firstDevice, 'โทรศัพท์']],
  );

  // ครบ 5 ครั้ง → 429 แม้ code ถูก
  const second = (await call('POST', '/mfa/totp/enrolments', token(me))).body as Record<
    string,
    string
  >;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await call('POST', `/mfa/totp/enrolments/${second.enrolmentId}/confirm`, token(me), {
      code: wrongCode(second.secret!),
      label: 'แท็บเล็ต',
    });
  }
  const exhausted = await call(
    'POST',
    `/mfa/totp/enrolments/${second.enrolmentId}/confirm`,
    token(me),
    {
      code: totpFromBase32(second.secret!),
      label: 'แท็บเล็ต',
    },
  );
  assert.deepEqual([exhausted.status, exhausted.body?.code], [429, 'RATE_LIMITED']);

  // หมดอายุ
  const third = (await call('POST', '/mfa/totp/enrolments', token(me))).body as Record<
    string,
    string
  >;
  await owner.accountTotpEnrolment.update({
    where: { id: third.enrolmentId },
    data: { createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1_000) },
  });
  const late = await call('POST', `/mfa/totp/enrolments/${third.enrolmentId}/confirm`, token(me), {
    code: totpFromBase32(third.secret!),
    label: 'แท็บเล็ต',
  });
  assert.deepEqual([late.status, late.body], [410, { code: 'ENROLMENT_EXPIRED' }]);

  // อุปกรณ์ที่สอง แล้วบังคับ 2FA: ลบได้จนเหลือเครื่องสุดท้าย
  const fourth = (await call('POST', '/mfa/totp/enrolments', token(me))).body as Record<
    string,
    string
  >;
  const duplicate = await call(
    'POST',
    `/mfa/totp/enrolments/${fourth.enrolmentId}/confirm`,
    token(me),
    {
      code: totpFromBase32(fourth.secret!),
      label: 'โทรศัพท์',
    },
  );
  assert.deepEqual([duplicate.status, duplicate.body?.reason], [400, 'DUPLICATE']);
  const secondDevice = (
    await call('POST', `/mfa/totp/enrolments/${fourth.enrolmentId}/confirm`, token(me), {
      code: totpFromBase32(fourth.secret!),
      label: 'แท็บเล็ต',
    })
  ).body!.credentialId as string;

  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: true });
  // ผู้ใช้อื่นลบอุปกรณ์ของคนอื่นไม่ได้
  const notMine = await call('DELETE', `/mfa/totp/${firstDevice}`, token(other));
  assert.deepEqual([notMine.status, notMine.body], [404, { code: 'DEVICE_NOT_FOUND' }]);
  assert.equal((await call('DELETE', `/mfa/totp/${firstDevice}`, token(me))).status, 204);
  const last = await call('DELETE', `/mfa/totp/${secondDevice}`, token(me));
  assert.deepEqual([last.status, last.body], [409, { code: 'MFA_REQUIRED_LAST_DEVICE' }]);
  await setPolicy(state.demo, { emailChangePolicy: 'VERIFY', mfaRequired: false });
  assert.equal((await call('DELETE', `/mfa/totp/${secondDevice}`, token(me))).status, 204);
  assert.equal((await call('GET', '', token(me))).body?.mfa.enrolled, false);
  assert.equal((await call('DELETE', `/mfa/totp/${randomUUID()}`, token(me))).status, 404);

  assert.deepEqual(
    (
      await owner.accountAuditEvent.findMany({
        where: { userId: me.id },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((event) => event.action),
    ['mfa.enrolled', 'mfa.enrolled', 'mfa.removed', 'mfa.removed'],
  );
});

test('audit ไม่มีรหัสผ่าน, secret, token หรือ email', async () => {
  const userIds = state.accounts.map((item) => item.id);
  const audit = JSON.stringify(
    await owner.accountAuditEvent.findMany({ where: { userId: { in: userIds } } }),
  );
  assert.ok(audit.length > 2);
  assert.doesNotMatch(audit, /@demo\.local|password":|Strong-Password|Another-Pass/i);
  for (const value of state.secrets) assert.ok(!audit.includes(value));
});
