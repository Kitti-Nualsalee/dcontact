/** #986: HTTP → PostgreSQL with an application role that does not bypass RLS — team scope per the answering-team evidence */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { TEAM_HISTORY_DATABASE, TeamHistoryController } from './team-history.js';

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
test.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));

type Role = 'agent' | 'supervisor' | 'admin';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('#986 team history and summary: scope per the answering-team evidence, permission from the DB and numbers matching the list', async (t) => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const ids = {
    teamA: randomUUID(),
    teamB: randomUUID(),
    supervisorA: randomUUID(),
    supervisorB: randomUUID(),
    agentA: randomUUID(),
    agentA2: randomUUID(),
    agentB: randomUUID(),
    admin: randomUUID(),
    queue: randomUUID(),
    foreignTeam: randomUUID(),
    foreignAdmin: randomUUID(),
  };
  const tokens = new Map<string, VerifiedOidcClaims>();
  const token = (tenant: string, userId: string, role: Role) => {
    const value = `token-${randomUUID()}`;
    tokens.set(value, {
      tenant_id: tenant,
      tenant_slug: `tenant-${tenant}`,
      organization: { [`tenant-${tenant}`]: { tenant_id: [tenant] } },
      dc_user_id: userId,
      sid: `session-${userId}`,
      exp: 2_000_000_000,
      realm_access: { roles: [role] },
    });
    return value;
  };
  for (const id of [tenantId, foreignTenantId])
    await owner.tenant.create({
      data: { id, name: `Team history ${id}`, slug: `team-history-${id}`, sipDomain: `${id}.test` },
    });
  await owner.team.createMany({
    data: [
      { id: ids.teamA, tenantId, name: 'Team A' },
      { id: ids.teamB, tenantId, name: 'Team B' },
      { id: ids.foreignTeam, tenantId: foreignTenantId, name: 'Team A' },
    ],
  });
  const user = (
    id: string,
    tenant: string,
    role: 'AGENT' | 'SUPERVISOR' | 'ADMIN',
    teamId: string | null,
    displayName: string,
  ) => ({
    id,
    tenantId: tenant,
    email: `${id}@test.local`,
    passwordHash: 'test',
    displayName,
    role,
    teamId,
  });
  await owner.user.createMany({
    data: [
      user(ids.supervisorA, tenantId, 'SUPERVISOR', ids.teamA, 'Supervisor A'),
      user(ids.supervisorB, tenantId, 'SUPERVISOR', ids.teamB, 'Supervisor B'),
      user(ids.agentA, tenantId, 'AGENT', ids.teamA, 'Agent A'),
      user(ids.agentA2, tenantId, 'AGENT', ids.teamA, 'Agent A2'),
      // moved from A to B later — a call answered while in A must still belong to A
      user(ids.agentB, tenantId, 'AGENT', ids.teamB, 'Agent B'),
      user(ids.admin, tenantId, 'ADMIN', null, 'Admin'),
      user(ids.foreignAdmin, foreignTenantId, 'ADMIN', null, 'Foreign admin'),
    ],
  });
  await owner.queue.create({
    data: {
      id: ids.queue,
      tenantId,
      name: 'Support',
      channels: ['VOICE'],
      // the interaction takes the wrap-up policy from the queue (stamp_voice_wrapup_policy)
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
    },
  });

  /** a finished call with a wrap-up result; `team` = the team the Router recorded at answer time (undefined = no evidence) */
  async function call(input: {
    agentId: string;
    team?: string;
    disposition: 'CUSTOMER_ASSISTED' | 'FOLLOW_UP_REQUIRED';
    recordedAt: Date;
    talkSeconds: number;
    note: string;
  }) {
    const interactionId = randomUUID();
    const answeredAt = new Date(input.recordedAt.getTime() - (input.talkSeconds + 30) * 1000);
    const endedAt = new Date(answeredAt.getTime() + input.talkSeconds * 1000);
    // the wrap-up trigger checks at commit — the call and the wrap-up must be created in one transaction
    await owner.$transaction([
      owner.$executeRaw(
        Prisma.sql`INSERT INTO interactions (id, tenant_id, channel, direction, state, queue_id, agent_id,
            external_id, voice_wrapup_policy, queued_at, answered_at, ended_at, wrap_up_code)
          VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'COMPLETED',
            ${ids.queue}::uuid, ${input.agentId}::uuid, ${`call-${interactionId}`}, 'VOICE_NOTE_V1',
            ${answeredAt}, ${answeredAt}, ${endedAt}, ${input.disposition})`,
      ),
      owner.$executeRaw(
        Prisma.sql`INSERT INTO interaction_wrapup_results (interaction_id, tenant_id, owner_agent_id,
            disposition, note, recorded_at, command_id)
          VALUES (${interactionId}::uuid, ${tenantId}::uuid, ${input.agentId}::uuid,
            ${input.disposition}, ${input.note}, ${input.recordedAt}, ${randomUUID()}::uuid)`,
      ),
    ]);
    if (input.team)
      await owner.voiceInteractionHandlingAttribution.create({
        data: {
          tenantId,
          interactionId,
          agentId: input.agentId,
          teamId: input.team,
          acceptedAt: answeredAt,
          sourceEventId: `test:${interactionId}`,
        },
      });
    return interactionId;
  }

  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000);
  const a1 = await call({
    agentId: ids.agentA,
    team: ids.teamA,
    disposition: 'CUSTOMER_ASSISTED',
    recordedAt: ago(10),
    talkSeconds: 60,
    note: 'Customer A1',
  });
  const a2 = await call({
    agentId: ids.agentA2,
    team: ids.teamA,
    disposition: 'FOLLOW_UP_REQUIRED',
    recordedAt: ago(20),
    talkSeconds: 120,
    note: 'Must call back A2',
  });
  // Agent B answered this call while still in team A
  const movedCall = await call({
    agentId: ids.agentB,
    team: ids.teamA,
    disposition: 'CUSTOMER_ASSISTED',
    recordedAt: ago(30),
    talkSeconds: 30,
    note: 'Before the team move',
  });
  const b1 = await call({
    agentId: ids.agentB,
    team: ids.teamB,
    disposition: 'CUSTOMER_ASSISTED',
    recordedAt: ago(40),
    talkSeconds: 90,
    note: 'Team B call',
  });
  // an old call has no team evidence — it must not appear in any team's history
  const noEvidence = await call({
    agentId: ids.agentA,
    disposition: 'CUSTOMER_ASSISTED',
    recordedAt: ago(50),
    talkSeconds: 45,
    note: 'No evidence',
  });

  @Module({
    controllers: [TeamHistoryController],
    providers: [
      { provide: TEAM_HISTORY_DATABASE, useValue: application },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (value: string) => {
            const found = tokens.get(value);
            if (!found) throw new Error('invalid token');
            return found;
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
  t.after(async () => {
    await app.close();
    for (const tenant of [tenantId, foreignTenantId]) {
      await owner.interactionWrapupResult.deleteMany({ where: { tenantId: tenant } });
      await owner.voiceInteractionHandlingAttribution.deleteMany({ where: { tenantId: tenant } });
      await owner.interaction.deleteMany({ where: { tenantId: tenant } });
      await owner.queue.deleteMany({ where: { tenantId: tenant } });
      await owner.user.deleteMany({ where: { tenantId: tenant } });
      await owner.team.deleteMany({ where: { tenantId: tenant } });
      await owner.tenant.delete({ where: { id: tenant } });
    }
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/team-history`;
  const get = async (path: string, auth: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const supervisorA = token(tenantId, ids.supervisorA, 'supervisor');
  const supervisorB = token(tenantId, ids.supervisorB, 'supervisor');
  const admin = token(tenantId, ids.admin, 'admin');
  const agent = token(tenantId, ids.agentA, 'agent');
  const foreignAdmin = token(foreignTenantId, ids.foreignAdmin, 'admin');
  const listIds = (body: Json) => body.items.map((item: Json) => item.interactionId);

  await t.test(
    'a Supervisor sees only their own team per the evidence, including calls of people who have since moved team',
    async () => {
      const teams = await get('/teams', supervisorA);
      assert.equal(teams.status, 200);
      assert.deepEqual(teams.body, {
        allTeams: false,
        items: [{ id: ids.teamA, name: 'Team A', isActive: true }],
      });
      const list = await get('/items', supervisorA);
      assert.equal(list.status, 200);
      assert.equal(list.body.teamId, ids.teamA);
      assert.deepEqual(listIds(list.body), [a1, a2, movedCall]);
      assert.ok(!listIds(list.body).includes(noEvidence));
      assert.deepEqual(list.body.items[0].agent, { id: ids.agentA, displayName: 'Agent A' });
      assert.equal(list.body.items[0].talkSeconds, 60);
      assert.equal(list.body.items[0].note, undefined, 'the list has no note');
      assert.equal((await get(`/items?teamId=${ids.teamB}`, supervisorA)).status, 404);
      assert.equal((await get(`/items/${b1}`, supervisorA)).status, 404);
      assert.deepEqual(listIds((await get('/items', supervisorB)).body), [b1]);
    },
  );

  await t.test(
    'the team summary counts from the same definition as the list, and clicking a number opens the source list',
    async () => {
      const summary = await get('/summary?period=7d', supervisorA);
      assert.equal(summary.status, 200);
      assert.equal(summary.body.completed, 3);
      assert.deepEqual(summary.body.talk, { averageSeconds: 70, measuredCount: 3 });
      assert.deepEqual(summary.body.byDisposition, [
        { disposition: 'CUSTOMER_ASSISTED', count: 2 },
        { disposition: 'FOLLOW_UP_REQUIRED', count: 1 },
      ]);
      assert.deepEqual(
        summary.body.byAgent.map((row: Json) => [row.agent.displayName, row.completed]),
        [
          ['Agent A', 1],
          ['Agent A2', 1],
          ['Agent B', 1],
        ],
      );
      const window = `from=${encodeURIComponent(summary.body.period.from)}&to=${encodeURIComponent(summary.body.period.to)}`;
      const assisted = await get(`/items?${window}&disposition=CUSTOMER_ASSISTED`, supervisorA);
      assert.deepEqual(listIds(assisted.body), [a1, movedCall]);
      const byAgent = await get(`/items?${window}&agentId=${ids.agentA2}`, supervisorA);
      assert.deepEqual(listIds(byAgent.body), [a2]);
    },
  );

  await t.test(
    'an Admin sees every team and can pick one at a time; a team not in the tenant answers 404',
    async () => {
      const teams = await get('/teams', admin);
      assert.equal(teams.body.allTeams, true);
      assert.deepEqual(
        teams.body.items.map((team: Json) => team.id),
        [ids.teamA, ids.teamB],
      );
      const all = await get('/items', admin);
      assert.equal(all.body.teamId, null);
      assert.deepEqual(listIds(all.body), [a1, a2, movedCall, b1]);
      assert.deepEqual(listIds((await get(`/items?teamId=${ids.teamB}`, admin)).body), [b1]);
      assert.equal((await get('/summary?period=all', admin)).body.completed, 4);
      assert.equal((await get(`/items?teamId=${ids.foreignTeam}`, admin)).status, 404);
      assert.equal((await get(`/items?teamId=${randomUUID()}`, admin)).status, 404);
      assert.equal((await get('/items', foreignAdmin)).body.items.length, 0);
    },
  );

  await t.test(
    'the detail has the note of a call in scope; a call with no evidence and another tenant answer 404',
    async () => {
      const detail = await get(`/items/${a2}`, supervisorA);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.note, 'Must call back A2');
      assert.equal(detail.body.talkSeconds, 120);
      assert.deepEqual(detail.body.team, { id: ids.teamA, name: 'Team A' });
      assert.equal((await get(`/items/${b1}`, admin)).body.note, 'Team B call');
      assert.equal((await get(`/items/${noEvidence}`, admin)).status, 404);
      assert.equal((await get(`/items/${a1}`, foreignAdmin)).status, 404);
      assert.equal((await get('/items/not-a-uuid', admin)).status, 400);
    },
  );

  await t.test(
    'an Agent and a user who is disabled or moved team lose access immediately',
    async () => {
      assert.equal((await get('/items', agent)).status, 403);
      // the token still says supervisor but the DB says AGENT now
      const demoted = token(tenantId, ids.agentA2, 'supervisor');
      assert.equal((await get('/items', demoted)).status, 403);
      await owner.user.update({ where: { id: ids.supervisorA }, data: { teamId: ids.teamB } });
      assert.deepEqual(listIds((await get('/items', supervisorA)).body), [b1]);
      await owner.user.update({ where: { id: ids.supervisorA }, data: { isActive: false } });
      assert.equal((await get('/items', supervisorA)).status, 403);
    },
  );

  await t.test('the cursor binds to the requester, team and filter', async () => {
    const first = await get('/items?limit=2', admin);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);
    const next = await get(`/items?limit=2&cursor=${first.body.nextCursor}`, admin);
    assert.deepEqual(listIds(next.body), [movedCall, b1]);
    assert.equal(
      (await get(`/items?limit=2&teamId=${ids.teamB}&cursor=${first.body.nextCursor}`, admin))
        .status,
      400,
    );
    assert.equal(
      (await get(`/items?limit=2&cursor=${first.body.nextCursor}`, supervisorB)).status,
      400,
    );
  });
});
