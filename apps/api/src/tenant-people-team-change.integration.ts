import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpException, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import { configuredPeopleRuntime } from './tenant-people-composition.js';
import { acceptPeopleTeamChange } from './tenant-people-team-change.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';
import type { VoiceActor } from './tenant-voice-catalog.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpException, String(error));
    assert.equal(error.getStatus(), status);
    const body = error.getResponse();
    assert.equal(typeof body === 'object' && 'code' in body ? body.code : undefined, code);
    return true;
  });
}

test('#998 1A: an Admin moves an account to another team with a revision/idle fence and removes the old team skills', async (suite) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL of the isolated fixture DB must be set');
  assert.ok(
    process.env.APPLICATION_DATABASE_URL,
    'APPLICATION_DATABASE_URL that enforces RLS must be set',
  );
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID(),
    foreignTenantId = randomUUID(),
    teamA = randomUUID(),
    teamB = randomUUID(),
    inactiveTeam = randomUUID(),
    foreignTeam = randomUUID();
  const adminId = randomUUID(),
    agentId = randomUUID(),
    supervisorId = randomUUID(),
    unboundId = randomUUID(),
    legacyDisabledId = randomUUID(),
    foreignId = randomUUID();
  const skillA = randomUUID(),
    skillB = randomUUID();
  const issuer = 'https://team-change-idp.test/realms/dcontact';
  const actor = (scope = tenantId, userId = adminId): VoiceActor => ({
    tenantId: scope,
    userId,
    roles: ['admin'],
    caller: {
      issuer,
      subject: userId,
      clientId: 'dcontact-console',
      tenantSlug: `team-change-${scope}`,
    },
  });
  let app: INestApplication | undefined;
  try {
    for (const id of [tenantId, foreignTenantId])
      await owner.tenant.create({
        data: {
          id,
          name: 'Team change fixture',
          slug: `team-change-${id}`,
          sipDomain: `${id}.test`,
        },
      });
    await owner.team.createMany({
      data: [
        { id: teamA, tenantId, name: 'Team A' },
        { id: teamB, tenantId, name: 'Team B' },
        { id: inactiveTeam, tenantId, name: 'Closed team', isActive: false },
        { id: foreignTeam, tenantId: foreignTenantId, name: 'Team of another tenant' },
      ],
    });
    const people: [string, string, 'ADMIN' | 'AGENT' | 'SUPERVISOR', string | null][] = [
      [adminId, tenantId, 'ADMIN', teamA],
      [agentId, tenantId, 'AGENT', teamA],
      [supervisorId, tenantId, 'SUPERVISOR', teamA],
      [unboundId, tenantId, 'AGENT', teamA],
      [legacyDisabledId, tenantId, 'SUPERVISOR', teamA],
      [foreignId, foreignTenantId, 'ADMIN', foreignTeam],
    ];
    for (const [id, scope, role, team] of people)
      await owner.user.create({
        data: {
          id,
          tenantId: scope,
          teamId: team,
          keycloakId: id,
          email: `${id}@example.test`,
          displayName: `User ${role}`,
          role,
          extension: role === 'AGENT' ? (id === agentId ? '1201' : '1202') : null,
          passwordHash: '!keycloak-managed',
          isActive: id !== legacyDisabledId,
        },
      });
    for (const [id, scope] of [
      [adminId, tenantId],
      [agentId, tenantId],
      [supervisorId, tenantId],
      [legacyDisabledId, tenantId],
      [foreignId, foreignTenantId],
    ])
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES(${scope}::uuid,${id}::uuid,${issuer},${id},'dcontact-console',${`team-change-${scope}`},${scope}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','team-change-fixture',${'b'.repeat(64)},'fixture-operator',now(),1,true)`;
    for (const scope of [tenantId, foreignTenantId])
      await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool)
        VALUES(${scope}::uuid,1,'UAT_EXPLICIT',100,100,2,5,'fixture-operator',now(),'team-change-fixture','Team change test','[]'::jsonb)`;
    await owner.skill.createMany({
      data: [
        { id: skillA, tenantId, teamId: teamA, name: 'Team A skill', voiceConfigVersion: 1 },
        { id: skillB, tenantId, teamId: teamB, name: 'Team B skill', voiceConfigVersion: 1 },
      ],
    });
    await owner.agentSkill.createMany({
      data: [
        { tenantId, userId: agentId, skillId: skillA, level: 3 },
        { tenantId, userId: agentId, skillId: skillB, level: 2 },
      ],
    });
    const command = (expectedRevision: number, teamId = teamB) => ({
      commandId: randomUUID(),
      expectedRevision,
      teamId,
      reason: 'Moved to look after a new customer group',
    });

    await suite.test(
      'an idle Agent can move team with revision +1, the old team skills are removed, and a replay gives the same result',
      async () => {
        const body = command(1);
        const result = await acceptPeopleTeamChange(application, actor(), agentId, body);
        assert.deepEqual(result, {
          userId: agentId,
          fromTeamId: teamA,
          teamId: teamB,
          configRevision: 2,
          removedSkills: 1,
        });
        // the append-only ledger says who moved whom from which team to which team and why
        const ledger = await owner.$queryRaw<Record<string, unknown>[]>`
          SELECT user_id,actor_user_id,from_team_id,to_team_id,before_revision,removed_skill_ids,reason
          FROM tenant_people_team_changes WHERE tenant_id=${tenantId}::uuid AND command_id=${body.commandId}::uuid`;
        assert.deepEqual(ledger, [
          {
            user_id: agentId,
            actor_user_id: adminId,
            from_team_id: teamA,
            to_team_id: teamB,
            before_revision: 1,
            removed_skill_ids: [skillA],
            reason: 'Moved to look after a new customer group',
          },
        ]);
        await assert.rejects(
          owner.$executeRaw`UPDATE tenant_people_team_changes SET reason='Edit' WHERE tenant_id=${tenantId}::uuid`,
          /VOICE_CONFIG_APPEND_ONLY/,
        );
        await assert.rejects(
          application.$transaction(async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
            await transaction.$executeRaw`INSERT INTO tenant_people_team_changes(tenant_id,command_id,user_id,actor_user_id,to_team_id,before_revision,reason)
              VALUES(${tenantId}::uuid,${randomUUID()}::uuid,${agentId}::uuid,${adminId}::uuid,${teamA}::uuid,1,'x')`;
          }),
          /permission denied/,
        );
        const agent = await owner.user.findUniqueOrThrow({ where: { id: agentId } });
        assert.equal(agent.teamId, teamB);
        assert.equal(agent.configRevision, 2);
        assert.equal(agent.extension, '1201');
        assert.deepEqual(
          (await owner.agentSkill.findMany({ where: { tenantId, userId: agentId } })).map(
            (row) => row.skillId,
          ),
          [skillB],
        );
        assert.deepEqual(await acceptPeopleTeamChange(application, actor(), agentId, body), result);
        await rejectsWith(
          acceptPeopleTeamChange(application, actor(), agentId, { ...body, teamId: teamA }),
          409,
          'COMMAND_PAYLOAD_MISMATCH',
        );
        const audit = await owner.$queryRaw<{ outcome: string; changed_keys: string[] }[]>`
        SELECT outcome,changed_keys FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND command_id=${body.commandId}::uuid`;
        assert.deepEqual(audit, [
          { outcome: 'SUCCEEDED', changed_keys: ['teamId', 'agentSkills'] },
        ]);
      },
    );

    await suite.test(
      'rejects an old revision, the same team, a closed team, a team of another tenant, and an account without positive proof',
      async () => {
        await rejectsWith(
          acceptPeopleTeamChange(application, actor(), agentId, command(1, teamA)),
          409,
          'REVISION_CONFLICT',
        );
        await assert.rejects(
          acceptPeopleTeamChange(application, actor(), agentId, command(2, teamB)),
          (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
        );
        for (const team of [inactiveTeam, foreignTeam, randomUUID()])
          await rejectsWith(
            acceptPeopleTeamChange(application, actor(), supervisorId, command(1, team)),
            409,
            'REFERENCE_SCOPE_MISMATCH',
          );
        for (const target of [unboundId, foreignId, randomUUID()])
          await rejectsWith(
            acceptPeopleTeamChange(application, actor(), target, command(1)),
            404,
            'RESOURCE_NOT_FOUND',
          );
        const supervisor = await owner.user.findUniqueOrThrow({ where: { id: supervisorId } });
        assert.equal(supervisor.teamId, teamA);
        assert.equal(supervisor.configRevision, 1);
      },
    );

    await suite.test(
      'an Agent with a pending call cannot move team, and the rejection is recorded without keeping the reason',
      async () => {
        const interactionId = randomUUID();
        await owner.$executeRaw`INSERT INTO interactions(id,tenant_id,channel,direction,state,agent_id)
        VALUES(${interactionId}::uuid,${tenantId}::uuid,'VOICE','INBOUND','ACTIVE',${agentId}::uuid)`;
        const body = command(2, teamA);
        await rejectsWith(
          acceptPeopleTeamChange(application, actor(), agentId, body),
          409,
          'CONFIG_BUSY',
        );
        const agent = await owner.user.findUniqueOrThrow({ where: { id: agentId } });
        assert.equal(agent.teamId, teamB);
        assert.equal(agent.configRevision, 2);
        const audit = await owner.$queryRaw<{ outcome: string; reason_code: string }[]>`
        SELECT outcome,reason_code FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND command_id=${body.commandId}::uuid`;
        assert.deepEqual(audit, [{ outcome: 'REJECTED', reason_code: 'CONFIG_BUSY' }]);
        await owner.$executeRaw`UPDATE interactions SET state='COMPLETED' WHERE tenant_id=${tenantId}::uuid AND id=${interactionId}::uuid`;
        assert.equal(
          (await acceptPeopleTeamChange(application, actor(), agentId, command(2, teamA))).teamId,
          teamA,
        );
      },
    );

    await suite.test(
      'rejects a disabled account, one being provisioned, or an Agent who still has a Workspace open',
      async () => {
        await rejectsWith(
          acceptPeopleTeamChange(application, actor(), legacyDisabledId, command(1)),
          409,
          'ACCOUNT_STATE_CONFLICT',
        );
        const created = await acceptPeopleCreate(application, actor(), {
          commandId: randomUUID(),
          displayName: 'Account being provisioned',
          email: 'provisioning-team@example.test',
          role: 'SUPERVISOR',
          teamId: teamA,
        });
        // a B2 account that is not yet PROVISIONED does not pass the positive proof of the disable snapshot, so it looks like the account does not exist
        await rejectsWith(
          acceptPeopleTeamChange(application, actor(), created.userId, command(1)),
          404,
          'RESOURCE_NOT_FOUND',
        );
        const leaseId = randomUUID();
        await owner.$executeRaw`INSERT INTO agent_work_session_leases(id,tenant_id,user_id,surface,acquired_at,heartbeat_at,expires_at)
        VALUES(${leaseId}::uuid,${tenantId}::uuid,${agentId}::uuid,'workspace',now() AT TIME ZONE 'UTC',now() AT TIME ZONE 'UTC',(now()+interval '5 minutes') AT TIME ZONE 'UTC')`;
        const current = await owner.user.findUniqueOrThrow({ where: { id: agentId } });
        await rejectsWith(
          acceptPeopleTeamChange(
            application,
            actor(),
            agentId,
            command(current.configRevision, teamB),
          ),
          409,
          'AGENT_SESSION_ACTIVE',
        );
        await owner.$executeRaw`UPDATE agent_work_session_leases SET released_at=now() AT TIME ZONE 'UTC',release_reason='released' WHERE id=${leaseId}::uuid`;
      },
    );

    await suite.test(
      'the definer rejects a direct call with the wrong scope or a command not created through the API',
      async () => {
        for (const scope of [foreignTenantId, tenantId])
          await assert.rejects(
            application.$transaction(async (transaction) => {
              await transaction.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
              await transaction.$queryRaw`SELECT dc_people_apply_team_change(${scope}::uuid,${randomUUID()}::uuid,${teamB}::uuid,'x',${issuer},'dcontact-console',${`team-change-${tenantId}`})`;
            }),
            /PEOPLE_UPDATE_SCOPE_DENIED/,
          );
      },
    );

    await suite.test(
      'check the body: no role/extension/email is accepted and a reason is required',
      async () => {
        for (const extra of [
          { role: 'ADMIN' },
          { extensionRef: '1203' },
          { email: 'x@example.test' },
        ])
          await assert.rejects(
            acceptPeopleTeamChange(application, actor(), supervisorId, { ...command(1), ...extra }),
            (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
          );
        for (const reason of ['', '   ', 'x'.repeat(501), 'has\x00control'])
          await assert.rejects(
            acceptPeopleTeamChange(application, actor(), supervisorId, { ...command(1), reason }),
            (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
          );
      },
    );

    await suite.test(
      'HTTP: a Supervisor cannot call PATCH, while an Admin can move a Supervisor to another team',
      async () => {
        @Module({
          controllers: [TenantPeopleController],
          providers: [
            { provide: TENANT_VOICE_DATABASE, useValue: application },
            { provide: TENANT_PEOPLE_READINESS, useValue: configuredPeopleRuntime({}) },
            {
              provide: OIDC_ACCESS_TOKEN_VERIFIER,
              useValue: {
                verifyAccessToken: async (token: string) => {
                  if (!['admin', 'supervisor'].includes(token))
                    throw Error('invalid fixture token');
                  const userId = token === 'admin' ? adminId : supervisorId;
                  const alias = `team-change-${tenantId}`;
                  return {
                    iss: issuer,
                    sub: userId,
                    azp: 'dcontact-console',
                    tenant_id: tenantId,
                    tenant_slug: alias,
                    organization: { [alias]: { tenant_id: [tenantId] } },
                    dc_user_id: userId,
                    sid: randomUUID(),
                    exp: 2_000_000_000,
                    realm_access: { roles: [token] },
                    dc_identity_class: 'TENANT_USER',
                  };
                },
              },
            },
            {
              provide: TENANT_LIFECYCLE,
              useValue: {
                isActive: async (id: string) =>
                  !!(await application.tenant.findFirst({
                    where: { id, lifecycleStatus: 'ACTIVE' },
                  })),
              },
            },
            { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
            { provide: APP_GUARD, useClass: OidcGlobalGuard },
          ],
        })
        class TeamChangeModule {}
        app = await NestFactory.create(TeamChangeModule, { logger: false });
        await app.listen(0, '127.0.0.1');
        const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice/people/users/${supervisorId}/team`;
        const patch = (token: string) =>
          fetch(url, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(command(1)),
          });
        assert.equal((await patch('supervisor')).status, 403);
        const response = await patch('admin');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.teamId, teamB);
        assert.equal(body.configRevision, 2);
      },
    );
  } finally {
    await app?.close();
    await owner.$disconnect();
    await application.$disconnect();
  }
});
