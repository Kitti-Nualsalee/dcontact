import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';
import { QmRetryDispatcher } from './qm-retry-dispatcher.js';
import { QmTranscriptionWorker } from './qm-transcription-worker.js';

const owner = new PrismaClient();

test('transcription provider uses encrypted no-training input and stops after bounded retries', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  const jobId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Provider tenant ${tenantId}`,
      slug: `provider-${tenantId}`,
      sipDomain: `${tenantId}.provider.test`,
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: `Provider queue ${tenantId}`,
      channels: ['VOICE'],
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, ended_at)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'WRAPUP',
        ${queueId}::uuid,
        ${new Date('2026-09-05T03:00:00.000Z')}
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
      durationSec: 62,
      startedAt: new Date('2026-09-05T02:58:58.000Z'),
      endedAt: new Date('2026-09-05T03:00:00.000Z'),
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
      dispatchedAt: new Date('2026-09-05T03:00:00.000Z'),
    },
  });
  t.after(async () => {
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await owner.$disconnect();
  });

  const providerInputs: unknown[] = [];
  let clock = new Date('2026-09-05T03:01:00.000Z');
  const worker = new QmTranscriptionWorker(
    owner,
    {
      createEncryptedReadUrl: async () => ({
        url: `https://storage.test/recordings/${tenantId}/${recordingId}.wav?signature=short-lived`,
        expiresAt: new Date(clock.getTime() + 300_000),
      }),
    },
    {
      id: 'contract-failure-provider',
      transcribe: async (input) => {
        providerInputs.push(input);
        throw new Error('provider unavailable');
      },
    },
    { now: () => new Date(clock) },
  );
  const message = (attempt: number): QmTranscriptionJobMessage => ({
    kind: 'TRANSCRIBE',
    jobId,
    interactionId,
    recordingId,
    languageHint: 'th-TH',
    trigger: 'AUTOMATIC',
    attempt,
  });

  const retryMessages: Array<{ tenantId: string; job: QmTranscriptionJobMessage }> = [];
  const retries = new QmRetryDispatcher(owner, {
    publish: async (input) => void retryMessages.push(input),
  });

  assert.equal((await worker.process(tenantId, message(1))).status, 'PENDING');
  assert.deepEqual(await retries.dispatchDue(clock), []);
  clock = new Date('2026-09-05T03:02:00.000Z');
  assert.deepEqual(await retries.dispatchDue(clock), [jobId]);
  assert.equal((await worker.process(tenantId, retryMessages[0]!.job)).status, 'PENDING');
  clock = new Date('2026-09-05T03:04:00.000Z');
  assert.deepEqual(await retries.dispatchDue(clock), [jobId]);
  assert.equal((await worker.process(tenantId, retryMessages[1]!.job)).status, 'FAILED');
  assert.equal(providerInputs.length, 3);
  assert.ok(
    providerInputs.every(
      (input) =>
        (input as { mediaUrl: string }).mediaUrl.startsWith('https://') &&
        (input as { dataUse: string }).dataUse === 'NO_TRAINING',
    ),
  );
  const auditActions = (await worker.getAuditTrail(tenantId, jobId)).map((event) => event.action);
  assert.deepEqual(auditActions, [
    'TRANSCRIPTION_STARTED',
    'TRANSCRIPTION_RETRY_SCHEDULED',
    'TRANSCRIPTION_STARTED',
    'TRANSCRIPTION_RETRY_SCHEDULED',
    'TRANSCRIPTION_STARTED',
    'TRANSCRIPTION_FAILED',
  ]);
  console.log(
    `PHASE_ONE_EVIDENCE ${JSON.stringify({
      kind: 'transcription-failed-retry-audit',
      attempts: providerInputs.length,
      finalStatus: 'FAILED',
      auditActions,
    })}`,
  );
});
