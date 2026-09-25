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
import { QmController, QM_DATABASE, QM_JOB_PUBLISHER } from './qm-api.js';

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

test('supervisor starts manual transcription, audits transcript access, and human-publishes a team draft', async (t) => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const teamId = randomUUID();
  const foreignTeamId = randomUUID();
  const adminId = randomUUID();
  const supervisorId = randomUUID();
  const agentId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  const foreignSupervisorId = randomUUID();
  const foreignAgentId = randomUUID();
  const foreignQueueId = randomUUID();
  const foreignInteractionId = randomUUID();
  const foreignEvaluationId = randomUUID();
  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `QM API tenant ${tenantId}`,
        slug: `qm-api-${tenantId}`,
        sipDomain: `${tenantId}.qm-api.test`,
      },
      {
        id: foreignTenantId,
        name: `Foreign QM API tenant ${foreignTenantId}`,
        slug: `foreign-qm-api-${foreignTenantId}`,
        sipDomain: `${foreignTenantId}.qm-api.test`,
      },
    ],
  });
  await owner.team.createMany({
    data: [
      { id: teamId, tenantId, name: `QM team ${tenantId}` },
      {
        id: foreignTeamId,
        tenantId: foreignTenantId,
        name: `QM team ${foreignTenantId}`,
      },
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
        id: agentId,
        tenantId,
        teamId,
        email: `agent-${tenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Agent',
        role: 'AGENT',
      },
      {
        id: foreignSupervisorId,
        tenantId: foreignTenantId,
        teamId: foreignTeamId,
        email: `supervisor-${foreignTenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Foreign supervisor',
        role: 'SUPERVISOR',
      },
      {
        id: foreignAgentId,
        tenantId: foreignTenantId,
        teamId: foreignTeamId,
        email: `agent-${foreignTenantId}@test.local`,
        passwordHash: 'test',
        displayName: 'Foreign agent',
        role: 'AGENT',
      },
    ],
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      teamId,
      name: `QM API queue ${tenantId}`,
      channels: ['VOICE'],
      recordingAgentSelfAccess: true,
    },
  });
  await owner.queue.create({
    data: {
      id: foreignQueueId,
      tenantId: foreignTenantId,
      teamId: foreignTeamId,
      name: `Foreign QM queue ${foreignTenantId}`,
      channels: ['VOICE'],
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, ended_at)
      VALUES
      (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'WRAPUP', ${queueId}::uuid, ${agentId}::uuid, NOW()),
      (${foreignInteractionId}::uuid, ${foreignTenantId}::uuid, 'VOICE', 'INBOUND', 'WRAPUP', ${foreignQueueId}::uuid, ${foreignAgentId}::uuid, NOW())`,
  );
  await owner.recording.create({
    data: {
      id: recordingId,
      tenantId,
      interactionId,
      storageKey: `recordings/${tenantId}/${recordingId}.wav`,
      telephonyPath: `/var/recordings/${tenantId}/${recordingId}.wav`,
      durationSec: 10,
      startedAt: new Date('2026-09-05T04:59:50.000Z'),
      endedAt: new Date('2026-09-05T05:00:00.000Z'),
    },
  });
  await owner.qmEvaluation.create({
    data: {
      id: foreignEvaluationId,
      tenantId: foreignTenantId,
      interactionId: foreignInteractionId,
      agentId: foreignAgentId,
      source: 'AUTO_DRAFT',
      status: 'DRAFT',
      providerId: 'foreign-scorer',
      modelId: 'foreign-model',
      promptVersion: 'foreign-prompt',
      answers: [],
    },
  });

  const publishedJobs: unknown[] = [];
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'admin-token') return claims(tenantId, adminId, 'admin');
      if (token === 'supervisor-token') return claims(tenantId, supervisorId, 'supervisor');
      if (token === 'agent-token') return claims(tenantId, agentId, 'agent');
      if (token === 'foreign-supervisor-token') {
        return claims(foreignTenantId, foreignSupervisorId, 'supervisor');
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
        useValue: { publish: async (job: unknown) => publishedJobs.push(job) },
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
    await owner.commandReceipt.deleteMany({ where: { tenantId } });
    await owner.qmConsoleContext.deleteMany({ where: { tenantId } });
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmEvaluation.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptSegment.deleteMany({ where: { tenantId } });
    await owner.qmTranscript.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.commandReceipt.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmConsoleContext.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmAuditEvent.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmEvaluation.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.interaction.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.queue.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.user.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.team.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, foreignTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const address = app.getHttpServer().address() as AddressInfo;
  const root = `http://127.0.0.1:${address.port}/api/v1`;
  const auth = (token: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
  const policy = await fetch(`${root}/queues/${queueId}/qm-policy`, {
    method: 'PUT',
    headers: auth('admin-token'),
    body: JSON.stringify({
      transcriptionMode: 'MANUAL',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 2,
      autoQmEnabled: true,
    }),
  });
  assert.equal(policy.status, 200);

  const requested = await fetch(`${root}/qm/interactions/${interactionId}/transcription-jobs`, {
    method: 'POST',
    headers: auth('supervisor-token'),
    body: '{}',
  });
  assert.equal(requested.status, 201);
  const job = (await requested.json()) as { jobId: string; status: string; trigger: string };
  assert.equal(job.status, 'PENDING');
  assert.equal(job.trigger, 'MANUAL');
  assert.equal(publishedJobs.length, 1);
  const jobStatus = await fetch(`${root}/qm/transcription-jobs/${job.jobId}`, {
    headers: auth('supervisor-token'),
  });
  assert.equal(jobStatus.status, 200);
  assert.deepEqual(await jobStatus.json(), {
    jobId: job.jobId,
    interactionId,
    status: 'PENDING',
    trigger: 'MANUAL',
    attempts: 0,
    maxAttempts: 2,
    failureCode: null,
    failureReason: null,
    nextAttemptAt: null,
  });

  const transcript = await owner.qmTranscript.create({
    data: {
      tenantId,
      interactionId,
      recordingId,
      jobId: job.jobId,
      providerId: 'thai-provider',
      modelId: 'thai-v1',
      language: 'th-TH',
      confidenceAvg: 0.9,
      baseline: { audioDurationMs: 10_000, processingLatencyMs: 700 },
      segments: {
        create: {
          tenantId,
          speaker: 'AGENT',
          startMs: 1_000,
          endMs: 3_000,
          text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
          confidence: 0.9,
        },
      },
    },
  });
  const evaluation = await owner.qmEvaluation.create({
    data: {
      tenantId,
      interactionId,
      agentId,
      source: 'AUTO_DRAFT',
      status: 'DRAFT',
      providerId: 'evidence-scorer',
      modelId: 'score-v1',
      promptVersion: 'prompt-1',
      answers: [{ questionId: 'greeting', value: 'YES', evidence: [] }],
    },
  });

  const consoleContext = await fetch(`${root}/qm/interactions/${interactionId}/console-context`, {
    method: 'POST',
    headers: auth('supervisor-token'),
    body: '{}',
  });
  assert.equal(consoleContext.status, 201);
  const consoleContextBody = (await consoleContext.json()) as {
    contextId: string;
    expiresAt: string;
  };
  assert.match(consoleContextBody.contextId, /^[0-9a-f-]{36}$/i);
  assert.match(consoleContextBody.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const context = await fetch(`${root}/qm/console-contexts/${consoleContextBody.contextId}`, {
    headers: auth('supervisor-token'),
  });
  assert.equal(context.status, 200);
  assert.deepEqual(await context.json(), {
    interaction: { id: interactionId, channel: 'VOICE', queueName: `QM API queue ${tenantId}` },
    recording: { id: recordingId, status: 'AVAILABLE', pauseIntervals: [] },
    transcript: {
      id: transcript.id,
      language: 'th-TH',
      segments: [
        {
          id: (
            await owner.qmTranscriptSegment.findFirstOrThrow({
              where: { transcriptId: transcript.id },
            })
          ).id,
          speaker: 'AGENT',
          startMs: 1_000,
          endMs: 3_000,
          text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
        },
      ],
    },
    evaluation: {
      id: evaluation.id,
      status: 'DRAFT',
      source: 'AUTO_DRAFT',
      answers: {},
    },
  });
  assert.equal(
    (
      await fetch(`${root}/qm/console-contexts/${consoleContextBody.contextId}`, {
        headers: auth('admin-token'),
      })
    ).status,
    404,
  );

  assert.equal(
    (await fetch(`${root}/qm/evaluations/${evaluation.id}`, { headers: auth('agent-token') }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(`${root}/qm/evaluations/${foreignEvaluationId}`, { headers: auth('admin-token') }))
      .status,
    404,
  );
  const review = await fetch(`${root}/qm/evaluations/${evaluation.id}`, {
    headers: auth('supervisor-token'),
  });
  assert.equal(review.status, 200);
  assert.equal(((await review.json()) as { status: string }).status, 'DRAFT');

  const transcriptResponse = await fetch(`${root}/qm/transcripts/${transcript.id}`, {
    headers: auth('agent-token'),
  });
  assert.equal(transcriptResponse.status, 200);
  assert.equal(((await transcriptResponse.json()) as { language: string }).language, 'th-TH');
  assert.equal(
    (
      await fetch(`${root}/qm/evaluations/${evaluation.id}/publish`, {
        method: 'POST',
        headers: auth('agent-token'),
        body: '{}',
      })
    ).status,
    403,
  );
  const publish = await fetch(`${root}/qm/evaluations/${evaluation.id}/publish`, {
    method: 'POST',
    headers: auth('supervisor-token'),
    body: JSON.stringify({ commandId: 'e5e94bea-4a4f-4f45-a4fb-d0d1db07e899' }),
  });
  assert.equal(publish.status, 201);
  assert.deepEqual(await publish.json(), {
    id: evaluation.id,
    status: 'PUBLISHED',
    evaluatorId: supervisorId,
  });
  const repeatedPublish = await fetch(`${root}/qm/evaluations/${evaluation.id}/publish`, {
    method: 'POST',
    headers: auth('supervisor-token'),
    body: JSON.stringify({ commandId: 'e5e94bea-4a4f-4f45-a4fb-d0d1db07e899' }),
  });
  assert.equal(repeatedPublish.status, 201);
  assert.deepEqual(await repeatedPublish.json(), {
    id: evaluation.id,
    status: 'PUBLISHED',
    evaluatorId: supervisorId,
  });
  const foreignPublish = await fetch(`${root}/qm/evaluations/${foreignEvaluationId}/publish`, {
    method: 'POST',
    headers: auth('foreign-supervisor-token'),
    body: JSON.stringify({ commandId: '48ef8d3d-c90e-4e71-a5e0-ebd58d78de59' }),
  });
  assert.equal(foreignPublish.status, 201);
  assert.deepEqual(await foreignPublish.json(), {
    id: foreignEvaluationId,
    status: 'PUBLISHED',
    evaluatorId: foreignSupervisorId,
  });
  assert.deepEqual(
    (await owner.qmAuditEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })).map(
      (event) => event.action,
    ),
    ['TRANSCRIPTION_REQUESTED', 'TRANSCRIPT_ACCESSED', 'EVALUATION_PUBLISHED'],
  );
  console.log(
    `PHASE_ONE_EVIDENCE ${JSON.stringify({
      kind: 'qm-human-publish-api',
      transcriptionStatus: job.status,
      transcriptLanguage: 'th-TH',
      draftHiddenFromAgent: true,
      crossTenantEvaluationHidden: true,
      publishedStatusByTenant: ['PUBLISHED', 'PUBLISHED'],
      auditActions: ['TRANSCRIPTION_REQUESTED', 'TRANSCRIPT_ACCESSED', 'EVALUATION_PUBLISHED'],
    })}`,
  );
});
