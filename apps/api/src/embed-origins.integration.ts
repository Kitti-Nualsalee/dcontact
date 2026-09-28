/**
 * E1.11 (#485) บน Postgres จริงด้วย role ของแอป (`dcontact_app`, RLS):
 * CRUD + สิทธิ์ ADMIN/SUPERVISOR, สูงสุด 10, audit ก่อน/หลัง, entitlement, `/dphone/embed` ต่อ tenant
 * (flag ปิด/ไม่มี entitlement/alias ไม่มี = 'none', tenant A ไม่ได้ allowlist ของ B), cache ≤ 30 วินาที
 * และ lease `embedded` ที่ origin ถูกปิด
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  DPHONE_EMBED_SHELL_OPTIONS,
  DphoneEmbedController,
  EMBED_ORIGIN_SERVICE,
  EmbedOriginsController,
} from './embed-origins-api.js';
import { DPHONE_EMBED_FLAG, EMBED_ENTITLEMENT, EmbedOriginService } from './embed-origins.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { WorkSessionLeases } from './work-session.js';

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

async function setup(t: TestContext) {
  const tenants = [randomUUID(), randomUUID()] as const;
  const [tenantA, tenantB] = tenants;
  const slugs = tenants.map((id) => `embed-${id.slice(0, 8)}`);
  const users = { admin: randomUUID(), supervisor: randomUUID(), agent: randomUUID() };
  await owner.tenant.createMany({
    data: tenants.map((id, index) => ({
      id,
      name: slugs[index]!,
      slug: slugs[index]!,
      sipDomain: `${id}.embed.test`,
    })),
  });
  await owner.user.createMany({
    data: [
      { id: users.admin, role: 'ADMIN' as const },
      { id: users.supervisor, role: 'SUPERVISOR' as const },
      { id: users.agent, role: 'AGENT' as const },
    ].map((user) => ({
      ...user,
      tenantId: tenantA,
      email: `${user.id}@embed.test`,
      passwordHash: 'test',
      displayName: user.role,
    })),
  });
  let clock = Date.parse('2026-09-28T09:00:00.000Z');
  const revoked: Array<[string, string]> = [];
  const make = () =>
    new EmbedOriginService(application, {
      now: () => new Date(clock),
      allowLocalhost: false,
      reservedOrigins: ['https://workspace.dcontact.test'],
      revocations: { revoked: (tenantId, origin) => revoked.push([tenantId, origin]) },
    });
  const service = make();

  @Module({
    controllers: [EmbedOriginsController, DphoneEmbedController],
    providers: [
      { provide: EMBED_ORIGIN_SERVICE, useValue: service },
      {
        provide: DPHONE_EMBED_SHELL_OPTIONS,
        useValue: { scriptUrl: 'https://workspace.dcontact.test/embed/dphone-embed.js' },
      },
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
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.agentStateLog.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantEmbedOriginAuditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantEmbedOrigin.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantPlanBinding.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.user.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  });

  const token = (role: 'admin' | 'supervisor' | 'agent', tenantId: string = tenantA) =>
    `${tenantId}|${users[role]}|${role}`;
  const call = async (method: string, path: string, auth?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        'x-correlation-id': 'corr-embed',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* HTML */
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };
  const flag = (tenantId: string, enabled: boolean) =>
    owner.tenantUiFlag.upsert({
      where: { tenantId_flagKey: { tenantId, flagKey: DPHONE_EMBED_FLAG } },
      create: {
        tenantId,
        flagKey: DPHONE_EMBED_FLAG,
        enabled,
        reason: 'E1.11 test',
        updatedByActor: 't',
      },
      update: { enabled },
    });
  const ancestors = async (alias: string) => {
    const shell = await call('GET', `/dphone/embed?tenant=${alias}`);
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get('cache-control'), 'no-store');
    return /frame-ancestors ([^;]+)$/.exec(shell.headers.get('content-security-policy')!)![1];
  };
  return {
    tenantA,
    tenantB,
    slugs,
    users,
    service,
    make,
    revoked,
    call,
    token,
    flag,
    ancestors,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const PATH = '/api/v1/tenant/embed-origins';

test('ADMIN จัดการ allowlist ได้ (normalize, ซ้ำ 409, revision 409, สูงสุด 10) พร้อม audit ก่อน/หลัง; SUPERVISOR อ่านได้อย่างเดียว; AGENT ไม่ได้', async (t) => {
  const f = await setup(t);
  const created = await f.call('POST', PATH, f.token('admin'), {
    origin: 'HTTPS://CRM.Example.test:443/',
    label: 'CRM ภายใน',
    reason: 'ทดสอบ E1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    [created.body.origin, created.body.enabled, created.body.revision],
    ['https://crm.example.test', true, 1],
  );

  const invalid = await f.call('POST', PATH, f.token('admin'), {
    origin: 'https://*.example.test',
    label: 'x',
  });
  assert.deepEqual(invalid.body, {
    code: 'VALIDATION_FAILED',
    field: 'origin',
    reason: 'WILDCARD',
  });
  assert.equal(invalid.status, 400);
  const reserved = await f.call('POST', PATH, f.token('admin'), {
    origin: 'https://workspace.dcontact.test',
    label: 'x',
  });
  assert.equal(reserved.body.reason, 'RESERVED_ORIGIN');
  const duplicate = await f.call('POST', PATH, f.token('admin'), {
    origin: 'https://crm.example.test',
    label: 'ซ้ำ',
  });
  assert.deepEqual([duplicate.status, duplicate.body.code], [409, 'EMBED_ORIGIN_DUPLICATE']);

  assert.equal((await f.call('GET', PATH, f.token('supervisor'))).status, 200);
  const supervisorWrite = await f.call('POST', PATH, f.token('supervisor'), {
    origin: 'https://other.example.test',
    label: 'x',
  });
  assert.equal(supervisorWrite.status, 403);
  assert.equal((await f.call('GET', PATH, f.token('agent'))).status, 403);

  const stale = await f.call('PATCH', `${PATH}/${created.body.id}`, f.token('admin'), {
    expectedRevision: 9,
    label: 'ใหม่',
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'REVISION_CONFLICT']);
  const renamed = await f.call('PATCH', `${PATH}/${created.body.id}`, f.token('admin'), {
    expectedRevision: 1,
    label: 'CRM ฝ่ายขาย',
  });
  assert.equal(renamed.body.revision, 2);
  const disabled = await f.call('PATCH', `${PATH}/${created.body.id}`, f.token('admin'), {
    expectedRevision: 2,
    enabled: false,
    reason: 'ปิดชั่วคราว',
  });
  assert.equal(disabled.body.enabled, false);
  assert.deepEqual(f.revoked, [[f.tenantA, 'https://crm.example.test']]);

  for (let index = 1; index < 10; index += 1) {
    const added = await f.call('POST', PATH, f.token('admin'), {
      origin: `https://crm${index}.example.test`,
      label: `CRM ${index}`,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }
  const eleventh = await f.call('POST', PATH, f.token('admin'), {
    origin: 'https://crm11.example.test',
    label: 'เกิน',
  });
  assert.deepEqual([eleventh.status, eleventh.body.code], [409, 'EMBED_ORIGIN_LIMIT_REACHED']);

  const removed = await f.call('DELETE', `${PATH}/${created.body.id}`, f.token('admin'), {
    expectedRevision: 3,
    reason: 'เลิกใช้',
  });
  assert.equal(removed.status, 204);
  const audit = await owner.tenantEmbedOriginAuditEvent.findMany({
    where: { tenantId: f.tenantA, originId: created.body.id },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepEqual(
    audit.map((row) => [
      row.action,
      (row.before as any)?.label ?? null,
      (row.after as any)?.label ?? null,
      row.reason,
    ]),
    [
      ['CREATED', null, 'CRM ภายใน', 'ทดสอบ E1'],
      ['UPDATED', 'CRM ภายใน', 'CRM ฝ่ายขาย', null],
      ['DISABLED', 'CRM ฝ่ายขาย', 'CRM ฝ่ายขาย', 'ปิดชั่วคราว'],
      ['DELETED', 'CRM ฝ่ายขาย', null, 'เลิกใช้'],
    ],
  );
  assert.ok(
    audit.every((row) => row.actorUserId === f.users.admin && row.correlationId === 'corr-embed'),
  );
});

test('/dphone/embed: ฝังได้เมื่อ flag + entitlement + origin ครบ; ขาดข้อใด/alias ไม่มี = none; tenant A ไม่ได้ allowlist ของ B', async (t) => {
  const f = await setup(t);
  await f.service.create(
    { tenantId: f.tenantA, userId: f.users.admin },
    { origin: 'https://crm-a.example.test', label: 'A' },
    'c',
  );
  await f.service.create(
    { tenantId: f.tenantB, userId: randomUUID() },
    { origin: 'https://crm-b.example.test', label: 'B' },
    'c',
  );
  // flag ยังปิด
  assert.equal(await f.ancestors(f.slugs[0]!), "'none'");
  await f.flag(f.tenantA, true);
  await f.flag(f.tenantB, true);
  f.advance(31_000);
  assert.equal(await f.ancestors(f.slugs[0]!), 'https://crm-a.example.test');
  assert.equal(await f.ancestors(f.slugs[1]!), 'https://crm-b.example.test');
  assert.equal(await f.ancestors('no-such-tenant'), "'none'");
  assert.equal(await f.ancestors('<script>'), "'none'");
  const shell = await f.call('GET', `/dphone/embed?tenant=${f.slugs[0]}`);
  assert.match(shell.body, /"allowedHostOrigins":\["https:\/\/crm-a\.example\.test"\]/);
  assert.equal(shell.body.includes('crm-b'), false);

  // plan binding ที่ไม่มี module_api_cti = ห้ามฝังและเพิ่ม origin ไม่ได้ (fail closed)
  await owner.tenantPlanBinding.create({
    data: {
      tenantId: f.tenantA,
      planCode: 'growth',
      planVersion: 1,
      snapshotDigest: 'a'.repeat(64),
      entitlements: { agent_seats: 10, [EMBED_ENTITLEMENT]: false },
      provisioningRequestId: randomUUID(),
    },
  });
  f.advance(31_000);
  assert.equal(await f.ancestors(f.slugs[0]!), "'none'");
  const denied = await f.call('POST', PATH, f.token('admin'), {
    origin: 'https://new.example.test',
    label: 'x',
  });
  assert.deepEqual([denied.status, denied.body.code], [403, 'ENTITLEMENT_REQUIRED']);
  const listed = await f.call('GET', PATH, f.token('supervisor'));
  assert.deepEqual(
    [listed.body.entitled, listed.body.flagEnabled, listed.body.limit],
    [false, true, 10],
  );
});

test('origin ใหม่ใช้ได้ภายใน 30 วินาทีแม้ instance อื่น cache ไว้; ปิด origin แล้ว lease embedded ตอนว่างถูกปล่อย', async (t) => {
  const f = await setup(t);
  await f.flag(f.tenantA, true);
  const other = f.make(); // API instance อื่นที่ cache นโยบายเก่า
  assert.deepEqual((await other.shellPolicy(f.slugs[0]!))?.origins, []);
  const origin = await f.service.create(
    { tenantId: f.tenantA, userId: f.users.admin },
    { origin: 'https://crm.example.test', label: 'CRM' },
    'c',
  );
  assert.deepEqual((await other.shellPolicy(f.slugs[0]!))?.origins, []);
  f.advance(30_001);
  assert.deepEqual((await other.shellPolicy(f.slugs[0]!))?.origins, ['https://crm.example.test']);

  const leases = new WorkSessionLeases(application, { embedOrigins: f.service });
  const actor = { tenantId: f.tenantA, userId: f.users.agent };
  const lease = await leases.acquire(
    actor,
    { surface: 'embedded', hostOrigin: 'https://crm.example.test' },
    'l1',
  );
  assert.equal(await leases.isCurrent(actor, lease.leaseId), true);
  await f.service.update(
    { tenantId: f.tenantA, userId: f.users.admin },
    origin.id,
    { expectedRevision: 1, enabled: false },
    'c2',
  );
  assert.equal(await leases.isCurrent(actor, lease.leaseId), false);
  assert.deepEqual(await leases.heartbeat(actor, lease.leaseId), {
    status: 'REVOKED',
    reason: 'origin_revoked',
  });
  const audit = await owner.agentWorkSessionEvent.findFirstOrThrow({
    where: { tenantId: f.tenantA, leaseId: lease.leaseId, action: 'ORIGIN_REVOKED' },
  });
  assert.equal(audit.hostOrigin, 'https://crm.example.test');
});
