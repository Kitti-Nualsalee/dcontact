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
import {
  SupervisorLiveController,
  SUPERVISOR_LIVE_DATABASE,
  SupervisorLiveEventStream,
} from './supervisor-live-api.js';

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

function claims(
  tenantId: string,
  userId: string,
  roles: readonly ('agent' | 'supervisor' | 'admin')[],
): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles },
  };
}

test('supervisor sees and controls only its team while admin sees the tenant snapshot', async (t) => {
  const tenantId = randomUUID();
  const adminUserId = randomUUID();
  const supervisorUserId = randomUUID();
  const agentAId = randomUUID();
  const safeAgentId = randomUUID();
  const agentBId = randomUUID();
  const teamAId = randomUUID();
  const teamBId = randomUUID();
  const queueAId = randomUUID();
  const queueBId = randomUUID();
  const activeInteractionId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Supervisor tenant ${tenantId}`,
      slug: `supervisor-${tenantId}`,
      sipDomain: `${tenantId}.supervisor.test`,
    },
  });
  await owner.team.createMany({
    data: [
      { id: teamAId, tenantId, name: `Team A ${tenantId}` },
      { id: teamBId, tenantId, name: `Team B ${tenantId}` },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: adminUserId,
        tenantId,
        email: `admin-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Admin',
        role: 'ADMIN',
      },
      {
        id: supervisorUserId,
        tenantId,
        teamId: teamAId,
        email: `supervisor-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Supervisor A',
        role: 'SUPERVISOR',
      },
      {
        id: agentAId,
        tenantId,
        teamId: teamAId,
        extension: '5100',
        email: `agent-a-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent A',
        role: 'AGENT',
      },
      {
        id: agentBId,
        tenantId,
        teamId: teamBId,
        extension: '5101',
        email: `agent-b-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent B',
        role: 'AGENT',
      },
      {
        id: safeAgentId,
        tenantId,
        teamId: teamAId,
        extension: '5102',
        email: `agent-safe-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent Safe',
        role: 'AGENT',
      },
    ],
  });
  await owner.queue.createMany({
    data: [
      { id: queueAId, tenantId, teamId: teamAId, name: `Queue A ${tenantId}`, channels: ['VOICE'] },
      { id: queueBId, tenantId, teamId: teamBId, name: `Queue B ${tenantId}`, channels: ['VOICE'] },
    ],
  });
  await owner.agentStateLog.createMany({
    data: [
      { tenantId, userId: agentAId, state: 'AVAILABLE' },
      { tenantId, userId: agentBId, state: 'AVAILABLE' },
      { tenantId, userId: safeAgentId, state: 'AVAILABLE' },
    ],
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id, metadata)
      VALUES (
        ${activeInteractionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueAId}::uuid,
        ${agentAId}::uuid,
        ${`supervisor-${activeInteractionId}`},
        ${JSON.stringify({
          vendor: 'freeswitch',
          telephonyNodeId: 'fs-test',
          caller: '1002',
          destination: '2000',
        })}::jsonb
      )`,
  );

  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'supervisor-token') return claims(tenantId, supervisorUserId, ['supervisor']);
      if (token === 'admin-token') return claims(tenantId, adminUserId, ['admin']);
      if (token === 'agent-token') return claims(tenantId, agentAId, ['agent']);
      throw new Error('invalid token');
    },
  };
  const liveEvents = new SupervisorLiveEventStream();

  @Module({
    controllers: [SupervisorLiveController],
    providers: [
      { provide: SUPERVISOR_LIVE_DATABASE, useValue: application },
      { provide: SupervisorLiveEventStream, useValue: liveEvents },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
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
    await owner.commandReceipt.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/v1/workspace/supervisor`;
  const request = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });

  assert.equal((await request('/snapshot', 'agent-token')).status, 403);
  const supervisorSnapshot = await request('/snapshot', 'supervisor-token');
  assert.equal(supervisorSnapshot.status, 200, await supervisorSnapshot.clone().text());
  assert.deepEqual(
    ((await supervisorSnapshot.json()) as { agents: { id: string }[] }).agents
      .map((agent) => agent.id)
      .sort(),
    [agentAId, safeAgentId].sort(),
  );
  const supervisorQueueSnapshot = (await (
    await request('/snapshot', 'supervisor-token')
  ).json()) as {
    queues: { id: string }[];
  };
  assert.deepEqual(
    supervisorQueueSnapshot.queues.map((queue) => queue.id),
    [queueAId],
  );

  const adminSnapshot = await request('/snapshot', 'admin-token');
  assert.equal(adminSnapshot.status, 200);
  assert.deepEqual(
    ((await adminSnapshot.json()) as { agents: { id: string }[] }).agents
      .map((agent) => agent.id)
      .sort(),
    [agentAId, agentBId, safeAgentId].sort(),
  );

  const unsafe = await request(`/agents/${agentAId}/state`, 'supervisor-token', {
    method: 'PUT',
    body: JSON.stringify({
      state: 'BREAK',
      reason: 'ห้ามรบกวนสายที่กำลัง active',
      commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
    }),
  });
  assert.equal(unsafe.status, 409);
  const forced = await request(`/agents/${safeAgentId}/state`, 'supervisor-token', {
    method: 'PUT',
    body: JSON.stringify({
      state: 'BREAK',
      reason: 'พักตามตาราง',
      commandId: 'e5e94bea-4a4f-4f45-a4fb-d0d1db07e899',
    }),
  });
  assert.equal(forced.status, 200);
  assert.deepEqual(await forced.json(), {
    agentId: safeAgentId,
    state: 'BREAK',
    reason: 'พักตามตาราง',
  });
  const repeatedForce = await request(`/agents/${safeAgentId}/state`, 'supervisor-token', {
    method: 'PUT',
    body: JSON.stringify({
      state: 'BREAK',
      reason: 'พักตามตาราง',
      commandId: 'e5e94bea-4a4f-4f45-a4fb-d0d1db07e899',
    }),
  });
  assert.equal(repeatedForce.status, 200);
  assert.deepEqual(await repeatedForce.json(), {
    agentId: safeAgentId,
    state: 'BREAK',
    reason: 'พักตามตาราง',
  });
  assert.equal(
    (
      await request(`/agents/${agentBId}/state`, 'supervisor-token', {
        method: 'PUT',
        body: JSON.stringify({ state: 'BREAK', reason: 'ข้ามทีม' }),
      })
    ).status,
    403,
  );
  for (const state of ['RESERVED', 'BUSY', 'ACW']) {
    assert.equal(
      (
        await request(`/agents/${agentAId}/state`, 'supervisor-token', {
          method: 'PUT',
          body: JSON.stringify({ state, reason: 'ห้าม force' }),
        })
      ).status,
      400,
    );
  }

  const disabled = await request(`/queues/${queueAId}/availability`, 'supervisor-token', {
    method: 'PUT',
    body: JSON.stringify({
      isActive: false,
      reason: 'ปิดรับสายชั่วคราว',
      commandId: '48ef8d3d-c90e-4e71-a5e0-ebd58d78de59',
    }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as { isActive: boolean }).isActive, false);
  assert.equal(
    (
      await request(`/queues/${queueBId}/availability`, 'supervisor-token', {
        method: 'PUT',
        body: JSON.stringify({ isActive: false, reason: 'ข้ามทีม' }),
      })
    ).status,
    403,
  );
  const afterDisable = (await (await request('/snapshot', 'supervisor-token')).json()) as {
    interactions: { id: string; state: string }[];
    audit: { action: string; reason?: string }[];
  };
  assert.deepEqual(afterDisable.interactions, [{ id: activeInteractionId, state: 'ACTIVE' }]);
  assert.ok(
    afterDisable.audit.some(
      (event) => event.action === 'AGENT_STATE_FORCED' && event.reason === 'พักตามตาราง',
    ),
  );
  assert.ok(afterDisable.audit.some((event) => event.action === 'QUEUE_DISABLED'));
  assert.equal(liveEvents.sequence(tenantId), 2);
});
