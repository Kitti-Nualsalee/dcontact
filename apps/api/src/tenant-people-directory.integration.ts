import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { configuredPeopleRuntime } from './tenant-people-composition.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function readPage(response: Response) {
  assert.equal(response.status, 200);
  const value = await readObject(response);
  assert.ok(Array.isArray(value.items));
  assert.ok(value.nextCursor === null || typeof value.nextCursor === 'string');
  const items = value.items.map((raw: unknown) => {
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
    const item = Object.fromEntries(Object.entries(raw));
    assert.ok(typeof item.id === 'string');
    return { ...item, id: item.id };
  });
  return { items, nextCursor: value.nextCursor };
}

test('People directory HTTP/RLS: pagination/detail และ positive tenant authority', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'ต้องตั้ง DATABASE_URL ของ isolated fixture DB');
  assert.ok(
    process.env.APPLICATION_DATABASE_URL,
    'ต้องตั้ง APPLICATION_DATABASE_URL ที่บังคับ RLS',
  );
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID(),
    foreignTenantId = randomUUID(),
    teamId = randomUUID();
  const adminId = randomUUID(),
    secondAdminId = randomUUID(),
    protectedId = randomUUID();
  const foreignId = randomUUID();
  const slug = `directory-${tenantId}`;
  const issuer = 'https://directory-idp.test/realms/dcontact';
  let app: INestApplication | undefined;
  try {
    const principals = await application.$queryRaw<{ role: string; bypass: boolean }[]>`
      SELECT current_user AS role,(rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname=current_user`;
    assert.deepEqual(principals, [{ role: 'dcontact_app', bypass: false }]);
    for (const id of [tenantId, foreignTenantId]) {
      await owner.tenant.create({
        data: { id, name: 'Directory fixture', slug: `directory-${id}`, sipDomain: `${id}.test` },
      });
    }
    await owner.team.create({ data: { id: teamId, tenantId, name: 'ทีมสังเคราะห์' } });
    for (const id of [adminId, secondAdminId, protectedId, foreignId]) {
      await owner.user.create({
        data: {
          id,
          tenantId: id === foreignId ? foreignTenantId : tenantId,
          teamId: id === foreignId ? null : teamId,
          keycloakId: id,
          email: `${id}@example.test`,
          displayName: 'Directory fixture',
          role: 'ADMIN',
          passwordHash: '!keycloak-managed',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
    }
    for (const id of [adminId, secondAdminId, foreignId]) {
      const scope = id === foreignId ? foreignTenantId : tenantId;
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES(${scope}::uuid,${id}::uuid,${issuer},${id},'dcontact-console',${`directory-${scope}`},${scope}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','directory-fixture',${'a'.repeat(64)},'fixture-operator',now(),1,true)`;
    }
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',100,100,1,1,'fixture-operator',now(),'directory-fixture','ทดสอบ directory','[]'::jsonb)`;
    const commandId = randomUUID();
    const target = await acceptPeopleCreate(
      application,
      {
        tenantId,
        userId: adminId,
        roles: ['admin'],
        caller: { issuer, subject: adminId, clientId: 'dcontact-console', tenantSlug: slug },
      },
      {
        commandId,
        displayName: 'บัญชีใหม่',
        email: 'New.User@example.test',
        role: 'SUPERVISOR',
        teamId,
      },
    );
    @Module({
      controllers: [TenantPeopleController],
      providers: [
        { provide: TENANT_VOICE_DATABASE, useValue: application },
        { provide: TENANT_PEOPLE_READINESS, useValue: configuredPeopleRuntime({}) },
        {
          provide: OIDC_ACCESS_TOKEN_VERIFIER,
          useValue: {
            verifyAccessToken: async (token: string) => {
              if (
                !['admin', 'second-admin', 'agent', 'supervisor', 'protected', 'foreign'].includes(
                  token,
                )
              )
                throw Error('invalid fixture token');
              const userId =
                token === 'second-admin'
                  ? secondAdminId
                  : token === 'protected'
                    ? protectedId
                    : token === 'foreign'
                      ? foreignId
                      : adminId;
              const scope = token === 'foreign' ? foreignTenantId : tenantId;
              const alias = `directory-${scope}`;
              return {
                iss: issuer,
                sub: userId,
                azp: 'dcontact-console',
                tenant_id: scope,
                tenant_slug: alias,
                organization: { [alias]: { tenant_id: [scope] } },
                dc_user_id: userId,
                sid: randomUUID(),
                exp: 2_000_000_000,
                realm_access: {
                  roles: token === 'agent' || token === 'supervisor' ? [token] : ['admin'],
                },
                dc_identity_class: token === 'protected' ? 'PLATFORM_USER' : 'TENANT_USER',
              };
            },
          },
        },
        {
          provide: TENANT_LIFECYCLE,
          useValue: {
            isActive: async (id: string) =>
              !!(await application.tenant.findFirst({ where: { id, lifecycleStatus: 'ACTIVE' } })),
          },
        },
        { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
        { provide: APP_GUARD, useClass: OidcGlobalGuard },
      ],
    })
    class DirectoryModule {}
    app = await NestFactory.create(DirectoryModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice/people/users`;
    const request = (path = '', token = 'admin') =>
      fetch(base + path, { headers: { authorization: `Bearer ${token}` } });

    await suite.test(
      'list/detail คืนเฉพาะ bootstrap proof หรือ B2 lifecycle และค้น operation หลัง session ใหม่',
      async () => {
        const response = await request();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const directory = await readPage(response);
        assert.equal(directory.items.length, 3);
        assert.equal(directory.nextCursor, null);
        assert.ok(
          directory.items.every((item) => item.id !== protectedId && item.id !== foreignId),
        );
        const detail = await request(`/${target.userId}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.headers.get('cache-control'), 'no-store');
        const user = await readObject(detail);
        assert.equal(user.username, 'New.User@example.test');
        assert.equal(user.role, 'SUPERVISOR');
        assert.equal(user.teamId, teamId);
        assert.deepEqual(user.team, { id: teamId, name: 'ทีมสังเคราะห์' });
        assert.equal(user.accountState, 'PROVISIONING');
        assert.equal(user.provisioningState, 'PENDING');
        assert.equal(user.activationState, 'PENDING');
        assert.equal(user.statusRevision, 1);
        assert.equal(user.configRevision, 1);
        assert.equal(user.operationId, target.operationId);
        assert.equal(user.commandId, commandId);
        assert.equal(user.extensionRef, null);
        assert.deepEqual(
          await readObject(await request(`/${target.userId}`, 'second-admin')),
          user,
        );
        await owner.$executeRaw`UPDATE users SET config_revision=7 WHERE tenant_id=${tenantId}::uuid AND id=${target.userId}::uuid`;
        const revised = await readObject(await request(`/${target.userId}`));
        assert.equal(revised.configRevision, 7);
        assert.equal(revised.statusRevision, 1);
        for (const field of [
          'passwordHash',
          'keycloakId',
          'requestPayload',
          'credentials',
          'tenantId',
        ])
          assert.equal(field in user, false);
        const bootstrap = await readObject(await request(`/${adminId}`));
        assert.equal(bootstrap.accountState, 'UNKNOWN');
        assert.equal(bootstrap.activationState, 'UNKNOWN');
        assert.equal(bootstrap.statusRevision, null);
        assert.equal(bootstrap.operationId, null);
        assert.equal(bootstrap.commandId, null);
      },
    );

    await suite.test(
      'ปฏิเสธ role/protected caller และซ่อน target ที่ไม่มี positive proof หรือคนละ tenant',
      async () => {
        assert.equal((await request('', 'invalid')).status, 401);
        for (const token of ['agent', 'supervisor', 'protected']) {
          assert.equal((await request('', token)).status, 403);
          assert.equal((await request(`/${target.userId}`, token)).status, 403);
        }
        for (const id of [protectedId, foreignId, randomUUID()]) {
          const response = await request(`/${id}`);
          assert.equal(response.status, 404);
          assert.equal((await readObject(response)).code, 'RESOURCE_NOT_FOUND');
        }
        assert.equal((await request(`/${target.userId}`, 'foreign')).status, 404);
        for (const query of [
          '?limit=0',
          '?limit=1',
          '?limit=19',
          '?limit=101',
          '?limit=1.5',
          '?limit=bad',
          '?role=platform_admin',
          '?state=READY',
          '?tenantId=' + foreignTenantId,
        ]) {
          assert.equal((await request(query)).status, 400);
        }
      },
    );

    const expected = new Set([adminId, secondAdminId, target.userId]);
    await suite.test(
      'cursor keyset รองรับ createdAt เท่ากันและผูก tenant/actor/filter/scopeStamp',
      async () => {
        for (let index = 0; index < 21; index++) {
          const accepted = await acceptPeopleCreate(
            application,
            {
              tenantId,
              userId: adminId,
              roles: ['admin'],
              caller: { issuer, subject: adminId, clientId: 'dcontact-console', tenantSlug: slug },
            },
            {
              commandId: randomUUID(),
              displayName: 'บัญชีสำหรับ pagination',
              email: `page-${index}@example.test`,
              role: 'ADMIN',
              teamId,
            },
          );
          expected.add(accepted.userId);
        }
        await owner.$executeRaw`UPDATE users SET created_at='2026-01-01T00:00:00.000Z'::timestamptz WHERE tenant_id=${tenantId}::uuid`;
        const first = await readPage(await request('?limit=20'));
        assert.equal(first.items.length, 20);
        assert.equal(typeof first.nextCursor, 'string');
        const second = await readPage(await request(`?limit=20&cursor=${first.nextCursor}`));
        assert.equal(second.items.length, 4);
        assert.equal(second.nextCursor, null);
        assert.deepEqual(
          [...first.items, ...second.items].map((item) => item.id),
          [...expected].sort(),
        );
        for (const token of ['second-admin', 'foreign']) {
          assert.equal((await request(`?cursor=${first.nextCursor}`, token)).status, 400);
        }
        for (const filter of [`teamId=${teamId}`, 'role=ADMIN', 'state=UNKNOWN']) {
          assert.equal((await request(`?${filter}&cursor=${first.nextCursor}`)).status, 400);
        }
        for (const cursor of ['not-json', 'x'.repeat(2049)]) {
          assert.equal((await request(`?cursor=${cursor}`)).status, 400);
        }
        await owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=revision+1 WHERE tenant_id=${tenantId}::uuid AND user_id=${adminId}::uuid`;
        assert.equal((await request(`?cursor=${first.nextCursor}`)).status, 400);
        const filtered = await readPage(
          await request('?role=SUPERVISOR&state=PROVISIONING&teamId=' + teamId),
        );
        assert.deepEqual(
          filtered.items.map((item: { id: string }) => item.id),
          [target.userId],
        );
        const absentTeam = await readPage(await request('?teamId=' + randomUUID()));
        assert.deepEqual(absentTeam, { items: [], nextCursor: null });
      },
    );

    await suite.test('default20/max100 และเดินหน้าครบโดยไม่ซ้ำบัญชี', async () => {
      const defaultPage = await readPage(await request());
      assert.equal(defaultPage.items.length, 20);
      assert.equal(typeof defaultPage.nextCursor, 'string');
      const remainder = await readPage(await request('?cursor=' + defaultPage.nextCursor));
      assert.equal(remainder.items.length, 4);
      assert.equal(remainder.nextCursor, null);
      const observed = [...defaultPage.items, ...remainder.items].map(
        (item: { id: string }) => item.id,
      );
      assert.equal(new Set(observed).size, 24);
      assert.deepEqual(new Set(observed), expected);
      const maximum = await readPage(await request('?limit=100'));
      assert.equal(maximum.items.length, 24);
      assert.equal(maximum.nextCursor, null);
    });

    await suite.test('revoke positive proof มีผลต่อ caller และ target ทุก request', async () => {
      await owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=revision+1,is_active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${secondAdminId}::uuid`;
      assert.equal((await request(`/${secondAdminId}`)).status, 404);
      assert.equal((await request('', 'second-admin')).status, 403);
      const directory = await readPage(await request('?limit=100'));
      assert.equal(
        directory.items.some((item) => item.id === secondAdminId),
        false,
      );
    });
    await suite.test(
      'known legacy Agent ไม่มี B2 lifecycle แสดง UNKNOWN/read-only โดยไม่ adopt identity',
      async () => {
        const legacyId = randomUUID();
        await owner.user.create({
          data: {
            id: legacyId,
            keycloakId: legacyId,
            tenantId,
            teamId,
            email: `${legacyId}@example.test`,
            displayName: 'Legacy Agent fixture',
            role: 'AGENT',
            passwordHash: '!keycloak-managed',
          },
        });
        assert.equal((await request(`/${legacyId}`)).status, 404);
        await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES(${tenantId}::uuid,${legacyId}::uuid,${issuer},${legacyId},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','known-legacy-inventory',${'b'.repeat(64)},'fixture-operator',now(),1,true)`;
        const legacy = await readObject(await request(`/${legacyId}`));
        assert.equal(legacy.role, 'AGENT');
        assert.equal(legacy.accountState, 'UNKNOWN');
        assert.equal(legacy.activationState, 'UNKNOWN');
        assert.equal(legacy.provisioningState, 'UNKNOWN');
        assert.equal(legacy.deliveryState, 'UNKNOWN');
        assert.equal(legacy.invitationGeneration, null);
        assert.equal(legacy.invitationExpiresAt, null);
        assert.equal(legacy.operationId, null);
        assert.equal(legacy.commandId, null);
        assert.equal(legacy.statusRevision, null);
        assert.equal(
          (await readPage(await request('?limit=100'))).items.some((item) => item.id === legacyId),
          true,
        );
        const lifecycles = await owner.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM tenant_user_lifecycles WHERE tenant_id=${tenantId}::uuid AND user_id=${legacyId}::uuid`;
        assert.equal(lifecycles[0]?.count, 0n);
        await owner.$executeRaw`UPDATE tenant_voice_identity_bindings SET revision=revision+1,is_active=false WHERE tenant_id=${tenantId}::uuid AND user_id=${legacyId}::uuid`;
        assert.equal((await request(`/${legacyId}`)).status, 404);
      },
    );
  } finally {
    await app?.close();
    await application.$disconnect();
    await owner.$disconnect();
  }
});
