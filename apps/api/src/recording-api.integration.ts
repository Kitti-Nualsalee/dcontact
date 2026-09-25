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
  RecordingController,
  RECORDING_DATABASE,
  RECORDING_STORAGE,
  TELEPHONY_COMMAND_PUBLISHER,
} from './recording-api.js';

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

test('an agent pauses and resumes only its permitted active recording with a reason and audit trail', async (t) => {
  const tenantId = randomUUID();
  const adminUserId = randomUUID();
  const agentUserId = randomUUID();
  const otherAgentUserId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  const foreignTenantId = randomUUID();
  const foreignQueueId = randomUUID();
  const foreignInteractionId = randomUUID();
  const foreignRecordingId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Recording tenant ${tenantId}`,
      slug: `recording-${tenantId}`,
      sipDomain: `${tenantId}.recording.test`,
    },
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
        id: agentUserId,
        tenantId,
        extension: '6100',
        email: `agent-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent',
        role: 'AGENT',
      },
      {
        id: otherAgentUserId,
        tenantId,
        extension: '6101',
        email: `other-agent-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Other agent',
        role: 'AGENT',
      },
    ],
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: `Recording queue ${tenantId}`,
      channels: ['VOICE'],
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingPauseResumeEnabled: true,
      recordingAgentSelfAccess: true,
      recordingRetentionDays: 30,
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id, metadata)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueId}::uuid,
        ${agentUserId}::uuid,
        ${`call-${interactionId}`},
        ${JSON.stringify({ vendor: 'freeswitch', telephonyNodeId: 'fs-test' })}::jsonb
      )`,
  );
  await owner.recording.create({
    data: {
      id: recordingId,
      tenantId,
      interactionId,
      storageKey: `recordings/${tenantId}/${recordingId}.wav`,
      telephonyPath: `/var/recordings/${tenantId}/${recordingId}.wav`,
      startedAt: new Date('2026-09-05T02:00:00.000Z'),
    },
  });
  await owner.tenant.create({
    data: {
      id: foreignTenantId,
      name: `Foreign recording tenant ${foreignTenantId}`,
      slug: `foreign-recording-${foreignTenantId}`,
      sipDomain: `${foreignTenantId}.recording.test`,
    },
  });
  await owner.queue.create({
    data: {
      id: foreignQueueId,
      tenantId: foreignTenantId,
      name: `Foreign recording queue ${foreignTenantId}`,
      channels: ['VOICE'],
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id)
      VALUES (
        ${foreignInteractionId}::uuid,
        ${foreignTenantId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${foreignQueueId}::uuid
      )`,
  );
  await owner.recording.create({
    data: {
      id: foreignRecordingId,
      tenantId: foreignTenantId,
      interactionId: foreignInteractionId,
      storageKey: `recordings/${foreignTenantId}/${foreignRecordingId}.wav`,
      telephonyPath: `/var/recordings/${foreignTenantId}/${foreignRecordingId}.wav`,
      startedAt: new Date('2026-09-05T02:00:00.000Z'),
    },
  });

  const published: unknown[] = [];
  const deletedStorageKeys: string[] = [];
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'agent-token') return claims(tenantId, agentUserId, 'agent');
      if (token === 'other-agent-token') return claims(tenantId, otherAgentUserId, 'agent');
      if (token === 'admin-token') return claims(tenantId, adminUserId, 'admin');
      throw new Error('invalid token');
    },
  };

  @Module({
    controllers: [RecordingController],
    providers: [
      { provide: RECORDING_DATABASE, useValue: application },
      {
        provide: TELEPHONY_COMMAND_PUBLISHER,
        useValue: { publish: async (command: unknown) => published.push(command) },
      },
      {
        provide: RECORDING_STORAGE,
        useValue: {
          presignPlayback: async () => ({
            url: `https://storage.test/recordings/${recordingId}?signature=short-lived`,
            expiresAt: new Date(Date.now() + 300_000),
          }),
          deleteObject: async (storageKey: string) => void deletedStorageKeys.push(storageKey),
        },
      },
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
    await owner.recordingAuditEvent.deleteMany({ where: { tenantId } });
    await owner.recordingLegalHold.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await owner.recording.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.interaction.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.queue.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.tenant.delete({ where: { id: foreignTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/recordings/${recordingId}`;
  const crossTenantPlayback = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/recordings/${foreignRecordingId}/playback`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
      body: JSON.stringify({ download: false }),
    },
  );
  assert.equal(crossTenantPlayback.status, 404);
  const control = (operation: 'pause' | 'resume', token: string, reason: string) =>
    fetch(`${endpoint}/${operation}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });

  assert.equal((await control('pause', 'other-agent-token', 'ไม่ใช่สายของตน')).status, 403);
  const paused = await control('pause', 'agent-token', 'กำลังรับข้อมูลบัตร');
  assert.equal(paused.status, 201);
  assert.deepEqual(await paused.json(), { recordingId, status: 'PAUSED' });
  assert.deepEqual(published, [
    {
      tenantId,
      command: {
        callUuid: `call-${interactionId}`,
        vendor: 'freeswitch',
        telephonyNodeId: 'fs-test',
        type: 'recording.pause',
        recordingPath: `/var/recordings/${tenantId}/${recordingId}.wav`,
      },
    },
  ]);

  const resumed = await control('resume', 'agent-token', 'รับข้อมูลเสร็จแล้ว');
  assert.equal(resumed.status, 201);
  assert.deepEqual(await resumed.json(), { recordingId, status: 'RECORDING' });
  assert.equal(published.length, 2);

  const playback = await fetch(`${endpoint}/playback`, {
    method: 'POST',
    headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
    body: JSON.stringify({ download: false }),
  });
  assert.equal(playback.status, 201);
  const playbackPayload = (await playback.json()) as { url: string; expiresAt: string };
  assert.equal(
    playbackPayload.url,
    `https://storage.test/recordings/${recordingId}?signature=short-lived`,
  );
  assert.ok(new Date(playbackPayload.expiresAt).getTime() > Date.now());
  assert.equal(
    (
      await fetch(`${endpoint}/playback`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-token', 'content-type': 'application/json' },
        body: JSON.stringify({ download: true }),
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (
      await owner.recordingAuditEvent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => ({
      action: event.action,
      reason: event.reason,
      actorUserId: event.actorUserId,
    })),
    [
      { action: 'PAUSED', reason: 'กำลังรับข้อมูลบัตร', actorUserId: agentUserId },
      { action: 'RESUMED', reason: 'รับข้อมูลเสร็จแล้ว', actorUserId: agentUserId },
      { action: 'PLAYBACK_URL_ISSUED', reason: null, actorUserId: agentUserId },
      { action: 'DOWNLOAD_DENIED', reason: null, actorUserId: agentUserId },
    ],
  );

  await owner.recording.update({
    where: { id: recordingId },
    data: { endedAt: new Date('2026-07-01T00:00:00.000Z') },
  });
  const legalHold = await fetch(`${endpoint}/legal-holds`, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'เก็บไว้เพื่อการตรวจสอบ' }),
  });
  assert.equal(legalHold.status, 201);
  const legalHoldPayload = (await legalHold.json()) as { id: string };
  const retentionEndpoint = `http://127.0.0.1:${address.port}/api/v1/recordings/retention/run`;
  const runRetention = () =>
    fetch(retentionEndpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ now: '2026-09-05T00:00:00.000Z' }),
    });
  assert.deepEqual(await (await runRetention()).json(), { deletedRecordingIds: [] });
  assert.equal(
    (
      await fetch(`${endpoint}/legal-holds/${legalHoldPayload.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer admin-token' },
      })
    ).status,
    204,
  );
  assert.deepEqual(await (await runRetention()).json(), { deletedRecordingIds: [recordingId] });
  assert.deepEqual(deletedStorageKeys, [`recordings/${tenantId}/${recordingId}.wav`]);
  assert.ok((await owner.recording.findUniqueOrThrow({ where: { id: recordingId } })).deletedAt);
  assert.deepEqual(
    (
      await owner.recordingAuditEvent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.action),
    [
      'PAUSED',
      'RESUMED',
      'PLAYBACK_URL_ISSUED',
      'DOWNLOAD_DENIED',
      'LEGAL_HOLD_PLACED',
      'LEGAL_HOLD_RELEASED',
      'RETENTION_DELETED',
    ],
  );
  console.log(
    `PHASE_ONE_EVIDENCE ${JSON.stringify({
      kind: 'signed-playback-tenant-isolation',
      ownPlaybackStatus: playback.status,
      crossTenantPlaybackStatus: crossTenantPlayback.status,
      downloadDefaultDenied: true,
      auditActions: ['PLAYBACK_URL_ISSUED', 'DOWNLOAD_DENIED'],
    })}`,
  );
});
