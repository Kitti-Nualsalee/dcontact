import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { QueueController, TENANT_QUEUE_DATABASE } from './tenant-queue-api.js';
import {
  NavigationController,
  NAVIGATION_DATABASE,
  NAVIGATION_REGISTRY,
} from './navigation-api.js';
import { NAVIGATION_APPS } from './navigation-registry.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  GATEWAY_DIAGNOSTICS,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
interface TestPayload {
  id: string;
  name: string;
  teamId: string;
  isActive: boolean;
  voiceConfigVersion: number;
  voiceWrapupPolicy: string;
  configRevision: number;
  policy: { terminalAction: string };
  code: string;
  nextCursor: string;
  items: { id: string; teamId: string; legacy: boolean; code: string | null }[];
  apps: { id: string }[];
}
type TestResponse = Omit<Response, 'json'> & { json(): Promise<TestPayload> };
const owner = new PrismaClient();
const db = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@127.0.0.1:15438/dcontact?schema=public',
    },
  },
});

test('B1 authenticated HTTP → PostgreSQL/RLS: create/readback, command, quota, scope และ row-lock race', async (t) => {
  const tenantId = randomUUID(),
    otherTenant = randomUUID(),
    teamId = randomUUID(),
    otherTeam = randomUUID(),
    foreignTeam = randomUUID();
  for (const id of [tenantId, otherTenant])
    await owner.tenant.create({
      data: { id, name: `B1 ${id}`, slug: `b1-${id}`, sipDomain: `${id}.b1.test` },
    });
  for (const [id, tenant] of [
    [teamId, tenantId],
    [otherTeam, tenantId],
    [foreignTeam, otherTenant],
  ])
    await owner.team.create({ data: { id, tenantId: tenant, name: `Team ${id}` } });
  const actors = new Map<
    string,
    {
      id: string;
      role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
      tenantId: string;
      teamId: string;
      roles: string[];
    }
  >();
  for (const [token, role, tenant, team, roles] of [
    ['admin', 'ADMIN', tenantId, teamId, ['admin']],
    ['supervisor', 'SUPERVISOR', tenantId, teamId, ['supervisor', 'admin']],
    ['agent', 'AGENT', tenantId, teamId, ['agent', 'admin']],
    ['foreign', 'ADMIN', otherTenant, foreignTeam, ['admin']],
    ['disabled', 'ADMIN', tenantId, teamId, ['admin']],
    ['unbound', 'ADMIN', tenantId, teamId, ['admin']],
  ] as const) {
    const id = randomUUID();
    await owner.user.create({
      data: {
        id,
        keycloakId: id,
        tenantId: tenant,
        teamId: team,
        email: `${id}@b1.test`,
        displayName: token,
        passwordHash: '!keycloak-managed',
        role,
        isActive: token !== 'disabled',
      },
    });
    actors.set(token, { id, role, tenantId: tenant, teamId: team, roles: [...roles] });
    if (token !== 'unbound')
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active) VALUES(${tenant}::uuid,${id}::uuid,'https://b1-idp.test/realms/dcontact',${id},'dcontact-console',${`b1-${tenant}`},${tenant}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','sandbox-bootstrap-manifest',${'a'.repeat(64)},'sandbox-operator',now(),1,true)`;
  }
  const verifyAccessToken = async (
    token: string,
  ): Promise<VerifiedOidcClaims & { iss: string }> => {
    const a = actors.get(token);
    if (!a) throw Error('invalid');
    return {
      iss: 'https://b1-idp.test/realms/dcontact',
      sub: a.id,
      azp: 'dcontact-console',
      tenant_id: a.tenantId,
      tenant_slug: `b1-${a.tenantId}`,
      organization: { [`b1-${a.tenantId}`]: { tenant_id: [a.tenantId] } },
      dc_user_id: a.id,
      sid: `session-${a.id}`,
      exp: 2_000_000_000,
      realm_access: { roles: a.roles },
    };
  };
  const verifyHuman = verifyAccessToken;
  const variants: Record<string, Record<string, unknown>> = {
    platform: { azp: 'platform-console' },
    service: { preferred_username: 'service-account-catalog' },
    orgless: { organization: undefined },
    'missing-client': { azp: undefined },
    'missing-subject': { sub: undefined },
    'missing-issuer': { iss: undefined },
    'foreign-subject': { sub: randomUUID() },
    'foreign-client': { azp: 'unregistered-service-client' },
    'protected-class': { dc_identity_class: 'PLATFORM_USER' },
    'service-link': { serviceAccountClientId: 'service-client' },
    'privileged-mapping': { resource_access: { 'realm-management': { roles: ['realm-admin'] } } },
    'platform-mapping': {
      resource_access: { 'dcontact-platform-api': { roles: ['platform_operator'] } },
    },
    'multiple-orgs': {
      organization: {
        [`b1-${tenantId}`]: { tenant_id: [tenantId] },
        foreign: { tenant_id: [otherTenant] },
      },
    },
  };
  const verify = async (token: string) => ({
    ...(await verifyHuman(Object.hasOwn(variants, token) ? 'admin' : token)),
    ...variants[token],
  });
  @Module({
    controllers: [TenantVoiceCatalogController, QueueController, NavigationController],
    providers: [
      { provide: TENANT_VOICE_DATABASE, useValue: db },
      { provide: TENANT_QUEUE_DATABASE, useValue: db },
      { provide: NAVIGATION_DATABASE, useValue: db },
      { provide: NAVIGATION_REGISTRY, useValue: NAVIGATION_APPS },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: { verifyAccessToken: verify } },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const request = (path: string, token = 'admin', body?: unknown, method = body ? 'POST' : 'GET') =>
    fetch(`${base}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as Promise<TestResponse>;
  const create = (kind = 'queues', extra: Record<string, unknown> = {}, token = 'admin') =>
    request(`tenant-voice/${kind}`, token, {
      commandId: randomUUID(),
      teamId,
      name: `Resource ${randomUUID()}`,
      ...extra,
    });
  await t.test('fail closed readiness, role จริง และ domain active', async () => {
    const response = await create();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'RESOURCE_POLICY_NOT_READY');
    assert.equal((await create('queues', {}, 'disabled')).status, 403);
    assert.equal((await create('queues', {}, 'supervisor')).status, 403);
    assert.equal((await create('queues', {}, 'agent')).status, 403);
    assert.equal((await request('tenant-voice/queues', 'bad')).status, 401);
    for (const principal of [...Object.keys(variants), 'unbound']) {
      assert.equal((await create('queues', {}, principal)).status, 403);
      const hidden = await (await request('me/navigation', principal)).json();
      assert.equal(
        hidden.apps.some((a) => a.id === 'voice-routing'),
        false,
      );
    }
    const adminNav = await (await request('me/navigation')).json();
    assert.ok(adminNav.apps.some((a) => a.id === 'voice-routing'));
    const nav = await (await request('me/navigation', 'agent')).json();
    assert.equal(
      nav.apps.some((a: { id: string }) => a.id === 'voice-routing'),
      false,
    );
  });
  await t.test(
    'positive bootstrap binding: revoked/identity drift fail closed พร้อม audit/revision',
    async () => {
      const admin = actors.get('admin')!;
      await owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=2,is_active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`;
      assert.equal((await request('tenant-voice/queues')).status, 403);
      assert.equal((await create()).status, 403);
      assert.equal(
        (await (await request('me/navigation')).json()).apps.some((a) => a.id === 'voice-routing'),
        false,
      );
      await assert.rejects(
        () =>
          owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=true WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`,
      );
      await owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=3,is_active=true WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`;
      await owner.user.update({ where: { id: admin.id }, data: { keycloakId: randomUUID() } });
      assert.equal((await request('tenant-voice/queues')).status, 403);
      await owner.user.update({ where: { id: admin.id }, data: { keycloakId: admin.id } });
      assert.equal((await request('tenant-voice/queues')).status, 200);
      const audit = await owner.$queryRaw<
        { revision: number }[]
      >`SELECT revision FROM tenant_voice_identity_binding_audit WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid ORDER BY revision`;
      assert.deepEqual(
        audit.map((r) => r.revision),
        [1, 2, 3],
      );
      const work = await owner.interaction.create({
        data: { tenantId, channel: 'VOICE', direction: 'INBOUND' },
      });
      await assert.rejects(
        () =>
          owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=4,is_active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`,
      );
      await owner.interaction.update({ where: { id: work.id }, data: { state: 'ABANDONED' } });
      const stillActive = await owner.$queryRaw<
        { revision: number; is_active: boolean }[]
      >`SELECT revision,is_active FROM tenant_voice_identity_bindings WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`;
      assert.deepEqual(stillActive, [{ revision: 3, is_active: true }]);

      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          db,
          tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=4,is_active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${admin.id}::uuid`,
        ),
      );
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          db,
          tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM tenant_voice_identity_binding_audit WHERE tenant_id=${tenantId}::uuid`,
        ),
      );
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          db,
          tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO tenant_voice_identity_bindings SELECT * FROM tenant_voice_identity_bindings WHERE tenant_id=${tenantId}::uuid`,
        ),
      );
      const hidden = await withTenantDatabaseTransaction(
        db,
        otherTenant,
        (tx) =>
          tx.$queryRaw`SELECT user_id FROM tenant_voice_identity_bindings WHERE tenant_id=${tenantId}::uuid`,
      );
      assert.deepEqual(hidden, []);
    },
  );
  await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason) VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',20,10,10,10,'test-operator',now(),'B1-TEST','isolated sandbox')`;
  let createdId = '';
  await t.test(
    'normalized create/readback + replay มี receipt/audit เดียว ไม่เปิด route',
    async () => {
      const body = { commandId: randomUUID(), teamId, name: '  Voice   ไทย 😀  ' };
      const response = await request('tenant-voice/queues', 'admin', body);
      const item = await response.json();
      assert.equal(response.status, 201, JSON.stringify(item));
      createdId = item.id;
      assert.equal(item.name, 'Voice ไทย 😀');
      assert.equal(item.isActive, false);
      assert.equal(item.voiceConfigVersion, 1);
      assert.equal(item.voiceWrapupPolicy, 'VOICE_NOTE_V1');
      assert.equal(item.configRevision, 1);
      assert.equal(item.policy.terminalAction, 'HANGUP');
      assert.deepEqual(await (await request(`tenant-voice/queues/${item.id}`)).json(), item);
      assert.deepEqual(
        await (
          await request('tenant-voice/queues', 'admin', { ...body, name: 'Voice ไทย 😀' })
        ).json(),
        item,
      );
      assert.equal(
        (await request('tenant-voice/queues', 'admin', { ...body, name: 'Different' })).status,
        409,
      );
      const command = await (await request(`tenant-voice/commands/${body.commandId}`)).json();
      assert.deepEqual(command, { state: 'SUCCEEDED', result: item });
      const logs = await owner.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND command_id=${body.commandId}::uuid AND outcome='SUCCEEDED'`;
      assert.equal(Number(logs[0].n), 1);
      const persisted = await owner.queue.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(persisted.recordingEnabled, false);
      assert.equal(persisted.transcriptionMode, 'OFF');
      assert.equal(persisted.autoQmEnabled, false);
    },
  );
  await t.test(
    'skills/code uniqueness, validation ไม่มี committed partial descriptor',
    async () => {
      const response = await create('skills', { name: 'ทักษะภาษา', code: 'LANG_TH' });
      assert.equal(response.status, 201, await response.text());
      assert.equal((await create('skills', { name: 'ชื่อใหม่', code: 'LANG_TH' })).status, 409);
      for (const extra of [
        { name: '\u0001bad' },
        { name: '😀'.repeat(121) },
        { tenantId: otherTenant },
        { teamId: foreignTeam },
      ]) {
        const r = await create('queues', extra);
        assert.equal(r.status, 'teamId' in extra ? 409 : 400);
      }
      assert.equal((await create('skills', { code: 'lowercase' })).status, 400);
    },
  );
  await t.test(
    'Supervisor เห็นเฉพาะ team, foreign detail 404 และ legacy namespace กันทางข้าม',
    async () => {
      const r = await create('queues', { teamId: otherTeam });
      const outside = await r.json();
      assert.equal(r.status, 201);
      const list = await (await request('tenant-voice/queues', 'supervisor')).json();
      assert.ok(list.items.length);
      assert.ok(list.items.every((x: { teamId: string }) => x.teamId === teamId));
      assert.equal((await request(`tenant-voice/queues/${outside.id}`, 'supervisor')).status, 404);
      assert.equal((await request(`tenant-voice/queues/${createdId}`, 'foreign')).status, 404);
      assert.deepEqual(await (await request('queues', 'agent')).json(), []);
      const legacyWrite = await request(
        `queues/${createdId}`,
        'admin',
        { isActive: true },
        'PATCH',
      );
      assert.equal(legacyWrite.status, 409, await legacyWrite.text());
      const required = await request(
        `queues/${createdId}/required-skills`,
        'admin',
        { requiredSkills: [] },
        'PUT',
      );
      assert.equal(required.status, 409);
      assert.equal(
        (await owner.queue.findUniqueOrThrow({ where: { id: createdId } })).isActive,
        false,
      );
    },
  );
  await t.test('cursor keyset ผูก live scope/filter; old code=null skill ยังอ่านได้', async () => {
    await owner.skill.create({ data: { tenantId, name: `legacy ${randomUUID()}` } });
    const first = await (await request('tenant-voice/queues?limit=1', 'supervisor')).json();
    // เพิ่มอีกหนึ่งรายการใน team เพื่อให้มีหน้าถัดไป
    await create();
    const page = await (await request('tenant-voice/queues?limit=1', 'supervisor')).json();
    assert.ok(page.nextCursor);
    const next = await (
      await request(`tenant-voice/queues?limit=1&cursor=${page.nextCursor}`, 'supervisor')
    ).json();
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal(
      (await request(`tenant-voice/skills?cursor=${page.nextCursor}`, 'supervisor')).status,
      400,
    );
    await owner.user.update({
      where: { id: actors.get('supervisor')!.id },
      data: { teamId: otherTeam },
    });
    assert.equal(
      (await request(`tenant-voice/queues?cursor=${page.nextCursor}`, 'supervisor')).status,
      400,
    );
    const skills = await (await request('tenant-voice/skills')).json();
    assert.ok(
      skills.items.some(
        (x: { legacy: boolean; code: string | null }) => x.legacy && x.code === null,
      ),
    );
    assert.equal((await request('tenant-voice/queues?limit=101')).status, 400);
    assert.equal((await request('tenant-voice/queues?cursor=%%')).status, 400);
    assert.ok(first.items.length);
  });
  await t.test('NOWAIT หลัง fence ไม่ขวาง A1 User-first หรือ implicit FK lock', async () => {
    let held!: () => void, release!: () => void;
    const locked = new Promise<void>((r) => (held = r)),
      gate = new Promise<void>((r) => (release = r));
    const blocker = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${actors.get('admin')!.id}::uuid FOR NO KEY UPDATE`;
        held();
        await gate;
      },
      { timeout: 10000 },
    );
    await locked;
    const start = Date.now();
    try {
      const r = await create();
      const b = await r.json();
      assert.equal(r.status, 409, JSON.stringify(b));
      assert.equal(b.code, 'CONFIG_BUSY');
      assert.ok(Date.now() - start < 1800);
      await assert.rejects(
        () =>
          owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=revision+1 WHERE tenant_id=${tenantId}::uuid AND user_id=${actors.get('admin')!.id}::uuid`,
      );
    } finally {
      release();
      await blocker;
    }
    assert.equal((await create()).status, 201);
  });
  await t.test(
    'runtime shared fence blocks config; quota race counts inactive and legacy',
    async () => {
      let held!: () => void, release!: () => void;
      const locked = new Promise<void>((r) => (held = r)),
        gate = new Promise<void>((r) => (release = r));
      const blocker = owner.$transaction(
        async (tx) => {
          await tx.user.update({
            where: { id: actors.get('admin')!.id },
            data: { displayName: 'runtime writer' },
          });
          held();
          await gate;
        },
        { timeout: 10000 },
      );
      await locked;
      try {
        const r = await create();
        assert.equal(r.status, 409);
        assert.equal((await r.json()).code, 'CONFIG_BUSY');
        await assert.rejects(
          () =>
            owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=revision+1 WHERE tenant_id=${tenantId}::uuid AND user_id=${actors.get('admin')!.id}::uuid`,
        );
      } finally {
        release();
        await blocker;
      }
      const count = await owner.queue.count({ where: { tenantId, channels: { has: 'VOICE' } } });
      await owner.$executeRaw`UPDATE tenant_voice_provisioning_policies SET voice_queues_limit=${count + 1},revision=revision+1 WHERE tenant_id=${tenantId}::uuid`;
      const statuses = await Promise.all([create(), create()]).then((rs) =>
        rs.map((r) => r.status),
      );
      assert.equal(statuses.filter((x) => x === 201).length, 1);
      assert.ok(statuses.some((x) => x === 409 || x === 429));
      assert.equal((await create()).status, 429);
      assert.equal(
        await owner.queue.count({ where: { tenantId, channels: { has: 'VOICE' } } }),
        count + 1,
      );
    },
  );
  await t.test('policy pin/approval revision และ caps เป็น operator authority', async () => {
    await owner.tenantPlanBinding.create({
      data: {
        tenantId,
        planCode: 'starter',
        planVersion: 1,
        snapshotDigest: 'a'.repeat(64),
        entitlements: {},
        provisioningRequestId: randomUUID(),
      },
    });
    const r = await create('skills', { code: 'STALE_POLICY' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'RESOURCE_POLICY_STALE');
    await owner.$executeRaw`UPDATE tenant_voice_provisioning_policies SET source_kind='PLAN_SNAPSHOT',source_plan_digest=${'a'.repeat(64)},revision=revision+1 WHERE tenant_id=${tenantId}::uuid`;
    assert.equal((await create('skills', { code: 'PINNED_PLAN' })).status, 201);
    const audit = await owner.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM tenant_voice_policy_audit WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(Number(audit[0].n), 3);
    await assert.rejects(
      () =>
        owner.$executeRaw`UPDATE tenant_voice_provisioning_policies SET skills_limit=1000001,revision=revision+1 WHERE tenant_id=${tenantId}::uuid`,
    );
  });
  await t.test('RLS + append-only/operator grants + no browser context bypass', async () => {
    assert.deepEqual(
      await withTenantDatabaseTransaction(
        db,
        otherTenant,
        (tx) => tx.$queryRaw`SELECT * FROM voice_config_command_receipts`,
      ),
      [],
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        db,
        tenantId,
        (tx) => tx.$executeRaw`UPDATE tenant_voice_provisioning_policies SET skills_limit=999`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        db,
        tenantId,
        (tx) => tx.$executeRaw`DELETE FROM voice_config_audit`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(db, tenantId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.voice_config_command',${randomUUID()},true)`;
        await tx.queue.update({ where: { id: createdId }, data: { isActive: true } });
      }),
    );
    const missingReceipt = randomUUID();
    // Prisma 5 อาจ resolve COMMIT ที่ deferred constraint ปฏิเสธ: ตรวจ committed state โดยตรง
    await withTenantDatabaseTransaction(
      db,
      tenantId,
      (tx) =>
        tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,command_kind) VALUES(${tenantId}::uuid,${missingReceipt}::uuid,${actors.get('admin')!.id}::uuid,'QUEUE_CREATE',${randomUUID()}::uuid,${'f'.repeat(64)},'CATALOG_CREATE')`,
    ).catch(() => undefined);
    const missing =
      await owner.$queryRaw`SELECT command_id FROM voice_config_commands WHERE tenant_id=${tenantId}::uuid AND command_id=${missingReceipt}::uuid`;
    assert.deepEqual(missing, []);
    const p = await db.$queryRaw<
      { rolbypassrls: boolean }[]
    >`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    assert.equal(p[0].rolbypassrls, false);
  });
});
