/**
 * D1.12 (#451): Navigation API บน Postgres จริงด้วย role `dcontact_app` (NOBYPASSRLS)
 *
 * acceptance ที่ห้าม waive:
 * - role/plan ที่ต่างกันได้รายการต่างกัน และแอปที่ไม่มีสิทธิ์ไม่อยู่ใน response เลย
 * - two-tenant isolation ของหมุดผู้ใช้และค่าเริ่มต้นของ tenant
 * - เกิน 15 / revision ไม่ตรง / แอปไม่มีสิทธิ์ → error ที่กำหนด (แอปไม่มีสิทธิ์ตอบเหมือนแอปที่ไม่มีอยู่)
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
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';
import {
  NAVIGATION_DATABASE,
  NAVIGATION_REGISTRY_PROVIDER,
  NavigationController,
} from './navigation-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

type TenantKey = 'journeyPlan' | 'emptyPlan' | 'legacy';

async function harness(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenants: Record<TenantKey, string> = {
    journeyPlan: randomUUID(),
    emptyPlan: randomUUID(),
    legacy: randomUUID(),
  };
  // ผู้ใช้ id เดียวกันในสอง tenant — หมุดต้องไม่ปนกัน (PK = tenant + user)
  const sharedUserId = randomUUID();
  const otherUserId = randomUUID();

  for (const id of Object.values(tenants)) {
    await owner.tenant.create({
      data: {
        id,
        name: `D1.12 nav ${id.slice(0, 8)}`,
        slug: `d1-12-nav-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.d1-12-nav.test`,
      },
    });
  }
  const bind = (tenantId: string, entitlements: Record<string, number | boolean>) =>
    owner.tenantPlanBinding.create({
      data: {
        tenantId,
        planCode: 'growth',
        planVersion: 1,
        snapshotDigest: 'b'.repeat(64),
        entitlements,
        provisioningRequestId: randomUUID(),
      },
    });
  await bind(tenants.journeyPlan, { agent_seats: 25, module_journey: true });
  await bind(tenants.emptyPlan, { agent_seats: 5 });

  const tokens = new Map<string, { tenant: TenantKey; roles: string[]; userId: string }>([
    ['journey-admin', { tenant: 'journeyPlan', roles: ['admin'], userId: sharedUserId }],
    ['journey-agent', { tenant: 'journeyPlan', roles: ['agent'], userId: otherUserId }],
    ['journey-supervisor', { tenant: 'journeyPlan', roles: ['supervisor'], userId: randomUUID() }],
    ['empty-admin', { tenant: 'emptyPlan', roles: ['admin'], userId: randomUUID() }],
    ['legacy-admin', { tenant: 'legacy', roles: ['admin'], userId: sharedUserId }],
    ['legacy-agent', { tenant: 'legacy', roles: ['agent'], userId: randomUUID() }],
  ]);
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      const entry = tokens.get(token);
      if (!entry) throw new Error('token ไม่ถูกต้อง');
      const tenantId = tenants[entry.tenant];
      const slug = `d1-12-nav-${tenantId.slice(0, 8)}`;
      return {
        tenant_id: tenantId,
        tenant_slug: slug,
        organization: { [slug]: { tenant_id: [tenantId] } },
        azp: 'agent-desktop',
        sub: entry.userId,
        preferred_username: token,
        exp: 2_000_000_000,
        realm_access: { roles: entry.roles },
        dc_user_id: entry.userId,
        sid: `session-${token}`,
      };
    },
  };

  @Module({
    controllers: [NavigationController],
    providers: [
      { provide: NAVIGATION_DATABASE, useValue: application },
      NAVIGATION_REGISTRY_PROVIDER,
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  t.after(async () => {
    await app.close();
    const ids = Object.values(tenants);
    await owner.tenantUiFlag.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.navigationAuditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.navigationUserPins.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.navigationTenantDefaultPins.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenantPlanBinding.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const call = async (method: 'GET' | 'PUT', path: string, token: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-correlation-id': 'd1-12-test',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
  };
  const navigation = (token: string) => call('GET', 'me/navigation', token);
  const putPins = (token: string, body: unknown) => call('PUT', 'me/navigation/pins', token, body);
  const putDefault = (token: string, body: unknown) =>
    call('PUT', 'tenant/navigation/default-pins', token, body);

  return { owner, application, tenants, navigation, putPins, putDefault };
}

const appIds = (body: { apps: { id: string }[] }) => body.apps.map((app) => app.id);

test('role และ plan ต่างกันได้รายการต่างกัน และแอปที่มองไม่เห็นไม่อยู่ใน response เลย', async (t) => {
  const { navigation } = await harness(t);

  const journeyAdmin = await navigation('journey-admin');
  assert.equal(journeyAdmin.status, 200);
  assert.deepEqual(appIds(journeyAdmin.json), [
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
  ]);
  assert.ok(!journeyAdmin.text.includes('contact-governance'), 'plan ไม่รวม governance');
  assert.ok(!journeyAdmin.text.includes('navigation.apps.contactGovernance'));
  assert.deepEqual(
    journeyAdmin.json.groups.map((group: { id: string }) => group.id),
    ['live', 'automation'],
  );
  assert.deepEqual(journeyAdmin.json.apps[2], {
    id: 'journeys',
    groupId: 'automation',
    labelKey: 'navigation.apps.journeys',
    hostApp: 'console',
    path: '/?view=journeys',
  });

  const journeyAgent = await navigation('journey-agent');
  assert.deepEqual(appIds(journeyAgent.json), ['agent-workspace']);
  for (const hidden of ['supervisor-workspace', 'journeys', 'contact-governance']) {
    assert.ok(!journeyAgent.text.includes(hidden), `agent ต้องไม่เห็น ${hidden}`);
  }
  assert.equal(journeyAgent.json.tenantDefaultPins, undefined, 'เฉพาะ ADMIN');

  const emptyAdmin = await navigation('empty-admin');
  assert.deepEqual(appIds(emptyAdmin.json), ['agent-workspace', 'supervisor-workspace']);

  // tenant ที่ไม่มี plan binding (ก่อน A1) — role อย่างเดียว (ตัดสินใน #451)
  const legacyAdmin = await navigation('legacy-admin');
  assert.deepEqual(appIds(legacyAdmin.json), [
    'agent-workspace',
    'supervisor-workspace',
    'journeys',
    'contact-governance',
  ]);
  assert.deepEqual(legacyAdmin.json.pins, {
    appIds: ['agent-workspace', 'supervisor-workspace', 'journeys', 'contact-governance'],
    source: 'SYSTEM',
    revision: 0,
  });
  assert.deepEqual(legacyAdmin.json.limits, { maxPins: 15 });
  assert.deepEqual(legacyAdmin.json.features, { shellV2: false }, 'flag ปิดโดย default');
});

test('ui.shell.v2 เป็นของ tenant: เปิดให้ tenant หนึ่งไม่กระทบอีก tenant และแอปเขียน flag เองไม่ได้', async (t) => {
  const { owner, application, navigation, tenants } = await harness(t);
  await owner.tenantUiFlag.create({
    data: {
      tenantId: tenants.journeyPlan,
      flagKey: 'ui.shell.v2',
      enabled: true,
      reason: 'D1.13 test',
      updatedByActor: 'test',
    },
  });

  assert.deepEqual((await navigation('journey-agent')).json.features, { shellV2: true });
  assert.deepEqual((await navigation('legacy-admin')).json.features, { shellV2: false });

  await assert.rejects(
    withTenantDatabaseTransaction(application, tenants.legacy, (tx) =>
      tx.tenantUiFlag.create({
        data: {
          tenantId: tenants.legacy,
          flagKey: 'ui.shell.v2',
          enabled: true,
          reason: 'self-enable',
          updatedByActor: 'app',
        },
      }),
    ),
    /permission denied/,
  );
});

test('หมุดผู้ใช้: revision, เพดาน 15, แอปไม่มีสิทธิ์ตอบเหมือนแอปที่ไม่มีอยู่', async (t) => {
  const { navigation, putPins } = await harness(t);

  const created = await putPins('journey-admin', {
    appIds: ['journeys', 'agent-workspace'],
    expectedRevision: 0,
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json, { appIds: ['journeys', 'agent-workspace'], revision: 1 });
  assert.deepEqual((await navigation('journey-admin')).json.pins, {
    appIds: ['journeys', 'agent-workspace'],
    source: 'USER',
    revision: 1,
  });

  const stale = await putPins('journey-admin', { appIds: [], expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, { code: 'REVISION_CONFLICT', safeParams: { currentRevision: 1 } });
  const staleUpdate = await putPins('journey-admin', { appIds: [], expectedRevision: 7 });
  assert.equal(staleUpdate.status, 409);

  const updated = await putPins('journey-admin', { appIds: [], expectedRevision: 1 });
  assert.deepEqual(updated.json, { appIds: [], revision: 2 });

  const tooMany = await putPins('journey-admin', {
    appIds: Array.from({ length: 16 }, (_, i) => `app-${i}`),
    expectedRevision: 2,
  });
  assert.equal(tooMany.status, 422);
  assert.deepEqual(tooMany.json, { code: 'PIN_LIMIT_EXCEEDED', safeParams: { limit: 15 } });

  const hidden = await putPins('journey-admin', {
    appIds: ['contact-governance'],
    expectedRevision: 2,
  });
  const unknown = await putPins('journey-admin', { appIds: ['no-such-app'], expectedRevision: 2 });
  assert.equal(hidden.status, 422);
  assert.deepEqual(hidden.json, { code: 'APP_NOT_AVAILABLE', safeParams: { field: 'appIds' } });
  assert.equal(unknown.status, hidden.status);
  assert.equal(unknown.text, hidden.text, 'ห้ามเปิดเผยว่าแอปที่ไม่มีสิทธิ์มีอยู่');

  // agent ปักแอปของ supervisor ไม่ได้ ถึงแอปจะอยู่ใน plan
  const agentPinsSupervisor = await putPins('journey-agent', {
    appIds: ['supervisor-workspace'],
    expectedRevision: 0,
  });
  assert.equal(agentPinsSupervisor.status, 422);

  for (const body of [
    { appIds: ['agent-workspace', 'agent-workspace'], expectedRevision: 2 },
    { appIds: 'agent-workspace', expectedRevision: 2 },
    { appIds: [], expectedRevision: -1 },
    { appIds: [], expectedRevision: 2, tenantId: 'x' },
  ]) {
    const malformed = await putPins('journey-admin', body);
    assert.equal(malformed.status, 400, JSON.stringify(body));
    assert.equal(malformed.json.code, 'REQUEST_MALFORMED');
  }
  assert.equal(
    (await navigation('journey-admin')).json.pins.revision,
    2,
    'คำขอที่ปฏิเสธไม่แตะข้อมูล',
  );
});

test('คำขอพร้อมกันที่ revision เดียวกัน สำเร็จได้คำขอเดียว', async (t) => {
  const { putPins } = await harness(t);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      putPins('journey-supervisor', { appIds: ['agent-workspace'], expectedRevision: 0 }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
});

test('ค่าเริ่มต้นของ tenant: ADMIN เท่านั้น, audit, ผู้ใช้ใหม่เห็นชุดนี้ และผู้ใช้ปรับทับได้', async (t) => {
  const { owner, navigation, putDefault, putPins, tenants } = await harness(t);

  const byAgent = await putDefault('journey-agent', { appIds: [], expectedRevision: 0 });
  assert.equal(byAgent.status, 403);

  const notEntitled = await putDefault('journey-admin', {
    appIds: ['contact-governance'],
    expectedRevision: 0,
  });
  assert.equal(notEntitled.status, 422);
  assert.equal(notEntitled.json.code, 'APP_NOT_AVAILABLE');

  // ADMIN ใส่แอปของ supervisor ในชุดเริ่มต้นได้ (ตาม plan) — agent ที่อ่านจะถูกกรองออกเอง
  const saved = await putDefault('journey-admin', {
    appIds: ['journeys', 'agent-workspace'],
    expectedRevision: 0,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { appIds: ['journeys', 'agent-workspace'], revision: 1 });

  assert.deepEqual((await navigation('journey-agent')).json.pins, {
    appIds: ['agent-workspace'],
    source: 'TENANT',
    revision: 0,
  });
  assert.deepEqual((await navigation('journey-admin')).json.tenantDefaultPins, {
    appIds: ['journeys', 'agent-workspace'],
    revision: 1,
  });

  const stale = await putDefault('journey-admin', { appIds: [], expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json.safeParams, { currentRevision: 1 });

  await putPins('journey-agent', { appIds: [], expectedRevision: 0 });
  assert.deepEqual((await navigation('journey-agent')).json.pins.source, 'USER');

  const audit = await owner.navigationAuditEvent.findMany({
    where: { tenantId: tenants.journeyPlan },
  });
  assert.equal(audit.length, 1, 'คำขอที่ถูกปฏิเสธไม่เขียน audit');
  assert.equal(audit[0]!.action, 'TENANT_DEFAULT_PINS_UPDATED');
  assert.equal(audit[0]!.correlationId, 'd1-12-test');
  assert.deepEqual(audit[0]!.details, {
    beforeAppIds: null,
    afterAppIds: ['journeys', 'agent-workspace'],
    revision: 1,
  });
});

test('two-tenant isolation: หมุดและค่าเริ่มต้นไม่ข้าม tenant แม้ user id เดียวกัน', async (t) => {
  const { navigation, putPins, putDefault } = await harness(t);

  await putPins('journey-admin', { appIds: ['journeys'], expectedRevision: 0 });
  await putDefault('journey-admin', { appIds: ['journeys'], expectedRevision: 0 });

  const legacy = await navigation('legacy-admin');
  assert.equal(legacy.json.pins.source, 'SYSTEM');
  assert.equal(legacy.json.pins.revision, 0);
  assert.deepEqual(legacy.json.tenantDefaultPins, { appIds: [], revision: 0 });
  assert.equal((await navigation('legacy-agent')).json.pins.source, 'SYSTEM');

  // user id เดียวกันใน tenant อื่นเริ่มที่ revision 0 ของตัวเอง
  const ownRow = await putPins('legacy-admin', {
    appIds: ['contact-governance'],
    expectedRevision: 0,
  });
  assert.equal(ownRow.status, 200);
  assert.deepEqual((await navigation('journey-admin')).json.pins.appIds, ['journeys']);
});

test('audit เป็น append-only สำหรับ role ของแอป และ RLS ซ่อนแถวของ tenant อื่น', async (t) => {
  const { application, putDefault, tenants } = await harness(t);
  await putDefault('journey-admin', { appIds: [], expectedRevision: 0 });

  for (const statement of [
    `UPDATE navigation_audit_events SET action = action`,
    `DELETE FROM navigation_audit_events`,
  ]) {
    await assert.rejects(
      withTenantDatabaseTransaction(application, tenants.journeyPlan, (tx) =>
        tx.$executeRawUnsafe(statement),
      ),
      /permission denied/,
      statement,
    );
  }
  const own = await withTenantDatabaseTransaction(application, tenants.journeyPlan, (tx) =>
    tx.navigationTenantDefaultPins.count(),
  );
  const fromOtherTenant = await withTenantDatabaseTransaction(application, tenants.legacy, (tx) =>
    Promise.all([
      tx.navigationTenantDefaultPins.count({ where: { tenantId: tenants.journeyPlan } }),
      tx.navigationAuditEvent.count({ where: { tenantId: tenants.journeyPlan } }),
    ]),
  );
  assert.equal(own, 1);
  assert.deepEqual(fromOtherTenant, [0, 0], 'RLS ซ่อนแถวของ tenant อื่นแม้ระบุ tenantId ตรง');
});
