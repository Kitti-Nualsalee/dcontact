import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { QmController, QM_DATABASE, QM_JOB_PUBLISHER } from './qm-api.js';

// #990: job ที่ QM worker ปิดเป็น FAILED เพราะรอ archive ครบเพดาน ต้องเปิดใหม่ได้เมื่อ Telephony archive สำเร็จภายหลัง
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
const endedAt = new Date('2026-09-05T05:00:00.000Z');

function claims(
  tenantId: string,
  userId: string,
  role: 'agent' | 'supervisor' | 'admin',
): VerifiedOidcClaims {
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

test('manual request เปิด job ที่ FAILED เพราะ recording ไม่ archive ใหม่ได้เมื่อ archive แล้วเท่านั้น', async (t) => {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const otherTeamId = randomUUID();
  const adminId = randomUUID();
  const supervisorId = randomUUID();
  const otherSupervisorId = randomUUID();
  const agentId = randomUUID();
  const queueId = randomUUID();
  const fixture = (
    failureCode: string,
    recording: { archivedAt?: Date; deletedAt?: Date } = {},
    attempts = 0,
  ) => ({
    interactionId: randomUUID(),
    recordingId: randomUUID(),
    jobId: randomUUID(),
    failureCode,
    recording,
    attempts,
  });
  const archivedLater = { archivedAt: new Date(endedAt.getTime() + 7_200_000) };
  const cases = {
    notArchived: fixture('RECORDING_NOT_ARCHIVED'),
    byAdmin: fixture('RECORDING_NOT_ARCHIVED', archivedLater),
    publishFails: fixture('RECORDING_NOT_ARCHIVED', archivedLater),
    concurrent: fixture('RECORDING_NOT_ARCHIVED', archivedLater),
    // FAILED เพราะไม่ archive แล้ว Telephony เลิกลอง (ARCHIVE_ABANDONED) ภายหลัง
    abandonedLater: fixture('RECORDING_NOT_ARCHIVED', {
      deletedAt: new Date(endedAt.getTime() + 7_200_000),
    }),
    deleted: fixture('RECORDING_DELETED', { deletedAt: new Date(endedAt.getTime() + 1_800_000) }),
    providerFailed: fixture('Error', { archivedAt: new Date(endedAt.getTime() + 1_000) }, 1),
  };

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `QM reopen tenant ${tenantId}`,
      slug: `qm-reopen-${tenantId}`,
      sipDomain: `${tenantId}.qm-reopen.test`,
    },
  });
  await owner.team.createMany({
    data: [
      { id: teamId, tenantId, name: `QM reopen team ${tenantId}` },
      { id: otherTeamId, tenantId, name: `QM reopen other team ${tenantId}` },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: adminId,
        tenantId,
        email: `admin-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Admin',
        role: 'ADMIN',
      },
      {
        id: supervisorId,
        tenantId,
        teamId,
        email: `supervisor-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Supervisor',
        role: 'SUPERVISOR',
      },
      {
        id: otherSupervisorId,
        tenantId,
        teamId: otherTeamId,
        email: `other-supervisor-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Other supervisor',
        role: 'SUPERVISOR',
      },
      {
        id: agentId,
        tenantId,
        teamId,
        email: `agent-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent',
        role: 'AGENT',
      },
    ],
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      teamId,
      name: `QM reopen queue ${tenantId}`,
      channels: ['VOICE'],
      transcriptionMode: 'AUTOMATIC',
      transcriptionMaxAttempts: 1,
    },
  });
  for (const fixture of Object.values(cases)) {
    await owner.$executeRaw(
      Prisma.sql`INSERT INTO interactions
        (id, tenant_id, channel, direction, state, queue_id, agent_id, ended_at)
        VALUES (${fixture.interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'COMPLETED',
          ${queueId}::uuid, ${agentId}::uuid, ${endedAt})`,
    );
    await owner.recording.create({
      data: {
        id: fixture.recordingId,
        tenantId,
        interactionId: fixture.interactionId,
        storageKey: `recordings/${tenantId}/${fixture.recordingId}.wav`,
        telephonyPath: `/var/recordings/${tenantId}/${fixture.recordingId}.wav`,
        durationSec: 10,
        startedAt: new Date(endedAt.getTime() - 10_000),
        endedAt,
        ...fixture.recording,
      },
    });
    await owner.qmTranscriptionJob.create({
      data: {
        id: fixture.jobId,
        tenantId,
        interactionId: fixture.interactionId,
        recordingId: fixture.recordingId,
        trigger: 'AUTOMATIC',
        languageHint: 'th-TH',
        status: 'FAILED',
        attempts: fixture.attempts,
        maxAttempts: 1,
        failureCode: fixture.failureCode,
        failureReason: 'fixture',
        completedAt: new Date(endedAt.getTime() + 3_600_000),
        createdAt: endedAt,
      },
    });
  }

  const publishedJobs: Array<{ tenantId: string; job: QmTranscriptionJobMessage }> = [];
  let failNextPublish = false;
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'admin-token') return claims(tenantId, adminId, 'admin');
      if (token === 'supervisor-token') return claims(tenantId, supervisorId, 'supervisor');
      if (token === 'other-supervisor-token') {
        return claims(tenantId, otherSupervisorId, 'supervisor');
      }
      throw new Error('invalid token');
    },
  };

  @Module({
    controllers: [QmController],
    providers: [
      { provide: QM_DATABASE, useValue: application },
      {
        provide: QM_JOB_PUBLISHER,
        useValue: {
          publish: async (input: { tenantId: string; job: QmTranscriptionJobMessage }) => {
            if (failNextPublish) {
              failNextPublish = false;
              throw new Error('kafka unavailable');
            }
            publishedJobs.push(input);
          },
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
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const root = `http://127.0.0.1:${address.port}/api/v1`;
  const request = (interactionId: string, token = 'supervisor-token') =>
    fetch(`${root}/qm/interactions/${interactionId}/transcription-jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
  const persisted = (jobId: string) =>
    owner.qmTranscriptionJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        status: true,
        attempts: true,
        failureCode: true,
        failureReason: true,
        dispatchedAt: true,
        nextAttemptAt: true,
        completedAt: true,
        trigger: true,
      },
    });
  const {
    notArchived,
    byAdmin,
    publishFails,
    concurrent,
    abandonedLater,
    deleted,
    providerFailed,
  } = cases;
  const auditCount = (jobId: string) =>
    owner.qmAuditEvent.count({ where: { tenantId, resourceId: jobId } });
  const before = await persisted(notArchived.jobId);

  // ยังไม่ archive: ปฏิเสธด้วย 409 และ job ไม่เปลี่ยน
  const tooEarly = await request(notArchived.interactionId);
  assert.equal(tooEarly.status, 409);
  assert.equal(((await tooEarly.json()) as { code?: string }).code, 'RECORDING_NOT_ARCHIVED');
  assert.deepEqual(await persisted(notArchived.jobId), before);

  await owner.recording.update({
    where: { id: notArchived.recordingId },
    data: { archivedAt: new Date(endedAt.getTime() + 7_200_000) },
  });

  // Supervisor ทีมอื่นเปิดใหม่ไม่ได้ (สิทธิ์เดียวกับ manual request เดิม)
  assert.equal((await request(notArchived.interactionId, 'other-supervisor-token')).status, 403);
  assert.deepEqual(await persisted(notArchived.jobId), before);
  assert.equal(publishedJobs.length, 0);

  // archive แล้ว: เปิด job เดิมใหม่ ล้างผลรอบที่ล้ม และ publish attempt แรก
  const reopened = await request(notArchived.interactionId);
  assert.equal(reopened.status, 201);
  assert.deepEqual(await reopened.json(), {
    jobId: notArchived.jobId,
    status: 'PENDING',
    trigger: 'AUTOMATIC',
  });
  const job = await persisted(notArchived.jobId);
  assert.equal(job.status, 'PENDING');
  assert.equal(job.attempts, 0);
  assert.equal(job.failureCode, null);
  assert.equal(job.failureReason, null);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.completedAt, null);
  assert.ok(job.dispatchedAt);
  assert.deepEqual(publishedJobs, [
    {
      tenantId,
      job: {
        kind: 'TRANSCRIBE',
        jobId: notArchived.jobId,
        interactionId: notArchived.interactionId,
        recordingId: notArchived.recordingId,
        languageHint: 'th-TH',
        trigger: 'AUTOMATIC',
        attempt: 1,
      },
    },
  ]);
  const audit = await owner.qmAuditEvent.findMany({
    where: { tenantId, resourceId: notArchived.jobId },
    select: { action: true, actorUserId: true, details: true },
  });
  assert.deepEqual(audit, [
    {
      action: 'TRANSCRIPTION_REQUESTED',
      actorUserId: supervisorId,
      details: {
        requestTrigger: 'MANUAL',
        jobTrigger: 'AUTOMATIC',
        reopened: true,
        previousStatus: 'FAILED',
        previousFailureCode: 'RECORDING_NOT_ARCHIVED',
        previousAttempts: 0,
      },
    },
  ]);

  // กดซ้ำระหว่างที่ job รอ worker: ไม่เปิดใหม่และไม่ publish ซ้ำ
  const repeated = await request(notArchived.interactionId);
  assert.equal(repeated.status, 201);
  assert.equal(((await repeated.json()) as { status: string }).status, 'PENDING');
  assert.equal(publishedJobs.length, 1);
  assert.equal(await auditCount(notArchived.jobId), 1);

  // Admin เปิดใหม่ได้ทุกทีม
  const adminReopened = await request(byAdmin.interactionId, 'admin-token');
  assert.equal(adminReopened.status, 201);
  assert.equal(((await adminReopened.json()) as { status: string }).status, 'PENDING');
  assert.equal(publishedJobs.length, 2);
  assert.equal(publishedJobs[1]!.job.jobId, byAdmin.jobId);

  // publish ล้มหลังเปิดใหม่: client ได้ 500 แต่ job เปิดใหม่แล้วและ dispatchedAt ถูกคืนเป็น null
  // QmRetryDispatcher จะหยิบไปทำต่อเมื่อค้างเกินเกณฑ์ (createdAt เก่า) และกดซ้ำก็ publish ได้
  failNextPublish = true;
  assert.equal((await request(publishFails.interactionId)).status, 500);
  let failedPublishJob = await persisted(publishFails.jobId);
  assert.equal(failedPublishJob.status, 'PENDING');
  assert.equal(failedPublishJob.dispatchedAt, null);
  assert.equal(await auditCount(publishFails.jobId), 1);
  assert.equal((await request(publishFails.interactionId)).status, 201);
  failedPublishJob = await persisted(publishFails.jobId);
  assert.ok(failedPublishJob.dispatchedAt);
  assert.equal(publishedJobs.length, 3);
  assert.equal(await auditCount(publishFails.jobId), 1);

  // กดพร้อมกัน: เปิดใหม่และ publish ครั้งเดียว
  const parallel = await Promise.all([
    request(concurrent.interactionId),
    request(concurrent.interactionId),
  ]);
  assert.deepEqual(
    parallel.map((response) => response.status),
    [201, 201],
  );
  assert.equal(publishedJobs.filter((input) => input.job.jobId === concurrent.jobId).length, 1);
  assert.equal(await auditCount(concurrent.jobId), 1);

  // FAILED เพราะไม่ archive แล้ว recording ถูกลบภายหลัง: 404 และ job ไม่เปลี่ยน
  const abandonedBefore = await persisted(abandonedLater.jobId);
  assert.equal((await request(abandonedLater.interactionId)).status, 404);
  assert.deepEqual(await persisted(abandonedLater.jobId), abandonedBefore);

  // recording ถูกลบ: ไม่มี recording ให้ถอดเสียง จึงได้ 404 และ job RECORDING_DELETED ไม่เปลี่ยน
  const deletedBefore = await persisted(deleted.jobId);
  assert.equal((await request(deleted.interactionId)).status, 404);
  assert.deepEqual(await persisted(deleted.jobId), deletedBefore);

  // provider ล้มครบ maxAttempts: พฤติกรรมเดิม คืน job FAILED โดยไม่เปิดใหม่
  const providerBefore = await persisted(providerFailed.jobId);
  const providerResponse = await request(providerFailed.interactionId);
  assert.equal(providerResponse.status, 201);
  assert.equal(((await providerResponse.json()) as { status: string }).status, 'FAILED');
  assert.deepEqual(await persisted(providerFailed.jobId), providerBefore);
  assert.equal(publishedJobs.length, 4);
});
