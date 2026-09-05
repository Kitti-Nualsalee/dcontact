import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCallEvent } from '@d-contact/shared';
import { QmTranscriptionWorker } from '../../qm/src/qm-transcription-worker.js';
import { QmTranscriptionWorkflow } from '../../qm/src/qm-transcription-workflow.js';
import { InboundVoiceRouter } from '../../router/src/inbound-voice-router.js';
import { TelephonyRecordingLifecycle } from '../../telephony/src/recording-lifecycle.js';

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

interface TenantFixture {
  tenantId: string;
  teamId: string;
  adminId: string;
  supervisorId: string;
  agentId: string;
  queueId: string;
  callUuid: string;
  destination: string;
}

async function createTenant(label: string, destination: string): Promise<TenantFixture> {
  const fixture: TenantFixture = {
    tenantId: randomUUID(),
    teamId: randomUUID(),
    adminId: randomUUID(),
    supervisorId: randomUUID(),
    agentId: randomUUID(),
    queueId: randomUUID(),
    callUuid: randomUUID(),
    destination,
  };
  const skillId = randomUUID();
  await owner.tenant.create({
    data: {
      id: fixture.tenantId,
      name: `Phase 1 ${label}`,
      slug: `phase-one-${label}-${fixture.tenantId}`,
      sipDomain: `${fixture.tenantId}.phase-one.test`,
    },
  });
  await owner.team.create({
    data: { id: fixture.teamId, tenantId: fixture.tenantId, name: `ทีม ${label}` },
  });
  await owner.user.createMany({
    data: [
      {
        id: fixture.adminId,
        tenantId: fixture.tenantId,
        email: `admin-${fixture.tenantId}@test.local`,
        passwordHash: 'test',
        displayName: `Admin ${label}`,
        role: 'ADMIN',
      },
      {
        id: fixture.supervisorId,
        tenantId: fixture.tenantId,
        teamId: fixture.teamId,
        email: `supervisor-${fixture.tenantId}@test.local`,
        passwordHash: 'test',
        displayName: `Supervisor ${label}`,
        role: 'SUPERVISOR',
      },
      {
        id: fixture.agentId,
        tenantId: fixture.tenantId,
        teamId: fixture.teamId,
        email: `agent-${fixture.tenantId}@test.local`,
        passwordHash: 'test',
        displayName: `Agent ${label}`,
        role: 'AGENT',
        extension: label === 'a' ? '8101' : '8201',
      },
    ],
  });
  await owner.skill.create({
    data: { id: skillId, tenantId: fixture.tenantId, name: `บริการ-${label}` },
  });
  await owner.queue.create({
    data: {
      id: fixture.queueId,
      tenantId: fixture.tenantId,
      teamId: fixture.teamId,
      name: `Thai Support ${label}`,
      channels: ['VOICE'],
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingAgentSelfAccess: true,
      recordingChannelLayout: 'STEREO',
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
  });
  await owner.queueSkill.create({
    data: { queueId: fixture.queueId, skillId, minLevel: 2 },
  });
  await owner.agentSkill.create({
    data: { userId: fixture.agentId, skillId, level: 3 },
  });
  await owner.voiceDestination.create({
    data: {
      tenantId: fixture.tenantId,
      destination,
      queueId: fixture.queueId,
    },
  });
  await owner.agentStateLog.create({
    data: { tenantId: fixture.tenantId, userId: fixture.agentId, state: 'AVAILABLE' },
  });
  return fixture;
}

function callEvent(
  fixture: TenantFixture,
  type: 'call.created' | 'call.answered' | 'call.hangup',
  sequence: number,
): KafkaEventEnvelope<TelephonyCallEvent> {
  return {
    eventId: randomUUID(),
    type,
    tenantId: fixture.tenantId,
    occurredAt: `2026-09-05T07:00:${String(sequence * 5).padStart(2, '0')}.000Z`,
    correlationId: fixture.callUuid,
    orderingKey: fixture.callUuid,
    payload: {
      callUuid: fixture.callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-shared-pool-01',
      caller: `caller-${fixture.destination}`,
      destination: fixture.destination,
    },
  };
}

async function cleanup(fixtures: TenantFixture[]) {
  const tenantIds = fixtures.map(({ tenantId }) => tenantId);
  await owner.qmAuditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.qmEvaluation.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.qmTranscriptSegment.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.qmTranscript.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.qmTranscriptionJob.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.recordingAuditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.recording.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.interactionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.interaction.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.agentStateLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.agentSkill.deleteMany({ where: { user: { tenantId: { in: tenantIds } } } });
  await owner.queueSkill.deleteMany({ where: { queue: { tenantId: { in: tenantIds } } } });
  await owner.voiceDestination.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.queueAuditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.queue.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.skill.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.team.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await owner.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

test(
  'two tenants complete voice recording-to-QM and cannot cross event or persistence boundaries',
  { timeout: 30_000 },
  async (t) => {
    const fixtures = [await createTenant('a', '8100'), await createTenant('b', '8200')];
    t.after(async () => {
      await cleanup(fixtures);
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    });

    const interactionEvents: KafkaEventEnvelope[] = [];
    const interactionIdByTenant = new Map<string, string>();
    const router = new InboundVoiceRouter(application, {
      publish: async (topic, event) => {
        if (topic === KAFKA_TOPICS.INTERACTION_EVENTS) interactionEvents.push(event);
      },
      eventId: randomUUID,
      now: () => '2026-09-05T07:00:15.000Z',
    });
    const archived: Array<{ tenantId: string; storageKey: string }> = [];
    const recording = new TelephonyRecordingLifecycle(
      application,
      { handle: async () => undefined },
      {
        prepare: async () => undefined,
        archive: async (input) => void archived.push(input),
      },
    );
    const jobs: Array<{ tenantId: string; job: Parameters<QmTranscriptionWorker['process']>[1] }> =
      [];
    const workflow = new QmTranscriptionWorkflow(owner, {
      publish: async (input) => void jobs.push(input),
    });

    for (const fixture of fixtures) {
      const created = await router.handle(callEvent(fixture, 'call.created', 0));
      assert.equal(created.agentId, fixture.agentId);
      interactionIdByTenant.set(fixture.tenantId, created.interactionId);
      await recording.startForAnsweredCall(callEvent(fixture, 'call.answered', 1));
      assert.equal((await router.handle(callEvent(fixture, 'call.answered', 1))).status, 'ACTIVE');
      await recording.finishForHungupCall(callEvent(fixture, 'call.hangup', 3));
      assert.equal((await router.handle(callEvent(fixture, 'call.hangup', 3))).status, 'WRAPUP');
      const ended = interactionEvents.find(
        (event) =>
          event.tenantId === fixture.tenantId &&
          event.type === 'interaction.ended' &&
          event.orderingKey === created.interactionId,
      );
      assert.ok(ended);
      await workflow.handleInteractionEnded(ended as never);
      await router.completeWrapUp({
        tenantId: fixture.tenantId,
        interactionId: created.interactionId,
        agentId: fixture.agentId,
        code: 'RESOLVED',
      });
    }

    assert.equal(archived.length, 2);
    assert.equal(jobs.length, 2);
    for (const fixture of fixtures) {
      const interactionId = interactionIdByTenant.get(fixture.tenantId);
      assert.ok(interactionId);
      const ownEvents = interactionEvents.filter(({ tenantId }) => tenantId === fixture.tenantId);
      assert.ok(ownEvents.length > 0);
      assert.ok(ownEvents.every(({ orderingKey }) => orderingKey === interactionId));
      assert.equal(
        interactionEvents.filter(
          ({ tenantId, orderingKey }) =>
            tenantId !== fixture.tenantId && orderingKey === interactionId,
        ).length,
        0,
      );
    }

    const worker = new QmTranscriptionWorker(
      owner,
      {
        createEncryptedReadUrl: async ({ tenantId, storageKey }) => ({
          url: `https://storage.test/${storageKey}?tenant=${tenantId}&signature=short-lived`,
          expiresAt: new Date(Date.now() + 300_000),
        }),
      },
      {
        id: 'thai-phase-one-provider',
        transcribe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            modelId: 'thai-phase-one-v1',
            language: 'th-TH',
            confidenceAvg: 0.92,
            segments: [
              {
                speaker: 'AGENT',
                startMs: 500,
                endMs: 2_500,
                text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
                confidence: 0.95,
              },
              {
                speaker: 'CONTACT',
                startMs: 2_700,
                endMs: 5_500,
                text: 'ต้องการสอบถามยอดชำระค่ะ',
                confidence: 0.89,
              },
            ],
          };
        },
      },
      undefined,
      {
        id: 'phase-one-evidence-scorer',
        modelId: 'score-v1',
        promptVersion: 'prompt-1',
        score: async ({ segments }) => ({
          answers: [
            {
              questionId: 'greeting',
              value: 'YES',
              confidence: 0.94,
              evidence: [
                {
                  segmentIds: [segments[0]!.id],
                  startMs: 500,
                  endMs: 2_500,
                  quote: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
                },
              ],
            },
          ],
        }),
      },
    );
    for (const queued of jobs) {
      assert.equal((await worker.process(queued.tenantId, queued.job)).status, 'READY');
    }

    const results = await Promise.all(
      fixtures.map(async (fixture) => {
        const interaction = await owner.interaction.findFirstOrThrow({
          where: { tenantId: fixture.tenantId, externalId: fixture.callUuid },
          select: { id: true, state: true },
        });
        const transcript = await worker.getTranscript(fixture.tenantId, interaction.id);
        const evaluation = await worker.getDraftEvaluation(fixture.tenantId, interaction.id);
        assert.equal(interaction.state, 'COMPLETED');
        assert.equal(transcript?.language, 'th-TH');
        const baseline = transcript?.baseline as {
          audioDurationMs: number;
          processingLatencyMs: number;
          realTimeFactor: number;
          segmentCount: number;
        };
        assert.equal(baseline.audioDurationMs, 10_000);
        assert.ok(baseline.processingLatencyMs >= 20 && baseline.processingLatencyMs < 5_000);
        assert.ok(baseline.realTimeFactor > 0 && baseline.realTimeFactor < 0.5);
        assert.equal(baseline.segmentCount, 2);
        assert.equal(evaluation?.status, 'DRAFT');
        return {
          fixture,
          interactionId: interaction.id,
          transcriptId: transcript!.id,
          evaluationId: evaluation!.id,
          recordingId: jobs.find(({ tenantId }) => tenantId === fixture.tenantId)!.job.recordingId,
          baseline,
        };
      }),
    );

    assert.equal(await worker.getTranscript(fixtures[0].tenantId, results[1].interactionId), null);
    assert.equal(
      await worker.getDraftEvaluation(fixtures[0].tenantId, results[1].interactionId),
      undefined,
    );

    const hidden = await withTenantDatabaseTransaction(
      application,
      fixtures[0].tenantId,
      async (transaction) => ({
        agents: await transaction.user.count({ where: { id: fixtures[1].agentId } }),
        queues: await transaction.queue.count({ where: { id: fixtures[1].queueId } }),
        interactions: await transaction.interaction.count({
          where: { id: results[1].interactionId },
        }),
        recordings: await transaction.recording.count({ where: { id: results[1].recordingId } }),
        transcripts: await transaction.qmTranscript.count({
          where: { id: results[1].transcriptId },
        }),
        evaluations: await transaction.qmEvaluation.count({
          where: { id: results[1].evaluationId },
        }),
      }),
    );
    assert.deepEqual(hidden, {
      agents: 0,
      queues: 0,
      interactions: 0,
      recordings: 0,
      transcripts: 0,
      evaluations: 0,
    });
    console.log(
      `PHASE_ONE_EVIDENCE ${JSON.stringify({
        kind: 'thai-asr-qm-development-baseline',
        corpus: 'คำทักทายและคำถามยอดชำระภาษาไทย',
        samples: results.length,
        successful: results.length,
        audioDurationMs: results.map(({ baseline }) => baseline.audioDurationMs),
        processingLatencyMs: results.map(({ baseline }) => baseline.processingLatencyMs),
        realTimeFactor: results.map(({ baseline }) => baseline.realTimeFactor),
        segmentCount: results.map(({ baseline }) => baseline.segmentCount),
        tenantIsolation: hidden,
        scope: 'local deterministic provider contract; not a production SLA',
      })}`,
    );
  },
);
