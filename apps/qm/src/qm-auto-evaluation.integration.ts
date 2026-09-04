import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';
import { QmTranscriptionWorker } from './qm-transcription-worker.js';

const owner = new PrismaClient();

test('ready Thai transcript creates only an evidence-backed auto-QM draft', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const agentId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  const jobId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Auto QM tenant ${tenantId}`,
      slug: `auto-qm-${tenantId}`,
      sipDomain: `${tenantId}.auto-qm.test`,
    },
  });
  await owner.user.create({
    data: {
      id: agentId,
      tenantId,
      email: `agent-${tenantId}@test.local`,
      passwordHash: 'test',
      displayName: 'Agent',
      role: 'AGENT',
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: `Auto QM queue ${tenantId}`,
      channels: ['VOICE'],
      autoQmEnabled: true,
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, ended_at)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'WRAPUP',
        ${queueId}::uuid,
        ${agentId}::uuid,
        ${new Date('2026-09-05T04:00:00.000Z')}
      )`,
  );
  await owner.recording.create({
    data: {
      id: recordingId,
      tenantId,
      interactionId,
      storageKey: `recordings/${tenantId}/${recordingId}.wav`,
      telephonyPath: `/var/recordings/${tenantId}/${recordingId}.wav`,
      channelLayout: 'STEREO',
      durationSec: 12,
      startedAt: new Date('2026-09-05T03:59:48.000Z'),
      endedAt: new Date('2026-09-05T04:00:00.000Z'),
    },
  });
  await owner.qmTranscriptionJob.create({
    data: {
      id: jobId,
      tenantId,
      interactionId,
      recordingId,
      trigger: 'AUTOMATIC',
      languageHint: 'th-TH',
      maxAttempts: 3,
      dispatchedAt: new Date('2026-09-05T04:00:00.000Z'),
    },
  });
  t.after(async () => {
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmEvaluation.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptSegment.deleteMany({ where: { tenantId } });
    await owner.qmTranscript.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await owner.$disconnect();
  });

  let now = new Date('2026-09-05T04:01:00.000Z');
  let transcriptionCalls = 0;
  let scoringCalls = 0;
  const worker = new QmTranscriptionWorker(
    owner,
    {
      createEncryptedReadUrl: async () => ({
        url: `https://storage.test/recordings/${tenantId}/${recordingId}.wav?signed=1`,
        expiresAt: new Date(now.getTime() + 300_000),
      }),
    },
    {
      id: 'thai-contract-provider',
      transcribe: async () => {
        transcriptionCalls += 1;
        now = new Date(now.getTime() + 800);
        return {
          modelId: 'thai-test-v1',
          language: 'th-TH',
          confidenceAvg: 0.91,
          segments: [
            {
              speaker: 'AGENT',
              startMs: 1_200,
              endMs: 4_800,
              text: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
              confidence: 0.95,
            },
            {
              speaker: 'CONTACT',
              startMs: 5_000,
              endMs: 8_000,
              text: 'ต้องการสอบถามยอดชำระค่ะ',
              confidence: 0.87,
            },
          ],
        };
      },
    },
    { now: () => new Date(now) },
    {
      id: 'evidence-scorer',
      modelId: 'score-test-v1',
      promptVersion: 'prompt-1',
      score: async ({ segments }) => {
        scoringCalls += 1;
        return {
          answers: [
            {
              questionId: 'greeting',
              value: 'YES',
              confidence: 0.94,
              evidence: [
                {
                  segmentIds: [segments[0]!.id],
                  startMs: 1_200,
                  endMs: 4_800,
                  quote: 'สวัสดีค่ะ ยินดีให้บริการค่ะ',
                },
              ],
            },
            {
              questionId: 'identity-verification',
              value: 'YES',
              confidence: 0.31,
              evidence: [],
            },
          ],
        };
      },
    },
  );
  const message: QmTranscriptionJobMessage = {
    kind: 'TRANSCRIBE',
    jobId,
    interactionId,
    recordingId,
    languageHint: 'th-TH',
    trigger: 'AUTOMATIC',
    attempt: 1,
  };

  assert.equal((await worker.process(tenantId, message)).status, 'READY');
  assert.equal((await worker.process(tenantId, message)).status, 'READY');
  assert.equal(transcriptionCalls, 1);
  assert.equal(scoringCalls, 1);
  const transcript = await worker.getTranscript(tenantId, interactionId);
  assert.equal(transcript?.language, 'th-TH');
  assert.equal(transcript?.segments.length, 2);
  assert.deepEqual(transcript?.baseline, {
    audioDurationMs: 12_000,
    processingLatencyMs: 800,
    realTimeFactor: 0.067,
    segmentCount: 2,
  });

  const evaluation = await worker.getDraftEvaluation(tenantId, interactionId);
  assert.equal(evaluation?.status, 'DRAFT');
  assert.equal(evaluation?.evaluatorId, null);
  assert.equal(evaluation?.providerId, 'evidence-scorer');
  assert.deepEqual(evaluation?.answers[1], {
    questionId: 'identity-verification',
    value: 'INSUFFICIENT_EVIDENCE',
    confidence: 0.31,
    evidence: [],
  });
});
