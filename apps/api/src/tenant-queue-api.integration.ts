import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  QueueAuditController,
  QueueController,
  TENANT_QUEUE_DATABASE,
  TenantQueuePolicyController,
  VoiceDestinationController,
} from './tenant-queue-api.js';

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

function claims(tenantId: string, userId: string, role: 'agent' | 'admin'): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  };
}

test('queue management REST API allows tenant Admin and rejects Agent mutation', async (t) => {
  const tenantId = randomUUID();
  const adminUserId = randomUUID();
  const agentUserId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `REST tenant ${tenantId}`,
      slug: `rest-${tenantId}`,
      sipDomain: `${tenantId}.rest.test`,
    },
  });

  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'admin-token') return claims(tenantId, adminUserId, 'admin');
      if (token === 'agent-token') return claims(tenantId, agentUserId, 'agent');
      throw new Error('invalid token');
    },
  };

  @Module({
    controllers: [
      QueueController,
      TenantQueuePolicyController,
      VoiceDestinationController,
      QueueAuditController,
    ],
    providers: [
      { provide: TENANT_QUEUE_DATABASE, useValue: application },
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
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.queueSkill.deleteMany({ where: { queue: { tenantId } } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.skill.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/queues`;
  const body = JSON.stringify({
    name: `REST Voice ${tenantId.slice(0, 8)}`,
    slaThresholdSec: 25,
    maxWaitSec: 120,
    offerTimeoutSec: 20,
    offerTimeoutAction: 'COOLDOWN_REQUEUE',
    offerCooldownSec: 60,
    maxWaitAction: 'VOICEMAIL',
    routingStrategy: 'LONGEST_AVAILABLE_IDLE',
    priority: 2,
  });
  const create = (token: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });

  assert.equal((await create('agent-token')).status, 403);

  const accepted = await create('admin-token');
  assert.equal(accepted.status, 201);
  const payload = (await accepted.json()) as { id: string };
  assert.match(payload.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload, {
    id: payload.id,
    name: `REST Voice ${tenantId.slice(0, 8)}`,
    channels: ['VOICE'],
    slaThresholdSec: 25,
    maxWaitSec: 120,
    offerTimeoutSec: 20,
    offerTimeoutAction: 'COOLDOWN_REQUEUE',
    offerCooldownSec: 60,
    maxWaitAction: 'VOICEMAIL',
    routingStrategy: 'LONGEST_AVAILABLE_IDLE',
    priority: 2,
    isActive: true,
  });

  const tenantPolicyEndpoint = `http://127.0.0.1:${address.port}/api/v1/tenant/queue-policy`;
  assert.equal(
    (await fetch(tenantPolicyEndpoint, { headers: { authorization: 'Bearer agent-token' } }))
      .status,
    403,
  );
  const tenantPolicy = await fetch(tenantPolicyEndpoint, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      defaultOfferTimeoutSec: 33,
      defaultMaxWaitSec: 180,
      defaultMaxWaitAction: 'CALLBACK',
    }),
  });
  assert.equal(tenantPolicy.status, 200);
  assert.deepEqual(await tenantPolicy.json(), {
    defaultOfferTimeoutSec: 33,
    defaultOfferTimeoutAction: 'COOLDOWN_REQUEUE',
    defaultOfferCooldownSec: 60,
    defaultMaxWaitSec: 180,
    defaultMaxWaitAction: 'CALLBACK',
  });

  const skillId = randomUUID();
  await owner.skill.create({ data: { id: skillId, tenantId, name: `REST skill ${tenantId}` } });
  const requiredSkillsEndpoint = `${endpoint}/${payload.id}/required-skills`;
  const requiredSkillsBody = JSON.stringify({ requiredSkills: [{ skillId, minLevel: 2 }] });
  assert.equal(
    (
      await fetch(requiredSkillsEndpoint, {
        method: 'PUT',
        headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
        body: requiredSkillsBody,
      })
    ).status,
    403,
  );
  const requiredSkills = await fetch(requiredSkillsEndpoint, {
    method: 'PUT',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: requiredSkillsBody,
  });
  assert.equal(requiredSkills.status, 200);
  assert.deepEqual(await requiredSkills.json(), [{ skillId, minLevel: 2 }]);

  const destination = `rest-${tenantId.slice(0, 8)}`;
  const configured = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/voice-destinations/${destination}`,
    {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ queueId: payload.id, tenantId: 'attacker-tenant' }),
    },
  );
  assert.equal(configured.status, 200);
  const configuredPayload = (await configured.json()) as { id: string };
  assert.match(configuredPayload.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(configuredPayload, {
    id: configuredPayload.id,
    destination,
    entryMode: 'DIRECT_QUEUE',
    queueId: payload.id,
    ivrConfig: null,
    isActive: true,
  });

  const disabled = await fetch(`${endpoint}/${payload.id}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ isActive: false, tenantId: 'attacker-tenant' }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as { isActive: boolean }).isActive, false);

  const recordingPolicy = await fetch(`${endpoint}/${payload.id}/recording-policy`, {
    method: 'PUT',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingPauseResumeEnabled: true,
      recordingAgentSelfAccess: true,
      recordingDownloadAllowed: false,
      recordingRetentionDays: 30,
      recordingChannelLayout: 'PER_LEG',
    }),
  });
  assert.equal(recordingPolicy.status, 200);
  assert.deepEqual(await recordingPolicy.json(), {
    queueId: payload.id,
    recordingEnabled: true,
    recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
    recordingAnnouncementLanguage: 'th-TH',
    recordingPauseResumeEnabled: true,
    recordingAgentSelfAccess: true,
    recordingDownloadAllowed: false,
    recordingRetentionDays: 30,
    recordingChannelLayout: 'PER_LEG',
  });

  const auditResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/queue-audit-events`, {
    headers: { authorization: 'Bearer admin-token' },
  });
  assert.equal(auditResponse.status, 200);
  const auditEvents = (await auditResponse.json()) as { action: string; actorUserId: string }[];
  assert.deepEqual(
    auditEvents.map((event) => event.action),
    ['QUEUE_CREATED', 'QUEUE_UPDATED', 'DIRECT_DESTINATION_SET', 'QUEUE_DISABLED', 'QUEUE_UPDATED'],
  );
  assert.ok(auditEvents.every((event) => event.actorUserId === adminUserId));
});
