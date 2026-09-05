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
  AgentWorkspaceController,
  AGENT_WORKSPACE_DATABASE,
  AGENT_SIP_LEASE_PROVIDER,
  type AgentSipLeaseProvider,
} from './agent-workspace-api.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';

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

function claims(tenantId: string, userId: string): VerifiedOidcClaims {
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: ['agent'] },
  };
}

test('Agent snapshot ใช้ tenant/user จาก token และคืน authoritative Interaction version', async (t) => {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const agentAId = randomUUID();
  const agentBId = randomUUID();
  const queueAId = randomUUID();
  const queueBId = randomUUID();
  const interactionAId = randomUUID();
  const interactionBId = randomUUID();

  await owner.tenant.createMany({
    data: [
      {
        id: tenantAId,
        name: `Agent tenant A ${tenantAId}`,
        slug: `agent-a-${tenantAId}`,
        sipDomain: `${tenantAId}.agent.test`,
      },
      {
        id: tenantBId,
        name: `Agent tenant B ${tenantBId}`,
        slug: `agent-b-${tenantBId}`,
        sipDomain: `${tenantBId}.agent.test`,
      },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: agentAId,
        tenantId: tenantAId,
        email: `agent-a-${tenantAId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent A',
        role: 'AGENT',
        extension: '5200',
        sipPassword: 'sip-secret-agent-a',
      },
      {
        id: agentBId,
        tenantId: tenantBId,
        email: `agent-b-${tenantBId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent B',
        role: 'AGENT',
        extension: '6200',
      },
    ],
  });
  await owner.queue.createMany({
    data: [
      { id: queueAId, tenantId: tenantAId, name: 'บริการลูกค้า A', channels: ['VOICE'] },
      { id: queueBId, tenantId: tenantBId, name: 'บริการลูกค้า B', channels: ['VOICE'] },
    ],
  });
  await owner.agentStateLog.createMany({
    data: [
      { tenantId: tenantAId, userId: agentAId, state: 'RESERVED' },
      { tenantId: tenantBId, userId: agentBId, state: 'BUSY' },
    ],
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id, metadata, offer_expires_at)
      VALUES
      (
        ${interactionAId}::uuid,
        ${tenantAId}::uuid,
        'VOICE',
        'INBOUND',
        'ASSIGNED',
        ${queueAId}::uuid,
        ${agentAId}::uuid,
        ${`agent-a-${interactionAId}`},
        ${JSON.stringify({ caller: '0812345678', telephonyNodeId: 'fs-a' })}::jsonb,
        ${new Date('2026-09-06T10:00:20.000Z')}
      ),
      (
        ${interactionBId}::uuid,
        ${tenantBId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueBId}::uuid,
        ${agentBId}::uuid,
        ${`agent-b-${interactionBId}`},
        ${JSON.stringify({ caller: '0899999999', telephonyNodeId: 'fs-b' })}::jsonb,
        NULL
      )`,
  );
  const interactionVersion = await owner.interactionEvent.create({
    data: {
      tenantId: tenantAId,
      interactionId: interactionAId,
      type: 'interaction.assigned',
      payload: { agentId: agentAId },
    },
  });

  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'agent-a-token') return claims(tenantAId, agentAId);
      if (token === 'agent-b-token') return claims(tenantBId, agentBId);
      throw new Error('invalid token');
    },
  };
  const leaseRequests: Parameters<AgentSipLeaseProvider['issue']>[0][] = [];
  const leaseProvider: AgentSipLeaseProvider = {
    issue: async (input) => {
      leaseRequests.push(input);
      return {
        leaseId: 'lease-agent-a',
        extension: input.extension,
        authorizationUsername: input.extension,
        authorizationPassword: input.authorizationPassword,
        sipDomain: input.sipDomain,
        wssUrl: 'wss://fs-b.voice.test:7443',
        telephonyNodeId: 'fs-b',
        iceServers: [{ urls: ['turn:turn.voice.test:3478'] }],
        expiresAt: '2026-09-06T10:15:00.000Z',
      };
    },
  };

  @Module({
    controllers: [AgentWorkspaceController],
    providers: [
      { provide: AGENT_WORKSPACE_DATABASE, useValue: application },
      { provide: AGENT_SIP_LEASE_PROVIDER, useValue: leaseProvider },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    for (const tenantId of [tenantAId, tenantBId]) {
      await owner.interactionEvent.deleteMany({ where: { tenantId } });
      await owner.interaction.deleteMany({ where: { tenantId } });
      await owner.agentStateLog.deleteMany({ where: { tenantId } });
      await owner.queue.deleteMany({ where: { tenantId } });
      await owner.user.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/snapshot?tenantId=${tenantBId}&userId=${agentBId}`,
    { headers: { authorization: 'Bearer agent-a-token' } },
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    agent: {
      id: agentAId,
      displayName: 'Agent A',
      extension: '5200',
      state: 'RESERVED',
    },
    interaction: {
      id: interactionAId,
      state: 'ASSIGNED',
      version: interactionVersion.id.toString(),
      caller: '0812345678',
      queue: { id: queueAId, name: 'บริการลูกค้า A' },
      offerExpiresAt: '2026-09-06T10:00:20.000Z',
      answeredAt: null,
      endedAt: null,
    },
  });

  const credentialsResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/workspace/agent/sip-credentials?tenantId=${tenantBId}&telephonyNodeId=fs-a`,
    { headers: { authorization: 'Bearer agent-a-token' } },
  );
  assert.equal(credentialsResponse.status, 200, await credentialsResponse.clone().text());
  assert.deepEqual(await credentialsResponse.json(), {
    leaseId: 'lease-agent-a',
    extension: '5200',
    authorizationUsername: '5200',
    authorizationPassword: 'sip-secret-agent-a',
    sipDomain: `${tenantAId}.agent.test`,
    wssUrl: 'wss://fs-b.voice.test:7443',
    telephonyNodeId: 'fs-b',
    iceServers: [{ urls: ['turn:turn.voice.test:3478'] }],
    expiresAt: '2026-09-06T10:15:00.000Z',
  });
  assert.deepEqual(leaseRequests, [
    {
      tenantId: tenantAId,
      userId: agentAId,
      extension: '5200',
      authorizationPassword: 'sip-secret-agent-a',
      sipDomain: `${tenantAId}.agent.test`,
    },
  ]);
});
