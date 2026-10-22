import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  GATEWAY_DIAGNOSTICS,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
interface Payload {
  id: string;
  code: string;
  configRevision: number;
  name: string;
  nextCursor: string;
  result: unknown;
  items: { id: string; teamId: string; email?: unknown }[];
  candidates: { userId: string; available: boolean; eligible: boolean }[];
}
type TestResponse = Omit<Response, 'json'> & { json(): Promise<Payload> };

test('B4 authenticated HTTP/PostgreSQL: atomic config, receipts, scoped projections and NOWAIT legacy closure', async (context) => {
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
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    otherTeam = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'B4 integration',
      slug: `b4-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  for (const id of [teamId, otherTeam])
    await owner.team.create({ data: { id, tenantId, name: id } });
  const admin = randomUUID(),
    supervisor = randomUUID(),
    agent = randomUUID(),
    pending = randomUUID(),
    outsider = randomUUID();
  for (const [id, role, team, isActive] of [
    [admin, 'ADMIN', teamId, true],
    [supervisor, 'SUPERVISOR', teamId, true],
    [agent, 'AGENT', teamId, true],
    [pending, 'AGENT', teamId, false],
    [outsider, 'AGENT', otherTeam, true],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId,
        teamId: team,
        keycloakId: id,
        role,
        email: `${id}@b4.test`,
        displayName: id,
        passwordHash: '!keycloak-managed',
        isActive,
        extension: role === 'AGENT' ? String(4000 + [agent, pending, outsider].indexOf(id)) : null,
      },
    });
    if (role !== 'AGENT')
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active) VALUES(${tenantId}::uuid,${id}::uuid,'https://b4.test/realms/dcontact',${id},'dcontact-console',${`b4-${tenantId}`},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','sandbox',${'a'.repeat(64)},'sandbox',now(),1,true)`;
  }
  await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason) VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',30,20,20,20,'sandbox',now(),'B4','sandbox')`;
  const operationId = randomUUID(),
    commandId = randomUUID();
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,command_kind) VALUES(${tenantId}::uuid,${commandId}::uuid,${admin}::uuid,'CREATE_TENANT_USER',${pending}::uuid,${'b'.repeat(64)},'PEOPLE_CREATE')`;
    await tx.$executeRaw`INSERT INTO tenant_people_operations(tenant_id,id,command_id,actor_user_id,target_user_id,action,payload_digest,request_payload,correlation_id,state) VALUES(${tenantId}::uuid,${operationId}::uuid,${commandId}::uuid,${admin}::uuid,${pending}::uuid,'CREATE_TENANT_USER',${'b'.repeat(64)},'{}',${randomUUID()}::uuid,'SUCCEEDED')`;
    await tx.$executeRaw`INSERT INTO tenant_user_lifecycles(tenant_id,user_id,operation_id,creation_role,creation_team_id,account_state) VALUES(${tenantId}::uuid,${pending}::uuid,${operationId}::uuid,'AGENT',${teamId}::uuid,'PENDING_ACTIVATION')`;
    await tx.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${tenantId}::uuid,${commandId}::uuid,'{}')`;
  });
  @Module({
    controllers: [TenantVoiceCatalogController],
    providers: [
      { provide: TENANT_VOICE_DATABASE, useValue: db },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (token: string) => {
            const id = token === 'admin' ? admin : token === 'supervisor' ? supervisor : agent;
            return {
              iss: 'https://b4.test/realms/dcontact',
              sub: id,
              azp: 'dcontact-console',
              tenant_id: tenantId,
              tenant_slug: `b4-${tenantId}`,
              organization: { [`b4-${tenantId}`]: { tenant_id: [tenantId] } },
              dc_user_id: id,
              sid: `session-${id}`,
              exp: 2_000_000_000,
              realm_access: { roles: [token] },
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
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  context.after(async () => {
    await app.close();
    await db.$disconnect();
    await owner.$disconnect();
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice`;
  const request = (path: string, method = 'GET', body?: unknown, token = 'admin') =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as Promise<TestResponse>;
  const envelope = (expectedRevision = 1) => ({
    commandId: randomUUID(),
    expectedRevision,
    reasonCode: 'CONFIG_CHANGE',
    reason: 'เตรียมทีมทดสอบ',
  });
  const create = async (kind: 'queues' | 'skills', team = teamId) => {
    const result = await request(`/${kind}`, 'POST', {
      commandId: randomUUID(),
      name: randomUUID(),
      teamId: team,
      ...(kind === 'skills' ? { code: `S${randomUUID().replaceAll('-', '').toUpperCase()}` } : {}),
    });
    assert.equal(result.status, 201, await result.clone().text());
    return result.json() as Promise<{ id: string }>;
  };
  const queue = await create('queues'),
    skill = await create('skills'),
    foreignSkill = await create('skills', otherTeam);
  await context.test(
    'set replacement, committed replay, stale and mismatch preserve state',
    async () => {
      const command = { ...envelope(), items: [{ skillId: skill.id, minLevel: 3 }] };
      const result = await request(`/queues/${queue.id}/required-skills`, 'PUT', command);
      assert.equal(result.status, 200, await result.clone().text());
      const committed = await result.json();
      assert.equal(committed.configRevision, 2);
      assert.deepEqual(
        await (await request(`/queues/${queue.id}/required-skills`, 'PUT', command)).json(),
        committed,
      );
      const changed = await request(`/queues/${queue.id}/required-skills`, 'PUT', {
        ...command,
        items: [],
      });
      assert.equal((await changed.json()).code, 'COMMAND_PAYLOAD_MISMATCH');
      const stale = await request(`/queues/${queue.id}/required-skills`, 'PUT', {
        ...envelope(),
        items: [],
      });
      assert.equal((await stale.json()).code, 'REVISION_CONFLICT');
      const invalid = await request(`/queues/${queue.id}/required-skills`, 'PUT', {
        ...envelope(2),
        items: [{ skillId: foreignSkill.id, minLevel: 1 }],
      });
      assert.equal((await invalid.json()).code, 'REFERENCE_SCOPE_MISMATCH');
      assert.deepEqual(
        await (await request(`/queues/${queue.id}/required-skills`)).json(),
        committed,
      );
      const recovery = await (await request(`/commands/${command.commandId}`)).json();
      assert.deepEqual(recovery.result, committed);
      const audits = await owner.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND command_id=${command.commandId}::uuid AND outcome='SUCCEEDED'`;
      assert.equal(Number(audits[0].count), 1);
    },
  );
  await context.test(
    'assignment levels, pending activation and Supervisor projection',
    async () => {
      for (const id of [agent, pending]) {
        const result = await request(`/people/users/${id}/skills`, 'PUT', {
          ...envelope(),
          items: [{ skillId: skill.id, level: id === agent ? 3 : 5 }],
        });
        assert.equal(result.status, 200, await result.clone().text());
      }
      await owner.agentStateLog.create({ data: { tenantId, userId: agent, state: 'AVAILABLE' } });
      await owner.agentStateLog.create({ data: { tenantId, userId: pending, state: 'AVAILABLE' } });
      const eligibility = await (await request(`/eligibility?queueId=${queue.id}`)).json();
      assert.equal(
        eligibility.candidates.find((item: { userId: string }) => item.userId === agent)?.available,
        true,
      );
      assert.equal(
        eligibility.candidates.find((item: { userId: string }) => item.userId === pending)
          ?.eligible,
        false,
      );
      const roster = await (await request('/people/roster', 'GET', undefined, 'supervisor')).json();
      assert.ok(
        roster.items.every(
          (item: { teamId: string; email?: unknown }) =>
            item.teamId === teamId && item.email === undefined,
        ),
      );
      assert.equal(
        (await request(`/people/users/${outsider}/skills`, 'GET', undefined, 'supervisor')).status,
        404,
      );
      assert.equal(
        (
          await request(
            `/people/users/${agent}/skills`,
            'PUT',
            { ...envelope(2), items: [] },
            'supervisor',
          )
        ).status,
        403,
      );
      const page = await (
        await request('/people/roster?limit=1', 'GET', undefined, 'supervisor')
      ).json();
      assert.ok(page.nextCursor);
      assert.equal(
        (
          await request(
            `/people/roster?limit=1&cursor=${page.nextCursor}`,
            'GET',
            undefined,
            'admin',
          )
        ).status,
        400,
      );
      await owner.user.update({ where: { id: supervisor }, data: { teamId: otherTeam } });
      assert.equal(
        (
          await request(
            `/people/roster?limit=1&cursor=${page.nextCursor}`,
            'GET',
            undefined,
            'supervisor',
          )
        ).status,
        400,
      );
      await owner.user.update({ where: { id: supervisor }, data: { teamId } });
    },
  );
  await context.test(
    'inactive reserved binding and queue edit persist; activation fails closed',
    async () => {
      const destinationId = randomUUID();
      await owner.voiceDestination.create({
        data: {
          id: destinationId,
          tenantId,
          destination: '4500',
          queueId: queue.id,
          isActive: false,
          voiceConfigVersion: 1,
        },
      });
      await owner.$executeRaw`UPDATE tenant_voice_provisioning_policies SET destination_pool=${JSON.stringify([{ destinationId }])}::jsonb,revision=revision+1 WHERE tenant_id=${tenantId}::uuid`;
      const result = await request(`/destinations/${destinationId}/binding`, 'PUT', {
        ...envelope(),
        queueId: queue.id,
        isActive: false,
      });
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await result.json()).configRevision, 2);
      const nextQueue = await create('queues');
      for (const busyQueue of [queue.id, nextQueue.id]) {
        const busy = await owner.interaction.create({
          data: {
            tenantId,
            queueId: busyQueue,
            channel: 'VOICE',
            direction: 'INBOUND',
            state: 'QUEUED',
          },
        });
        const blocked = await request(`/destinations/${destinationId}/binding`, 'PUT', {
          ...envelope(2),
          queueId: nextQueue.id,
          isActive: false,
        });
        assert.equal((await blocked.json()).code, 'CONFIG_BUSY');
        await owner.interaction.update({ where: { id: busy.id }, data: { state: 'ABANDONED' } });
        const unchanged = await owner.voiceDestination.findUniqueOrThrow({
          where: { id: destinationId },
        });
        assert.equal(unchanged.configRevision, 2);
        assert.equal(unchanged.queueId, queue.id);
      }
      const active = await request(`/destinations/${destinationId}/binding`, 'PUT', {
        ...envelope(2),
        queueId: queue.id,
        isActive: true,
      });
      assert.equal((await active.json()).code, 'CAPABILITY_NOT_READY');
      const renamed = await request(`/queues/${queue.id}`, 'PATCH', {
        ...envelope(2),
        name: '  คิว   ใหม่  ',
      });
      assert.equal(renamed.status, 200, await renamed.clone().text());
      assert.equal((await renamed.json()).name, 'คิว ใหม่');
      const enabled = await request(`/queues/${queue.id}`, 'PATCH', {
        ...envelope(3),
        isActive: true,
      });
      assert.equal((await enabled.json()).code, 'CAPABILITY_NOT_READY');
    },
  );
  await context.test(
    'legacy queued/assigned/active/wrapup and target agent protect replacement',
    async () => {
      const legacy = await owner.queue.create({
        data: { tenantId, name: randomUUID(), teamId: otherTeam, channels: ['VOICE'] },
      });
      for (const state of ['QUEUED', 'ASSIGNED', 'ACTIVE', 'WRAPUP'] as const) {
        const interaction = await owner.interaction.create({
          data: {
            tenantId,
            queueId: legacy.id,
            agentId: agent,
            channel: 'VOICE',
            direction: 'INBOUND',
            state,
          },
        });
        const result = await request(`/people/users/${agent}/skills`, 'PUT', {
          ...envelope(2),
          items: [],
        });
        assert.equal((await result.json()).code, 'CONFIG_BUSY');
        await owner.interaction.update({
          where: { id: interaction.id },
          data: { state: 'COMPLETED' },
        });
      }
      const targeted = await owner.interaction.create({
        data: {
          tenantId,
          queueId: legacy.id,
          channel: 'VOICE',
          direction: 'INBOUND',
          state: 'QUEUED',
          metadata: { targetAgentId: agent },
        },
      });
      const result = await request(`/people/users/${agent}/skills`, 'PUT', {
        ...envelope(2),
        items: [],
      });
      assert.equal((await result.json()).code, 'CONFIG_BUSY');
      await owner.interaction.update({ where: { id: targeted.id }, data: { state: 'COMPLETED' } });
      assert.equal(
        (await (await request(`/people/users/${agent}/skills`)).json()).configRevision,
        2,
      );
    },
  );
  await context.test(
    'A1 User-first and FK reference lock contention returns CONFIG_BUSY promptly',
    async () => {
      const referencedSkill = await create('skills');
      const legacyQueue = await owner.queue.create({
        data: { tenantId, name: randomUUID(), teamId, channels: ['VOICE'] },
      });
      const interaction = await owner.interaction.create({
        data: {
          tenantId,
          queueId: legacyQueue.id,
          agentId: agent,
          channel: 'VOICE',
          direction: 'INBOUND',
          state: 'COMPLETED',
        },
      });
      for (const table of ['users', 'skills']) {
        let release!: () => void;
        let acquired!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const locking = owner.$transaction(
          async (tx) => {
            if (table === 'users')
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${randomUUID()}`},0))`;
            await tx.$queryRawUnsafe(
              `SELECT id FROM ${table} WHERE id=$1::uuid FOR ${table === 'users' ? 'NO KEY UPDATE' : 'UPDATE'}`,
              table === 'users' ? agent : referencedSkill.id,
            );
            if (table === 'users')
              await tx.$queryRaw`SELECT id FROM interactions WHERE tenant_id=${tenantId}::uuid AND id=${interaction.id}::uuid FOR UPDATE`;
            acquired();
            await gate;
          },
          { timeout: 10000 },
        );
        await ready;
        try {
          const start = Date.now();
          const result = await request(`/queues/${queue.id}/required-skills`, 'PUT', {
            ...envelope(3),
            items: table === 'users' ? [] : [{ skillId: referencedSkill.id, minLevel: 1 }],
          });
          assert.equal((await result.json()).code, 'CONFIG_BUSY');
          assert.ok(Date.now() - start < 3000);
        } finally {
          release();
          await locking;
        }
      }
      assert.equal(
        (await (await request(`/queues/${queue.id}/required-skills`)).json()).configRevision,
        3,
      );
    },
  );
  await context.test(
    'exclusive configuration fence rejects multiread projection without mixed revisions',
    async () => {
      let release!: () => void;
      let acquired!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const writer = owner.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${tenantId}`},0))`;
          acquired();
          await gate;
        },
        { timeout: 10000 },
      );
      await ready;
      try {
        for (const path of [
          `/queues/${queue.id}/required-skills`,
          `/people/users/${agent}/skills`,
          `/eligibility?queueId=${queue.id}`,
          '/people/roster',
          '/destinations',
        ]) {
          const result = await request(path);
          assert.equal(result.status, 409);
          assert.equal((await result.json()).code, 'CONFIG_BUSY');
        }
      } finally {
        release();
        await writer;
      }
      assert.equal(
        (await (await request(`/queues/${queue.id}/required-skills`)).json()).configRevision,
        3,
      );
    },
  );
  await context.test(
    'app-role final CONFIG_UPDATE guard rolls back missing revision or success audit',
    async () => {
      for (const bumpRevision of [false, true]) {
        const commandId = randomUUID();
        await assert.rejects(
          withTenantDatabaseTransaction(db, tenantId, async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${tenantId}:${commandId}`},0))`;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${tenantId}`},0))`;
            await tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind) VALUES(${tenantId}::uuid,${commandId}::uuid,${admin}::uuid,'AGENT_SKILLS_REPLACE',${agent}::uuid,${'c'.repeat(64)},2,'CONFIG_UPDATE')`;
            await tx.$executeRaw`SELECT set_config('app.voice_config_command',${commandId},true)`;
            await tx.$executeRaw`UPDATE agent_skills SET level=4 WHERE tenant_id=${tenantId}::uuid AND user_id=${agent}::uuid AND skill_id=${skill.id}::uuid`;
            if (bumpRevision)
              await tx.$executeRaw`UPDATE users SET config_revision=config_revision+1 WHERE tenant_id=${tenantId}::uuid AND id=${agent}::uuid`;
            await tx.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${tenantId}::uuid,${commandId}::uuid,'{}')`;
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          }),
          /VOICE_CONFIG_FINAL_(REVISION|EVIDENCE)_REQUIRED/,
        );
        const after = await owner.user.findUniqueOrThrow({ where: { id: agent } });
        assert.equal(after.configRevision, 2);
        const assignment = await owner.agentSkill.findUniqueOrThrow({
          where: { userId_skillId: { userId: agent, skillId: skill.id } },
        });
        assert.equal(assignment.level, 3);
        const commands = await owner.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM voice_config_commands WHERE tenant_id=${tenantId}::uuid AND command_id=${commandId}::uuid`;
        assert.equal(Number(commands[0].count), 0);
      }
    },
  );
  await context.test(
    'app-role assignment guard detects legacy metadata targets before commit',
    async () => {
      const legacy = await owner.queue.create({
        data: { tenantId, name: randomUUID(), teamId: otherTeam, channels: ['VOICE'] },
      });
      await owner.queueSkill.create({
        data: { tenantId, queueId: legacy.id, skillId: foreignSkill.id, minLevel: 1 },
      });
      for (const targetKey of ['targetAgentId', 'target_agent_id']) {
        const interaction = await owner.interaction.create({
          data: {
            tenantId,
            queueId: legacy.id,
            channel: 'VOICE',
            direction: 'INBOUND',
            state: 'QUEUED',
            metadata: { [targetKey]: agent },
          },
        });
        const commandId = randomUUID();
        try {
          await assert.rejects(
            withTenantDatabaseTransaction(db, tenantId, async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${tenantId}`},0))`;
              await tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind) VALUES(${tenantId}::uuid,${commandId}::uuid,${admin}::uuid,'AGENT_SKILLS_REPLACE',${agent}::uuid,${'d'.repeat(64)},2,'CONFIG_UPDATE')`;
              await tx.$executeRaw`SELECT set_config('app.voice_config_command',${commandId},true)`;
              await tx.$executeRaw`UPDATE agent_skills SET level=4 WHERE tenant_id=${tenantId}::uuid AND user_id=${agent}::uuid AND skill_id=${skill.id}::uuid`;
            }),
            /CONFIG_BUSY/,
          );
        } finally {
          await owner.interaction.update({
            where: { id: interaction.id },
            data: { state: 'ABANDONED' },
          });
        }
        assert.equal(
          (await owner.user.findUniqueOrThrow({ where: { id: agent } })).configRevision,
          2,
        );
        assert.equal(
          (
            await owner.agentSkill.findUniqueOrThrow({
              where: { userId_skillId: { userId: agent, skillId: skill.id } },
            })
          ).level,
          3,
        );
      }
    },
  );
});
