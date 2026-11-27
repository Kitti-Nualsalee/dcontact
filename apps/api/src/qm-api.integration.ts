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
import {
  RECORDING_DATABASE,
  RECORDING_STORAGE,
  RecordingController,
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

test.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));

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
  // the Router's evidence of which team answered each call: the Supervisor gate reads it
  await owner.voiceInteractionHandlingAttribution.createMany({
    data: [
      {
        tenantId,
        interactionId,
        agentId,
        teamId,
        acceptedAt: new Date('2026-09-05T04:59:45.000Z'),
        sourceEventId: `test:${interactionId}`,
      },
      {
        tenantId: foreignTenantId,
        interactionId: foreignInteractionId,
        agentId: foreignAgentId,
        teamId: foreignTeamId,
        acceptedAt: new Date('2026-09-05T04:59:45.000Z'),
        sourceEventId: `test:${foreignInteractionId}`,
      },
    ],
  });
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
    await owner.qmFormVersion.deleteMany({ where: { tenantId } });
    await owner.qmForm.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptSegment.deleteMany({ where: { tenantId } });
    await owner.qmTranscript.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.voiceInteractionHandlingAttribution.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queueAuditEvent.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.commandReceipt.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmConsoleContext.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmAuditEvent.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.qmEvaluation.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.voiceInteractionHandlingAttribution.deleteMany({
      where: { tenantId: foreignTenantId },
    });
    await owner.interaction.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.queue.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.user.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.team.deleteMany({ where: { tenantId: foreignTenantId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, foreignTenantId] } } });
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
          text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ', // allow-thai: Thai transcript text
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
  // #971: a human evaluation draft of the same call (created later) must not be picked up by the auto-QM route
  const humanForm = await owner.qmForm.create({
    data: { tenantId, name: `Human form ${tenantId}`, createdByUserId: supervisorId },
  });
  const humanVersion = await owner.qmFormVersion.create({
    data: {
      tenantId,
      formId: humanForm.id,
      version: 1,
      definition: { sections: [] },
      createdByUserId: supervisorId,
    },
  });
  const humanDraft = await owner.qmEvaluation.create({
    data: {
      tenantId,
      interactionId,
      agentId,
      evaluatorId: supervisorId,
      source: 'HUMAN',
      status: 'DRAFT',
      formVersionId: humanVersion.id,
      formSnapshot: {
        formId: humanForm.id,
        formName: 'x',
        version: 1,
        definition: { sections: [] },
      },
      answers: [],
      createdAt: new Date(Date.now() + 60_000),
    },
  });
  for (const [method, path] of [
    ['GET', `/qm/evaluations/${humanDraft.id}`],
    ['POST', `/qm/evaluations/${humanDraft.id}/publish`],
  ] as const) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: auth('supervisor-token'),
      ...(method === 'POST'
        ? { body: JSON.stringify({ commandId: 'b3c1f3a2-6a43-4a8b-9b8a-2f1d7c3e4a51' }) }
        : {}),
    });
    assert.equal(response.status, 404, `${method} ${path}`);
  }

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
          text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ', // allow-thai: Thai transcript text
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

test("a Supervisor reaches legacy QM routes through the team that handled the call, not the agent's current team", async (t) => {
  const tenantId = randomUUID();
  const ids = {
    teamA: randomUUID(),
    teamB: randomUUID(),
    supervisorA: randomUUID(),
    supervisorB: randomUUID(),
    admin: randomUUID(),
    agent: randomUUID(),
    queue: randomUUID(),
    handled: randomUUID(),
    noEvidence: randomUUID(),
  };
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `QM gate ${tenantId}`,
      slug: `qm-gate-${tenantId}`,
      sipDomain: `${tenantId}.qm-gate.test`,
    },
  });
  await owner.team.createMany({
    data: [
      { id: ids.teamA, tenantId, name: 'Team A' },
      { id: ids.teamB, tenantId, name: 'Team B' },
    ],
  });
  const user = (id: string, role: 'AGENT' | 'SUPERVISOR' | 'ADMIN', teamId: string | null) => ({
    id,
    tenantId,
    teamId,
    role,
    email: `${id}@test.local`,
    passwordHash: 'test',
    displayName: role,
  });
  await owner.user.createMany({
    data: [
      user(ids.supervisorA, 'SUPERVISOR', ids.teamA),
      user(ids.supervisorB, 'SUPERVISOR', ids.teamB),
      user(ids.admin, 'ADMIN', null),
      user(ids.agent, 'AGENT', ids.teamA),
    ],
  });
  await owner.queue.create({
    data: {
      id: ids.queue,
      tenantId,
      name: `Gate queue ${tenantId}`,
      channels: ['VOICE'],
      transcriptionMode: 'MANUAL',
    },
  });
  const fixtures: Record<
    string,
    { transcriptId: string; jobId: string; evaluationId: string; recordingId: string }
  > = {};
  for (const interactionId of [ids.handled, ids.noEvidence]) {
    await owner.$executeRaw(
      Prisma.sql`INSERT INTO interactions (id, tenant_id, channel, direction, state, queue_id, agent_id, ended_at)
        VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'COMPLETED',
          ${ids.queue}::uuid, ${ids.agent}::uuid, NOW())`,
    );
    const recording = await owner.recording.create({
      data: {
        tenantId,
        interactionId,
        storageKey: `recordings/${interactionId}.wav`,
        telephonyPath: `/recordings/${interactionId}.wav`,
        startedAt: new Date('2026-11-20T03:00:00.000Z'),
        endedAt: new Date('2026-11-20T03:01:00.000Z'),
        archivedAt: new Date('2026-11-20T03:01:01.000Z'),
      },
    });
    const job = await owner.qmTranscriptionJob.create({
      data: {
        tenantId,
        interactionId,
        recordingId: recording.id,
        trigger: 'AUTOMATIC',
        status: 'READY',
        languageHint: 'th-TH',
        maxAttempts: 1,
      },
    });
    const transcript = await owner.qmTranscript.create({
      data: {
        tenantId,
        interactionId,
        recordingId: recording.id,
        jobId: job.id,
        providerId: 'test-asr',
        modelId: 'test-model',
        language: 'th-TH',
        confidenceAvg: 0.9,
        baseline: {},
      },
    });
    const evaluation = await owner.qmEvaluation.create({
      data: {
        tenantId,
        interactionId,
        agentId: ids.agent,
        source: 'AUTO_DRAFT',
        status: 'DRAFT',
        providerId: 'scorer',
        modelId: 'score-v1',
        promptVersion: 'prompt-1',
        answers: [],
      },
    });
    fixtures[interactionId] = {
      transcriptId: transcript.id,
      jobId: job.id,
      evaluationId: evaluation.id,
      recordingId: recording.id,
    };
  }
  // only the first call has evidence of which team answered it
  await owner.voiceInteractionHandlingAttribution.create({
    data: {
      tenantId,
      interactionId: ids.handled,
      agentId: ids.agent,
      teamId: ids.teamA,
      acceptedAt: new Date('2026-11-20T02:59:50.000Z'),
      sourceEventId: `test:${ids.handled}`,
    },
  });
  // the agent moves to team B after the call
  await owner.user.update({ where: { id: ids.agent }, data: { teamId: ids.teamB } });

  const tokens: Record<string, VerifiedOidcClaims> = {
    'supervisor-a': claims(tenantId, ids.supervisorA, 'supervisor'),
    'supervisor-b': claims(tenantId, ids.supervisorB, 'supervisor'),
    admin: claims(tenantId, ids.admin, 'admin'),
  };
  @Module({
    controllers: [QmController, RecordingController],
    providers: [
      { provide: QM_DATABASE, useValue: application },
      { provide: QM_JOB_PUBLISHER, useValue: { publish: async () => undefined } },
      // the legacy presigned playback used by the Console review page follows the same rule
      { provide: RECORDING_DATABASE, useValue: application },
      { provide: TELEPHONY_COMMAND_PUBLISHER, useValue: { publish: async () => undefined } },
      {
        provide: RECORDING_STORAGE,
        useValue: {
          presignPlayback: async () => ({
            url: 'https://storage.test/recording?signature=short-lived',
            expiresAt: new Date(Date.now() + 300_000),
          }),
          deleteObject: async () => undefined,
        },
      },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (token: string) => {
            const found = tokens[token];
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
  class GateModule {}
  const app = await NestFactory.create(GateModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await owner.qmConsoleContext.deleteMany({ where: { tenantId } });
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.recordingAuditEvent.deleteMany({ where: { tenantId } });
    await owner.commandReceipt.deleteMany({ where: { tenantId } });
    await owner.qmEvaluation.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptSegment.deleteMany({ where: { tenantId } });
    await owner.qmTranscript.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.voiceInteractionHandlingAttribution.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });
  const root = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  const status = async (token: string, interactionId: string, route: string) => {
    const fixture = fixtures[interactionId]!;
    const [method, path] = {
      transcript: ['GET', `/qm/transcripts/${fixture.transcriptId}`],
      job: ['GET', `/qm/transcription-jobs/${fixture.jobId}`],
      context: ['POST', `/qm/interactions/${interactionId}/console-context`],
      evaluation: ['GET', `/qm/evaluations/${fixture.evaluationId}`],
      playback: ['POST', `/recordings/${fixture.recordingId}/playback`],
    }[route]!;
    const response = await fetch(`${root}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'POST'
        ? { body: route === 'playback' ? JSON.stringify({ download: false }) : '{}' }
        : {}),
    });
    return response.status;
  };
  const routes = ['transcript', 'job', 'context', 'evaluation', 'playback'];
  const ok = {
    transcript: 200,
    job: 200,
    context: 201,
    evaluation: 200,
    playback: 201,
  } as Record<string, number>;
  // a route that answers 403 rather than 404 when the caller may not see the call
  const deniedStatus = (route: string) => (route === 'playback' ? 403 : 404);

  for (const route of routes) {
    // the team that answered keeps the call after the agent moved
    assert.equal(await status('supervisor-a', ids.handled, route), ok[route], `A ${route}`);
    // the agent's new team does not inherit it
    assert.equal(
      await status('supervisor-b', ids.handled, route),
      deniedStatus(route),
      `B ${route}`,
    );
    // no evidence, no Supervisor
    assert.equal(
      await status('supervisor-a', ids.noEvidence, route),
      deniedStatus(route),
      `no evidence ${route}`,
    );
    // Admin is unchanged: every team
    assert.equal(await status('admin', ids.noEvidence, route), ok[route], `admin ${route}`);
  }
  const json = { authorization: 'Bearer supervisor-a', 'content-type': 'application/json' };
  // the context issued to the answering team's Supervisor can be read back
  const issued = await fetch(`${root}/qm/interactions/${ids.handled}/console-context`, {
    method: 'POST',
    headers: json,
    body: '{}',
  });
  const { contextId } = (await issued.json()) as { contextId: string };
  assert.equal(
    (await fetch(`${root}/qm/console-contexts/${contextId}`, { headers: json })).status,
    200,
  );
  // the answering team's Supervisor can publish the auto-QM draft, the agent's new team cannot
  const publish = (token: string) =>
    fetch(`${root}/qm/evaluations/${fixtures[ids.handled]!.evaluationId}/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID() }),
    });
  assert.equal((await publish('supervisor-b')).status, 404);
  assert.equal((await publish('supervisor-a')).status, 201);
  // a manual transcription request reaches the gate and passes for the answering team
  const manual = await fetch(`${root}/qm/interactions/${ids.handled}/transcription-jobs`, {
    method: 'POST',
    headers: json,
    body: '{}',
  });
  assert.notEqual(manual.status, 403);
  assert.notEqual(manual.status, 404);
  const reviewTranscription = await fetch(
    `${root}/qm/interactions/${ids.noEvidence}/transcription-jobs`,
    { method: 'POST', headers: { authorization: 'Bearer supervisor-a' } },
  );
  assert.equal(reviewTranscription.status, 403);

  // a deactivated Supervisor loses access at once
  await owner.user.update({ where: { id: ids.supervisorA }, data: { isActive: false } });
  for (const route of routes) {
    assert.equal(
      await status('supervisor-a', ids.handled, route),
      deniedStatus(route),
      `inactive ${route}`,
    );
  }
});
