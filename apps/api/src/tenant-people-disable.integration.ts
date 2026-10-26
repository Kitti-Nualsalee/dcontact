import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { acceptPeopleDisable, runPeopleDisable } from './tenant-people-disable.js';
import type { TenantPeopleDisablePort } from './tenant-people-disable-keycloak.js';
import type { VoiceActor } from './tenant-voice-catalog.js';
import { readPeopleOperation } from './tenant-people-operations.js';
import { readPeopleDirectory } from './tenant-people-directory.js';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test('disable แบบ idle ปิด local admission ทันที และ reconcile ไม่ส่ง mutation ซ้ำ', async () => {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const workerUrl = new URL(process.env.DATABASE_URL!);
  const principal = `disable_${randomUUID().replaceAll('-', '')}`;
  workerUrl.username = principal;
  workerUrl.password = randomUUID();
  workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    adminId = randomUUID(),
    userId = randomUUID();
  const slug = `b6-${tenantId}`;
  const actor: VoiceActor = {
    tenantId,
    userId: adminId,
    roles: ['admin'],
    caller: {
      issuer: 'https://b6-idp.test/realms/dcontact',
      subject: adminId,
      clientId: 'dcontact-console',
      tenantSlug: slug,
    },
  };
  let mutations = 0,
    reads = 0,
    probes = 0,
    complete = false;
  const reserved = () =>
    withTenantDatabaseTransaction(
      application,
      tenantId,
      (transaction) =>
        transaction.$queryRaw<
          { count: number }[]
        >`SELECT dc_people_reserved_accounts(${tenantId}::uuid,false)::integer AS count`,
    );
  const provider: TenantPeopleDisablePort = {
    async probe() {
      probes++;
      return { outcome: 'READY' };
    },
    async disable() {
      mutations++;
      return { outcome: 'UNKNOWN' };
    },
    async readOutcome(attempt) {
      reads++;
      return complete
        ? {
            outcome: 'SUCCEEDED',
            reasonCode: 'DISABLED',
            identityId: attempt.identityId,
            receiptRef: 'b'.repeat(64),
          }
        : { outcome: 'UNKNOWN' };
    },
  };
  let app: INestApplication | undefined;
  let runtime: TenantPeopleRuntime | undefined;
  try {
    await owner.$executeRawUnsafe(
      `CREATE ROLE "${principal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${workerUrl.password}'`,
    );
    await owner.$executeRawUnsafe(`GRANT dcontact_tenant_people_worker TO "${principal}"`);
    await owner.tenant.create({
      data: { id: tenantId, name: 'B6 isolated disable', slug, sipDomain: `${slug}.test` },
    });
    await owner.team.create({ data: { id: teamId, tenantId, name: 'B6 team' } });
    for (const [id, role] of [
      [adminId, 'ADMIN'],
      [userId, 'AGENT'],
    ] as const) {
      await owner.user.create({
        data: {
          id,
          tenantId,
          teamId,
          keycloakId: id,
          email: `${id}@b6.test`,
          displayName: 'B6 fixture',
          role,
          passwordHash: '!keycloak-managed',
        },
      });
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES(${tenantId}::uuid,${id}::uuid,${actor.caller!.issuer},${id},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-b6',${'a'.repeat(64)},'sandbox-operator',now(),1,true)`;
    }
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',5,3,3,3,'sandbox-operator',now(),'isolated-b6','ทดสอบปิดบัญชี','[]'::jsonb)`;
    await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,${principal},'isolated-b6')`;
    const command = {
      commandId: randomUUID(),
      expectedRevision: 1,
      reasonCode: 'OPERATOR_REQUEST',
      reason: 'ทดสอบปิดบัญชี fixture',
    };
    const queue = await owner.queue.create({
      data: { tenantId, teamId, name: 'B6 busy fixture', channels: ['VOICE', 'EMAIL'] },
    });
    for (const channel of ['VOICE', 'EMAIL'] as const) {
      for (const state of ['QUEUED', 'ASSIGNED', 'ACTIVE', 'WRAPUP'] as const) {
        const interaction = await owner.interaction.create({
          data: {
            tenantId,
            queueId: queue.id,
            agentId: userId,
            channel,
            direction: 'INBOUND',
            state,
          },
        });
        await assert.rejects(
          acceptPeopleDisable(
            application,
            actor,
            userId,
            { ...command, commandId: randomUUID() },
            provider,
          ),
          (error: unknown) => {
            assert.ok(error instanceof HttpException);
            assert.equal(error.getStatus(), 409);
            assert.match(JSON.stringify(error.getResponse()), /CONFIG_BUSY/);
            return true;
          },
        );
        assert.equal(
          (await owner.user.findUniqueOrThrow({ where: { id: userId } })).isActive,
          true,
        );
        await owner.interaction.update({
          where: { id: interaction.id },
          data: { state: 'COMPLETED' },
        });
      }
    }
    probes = 0;
    let disableReady = false;
    @Module({
      controllers: [TenantPeopleController, TenantVoiceCatalogController],
      providers: [
        { provide: TENANT_VOICE_DATABASE, useValue: application },
        {
          provide: TENANT_PEOPLE_READINESS,
          useValue: {
            isReady: async () => false,
            canDisable: async () => disableReady,
            disablePortForTenant: () => provider,
          },
        },
        {
          provide: OIDC_ACCESS_TOKEN_VERIFIER,
          useValue: {
            verifyAccessToken: async (token: string) => {
              if (!['admin', 'agent', 'protected'].includes(token))
                throw Error('invalid fixture token');
              return {
                iss: actor.caller!.issuer,
                sub: adminId,
                azp: actor.caller!.clientId,
                tenant_id: tenantId,
                tenant_slug: slug,
                organization: { [slug]: { tenant_id: [tenantId] } },
                dc_user_id: adminId,
                sid: 'b6-fixture',
                exp: 2_000_000_000,
                realm_access: { roles: token === 'agent' ? ['agent'] : ['admin'] },
                dc_identity_class: token === 'protected' ? 'PLATFORM_USER' : 'TENANT_USER',
              };
            },
          },
        },
        { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
        { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
        { provide: APP_GUARD, useClass: OidcGlobalGuard },
      ],
    })
    class TestModule {}
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice`;
    const request = (path: string, body?: unknown, token = 'admin') =>
      fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    assert.equal((await request(`/people/users/${userId}/disable`, command)).status, 503);
    disableReady = true;
    assert.equal(
      (await request(`/people/users/${userId}/disable`, command, 'invalid')).status,
      401,
    );
    assert.equal((await request(`/people/users/${userId}/disable`, command, 'agent')).status, 403);
    assert.equal(
      (await request(`/people/users/${userId}/disable`, command, 'protected')).status,
      403,
    );
    assert.equal((await request(`/people/users/${randomUUID()}/disable`, command)).status, 404);
    assert.equal(
      (await request(`/people/users/${userId}/disable`, { ...command, tenantId })).status,
      400,
    );
    const capabilities = await readObject(await request('/capabilities'));
    assert.deepEqual(capabilities.disable, { ready: true, reasons: [] });
    const leaseId = randomUUID();
    await owner.agentWorkSessionLease.create({
      data: {
        id: leaseId,
        tenantId,
        userId,
        surface: 'workspace',
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await owner.agentSipCredential.create({
      data: {
        workSessionLeaseId: leaseId,
        tenantId,
        userId,
        extension: '1104',
        sipDomain: `${slug}.test`,
        telephonyNodeId: 'b6-node',
        a1Hash: '0'.repeat(32),
        issuedAt: new Date(),
      },
    });
    const response = await request(`/people/users/${userId}/disable`, command);
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const received = await readObject(response);
    assert.equal(typeof received.operationId, 'string');
    assert.ok(typeof received.operationId === 'string' && typeof received.location === 'string');
    const accepted = {
      operationId: received.operationId,
      userId,
      status: 'ACCEPTED' as const,
      accountState: 'DISABLING' as const,
      location: received.location,
    };
    assert.equal(response.headers.get('location'), accepted.location);
    assert.equal(accepted.accountState, 'DISABLING');
    const user = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.isActive, false);
    assert.equal(user.configRevision, 2);
    assert.equal(
      (await owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: leaseId } }))
        .releaseReason,
      'auth_revoked',
    );
    assert.ok(
      (await owner.agentSipCredential.findUniqueOrThrow({ where: { workSessionLeaseId: leaseId } }))
        .revokedAt,
    );
    assert.equal((await reserved())[0].count, 2);
    assert.equal(
      (await readPeopleOperation(application, actor, accepted.operationId)).accountState,
      'DISABLING',
    );
    const disabling = await readPeopleDirectory(application, actor, {}, userId);
    assert.ok('accountState' in disabling);
    assert.equal(disabling.accountState, 'DISABLING');
    assert.deepEqual(
      await acceptPeopleDisable(application, actor, userId, command, provider),
      accepted,
    );
    assert.equal(probes, 1);
    assert.equal(
      await runPeopleDisable(
        worker,
        provider,
        { async flush() {} },
        tenantId,
        accepted.operationId,
      ),
      'ACTION_REQUIRED',
    );
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: userId } })).isActive, false);
    complete = true;
    assert.equal(
      await runPeopleDisable(
        worker,
        provider,
        { async flush() {} },
        tenantId,
        accepted.operationId,
      ),
      'ACTION_REQUIRED',
    );
    assert.equal((await reserved())[0].count, 2);
    await owner.dlVoiceAuditEvent.create({
      data: {
        tenantId,
        eventId: `e1-sandbox:sip.registration.flush:${leaseId}`,
        code: 'E1_SANDBOX_REGISTRATION_FLUSHED',
        actorRef: 'system:e1-sandbox',
        subjectId: leaseId,
        occurredAt: new Date(),
      },
    });
    assert.equal(
      await runPeopleDisable(
        worker,
        provider,
        { async flush() {} },
        tenantId,
        accepted.operationId,
      ),
      'SUCCEEDED',
    );
    assert.equal(mutations, 1);
    assert.equal(reads, 3);
    assert.equal(
      (await readPeopleOperation(application, actor, accepted.operationId)).accountState,
      'DISABLED',
    );
    const disabled = await readPeopleDirectory(application, actor, {}, userId);
    assert.ok('accountState' in disabled);
    assert.equal(disabled.accountState, 'DISABLED');
    assert.equal((await reserved())[0].count, 1);
    assert.equal(
      await runPeopleDisable(
        worker,
        provider,
        { async flush() {} },
        tenantId,
        accepted.operationId,
      ),
      'NOT_ELIGIBLE',
    );
    const rejectedProvider: TenantPeopleDisablePort = {
      async probe() {
        return { outcome: 'READY' };
      },
      async disable(attempt) {
        return {
          outcome: 'REJECTED_NO_EFFECT',
          reasonCode: 'LAST_USABLE_ADMIN',
          receiptRef: 'c'.repeat(64),
          identityId: attempt.identityId,
        };
      },
      async readOutcome() {
        assert.fail('fresh rejection must not need reconciliation');
      },
    };
    const selfCommand = { ...command, commandId: randomUUID() };
    const selfDisable = await acceptPeopleDisable(
      application,
      actor,
      adminId,
      selfCommand,
      rejectedProvider,
    );
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: adminId } })).isActive, false);
    assert.equal(
      await runPeopleDisable(
        worker,
        rejectedProvider,
        { async flush() {} },
        tenantId,
        selfDisable.operationId,
      ),
      'REJECTED',
    );
    const restored = await owner.user.findUniqueOrThrow({ where: { id: adminId } });
    assert.equal(restored.isActive, true);
    assert.equal(restored.configRevision, 3);
    await assert.rejects(
      runPeopleDisable(worker, provider, { async flush() {} }, randomUUID(), accepted.operationId),
      /SCOPE_DENIED/,
    );
    const unknownProvider: TenantPeopleDisablePort = {
      ...provider,
      async probe() {
        return { outcome: 'UNKNOWN' };
      },
    };
    await assert.rejects(
      acceptPeopleDisable(
        application,
        actor,
        adminId,
        { ...command, commandId: randomUUID(), expectedRevision: 3 },
        unknownProvider,
      ),
      (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 503);
        assert.match(JSON.stringify(error.getResponse()), /IDENTITY_UNAVAILABLE/);
        return true;
      },
    );
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: adminId } })).isActive, true);
    const mismatchedProvider: TenantPeopleDisablePort = {
      ...provider,
      async disable() {
        return {
          outcome: 'SUCCEEDED',
          reasonCode: 'DISABLED',
          identityId: randomUUID(),
          receiptRef: 'd'.repeat(64),
        };
      },
    };
    const mismatched = await acceptPeopleDisable(
      application,
      actor,
      adminId,
      { ...command, commandId: randomUUID(), expectedRevision: 3 },
      mismatchedProvider,
    );
    runtime = new TenantPeopleRuntime(
      worker,
      new Map([
        [
          tenantId,
          {
            async isReady() {
              return true;
            },
            async mutateStep() {
              assert.fail('disable scheduler must not provision');
            },
            async readOutcome() {
              assert.fail('disable scheduler must not reconcile provisioning');
            },
          },
        ],
      ]),
      {
        intervalMs: 60_000,
        disables: new Map([
          [
            tenantId,
            {
              ...mismatchedProvider,
              async isReady() {
                return true;
              },
            },
          ],
        ]),
        disableFlush: { async flush() {} },
      },
    );
    assert.equal(await runtime.canDisable(tenantId), false);
    runtime.onModuleInit();
    await runtime.runOnce();
    const [scheduled] = await owner.$queryRaw<
      { state: string }[]
    >`SELECT state FROM tenant_people_disables WHERE tenant_id=${tenantId}::uuid AND id=${mismatched.operationId}::uuid`;
    assert.equal(scheduled.state, 'ACTION_REQUIRED');
    assert.equal(await runtime.canDisable(tenantId), true);
    await runtime.onModuleDestroy();
    assert.equal(await runtime.canDisable(tenantId), false);
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: adminId } })).isActive, false);
  } finally {
    await runtime?.onModuleDestroy();
    await app?.close();
    await Promise.all([owner.$disconnect(), application.$disconnect(), worker.$disconnect()]);
  }
});
