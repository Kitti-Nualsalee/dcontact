import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { QmInteractionEndedPayload, QmTranscriptionJobMessage } from '@d-contact/shared';
import {
  QM_DISPATCH_STALE_MS,
  QM_FREE_INTERRUPTIONS,
  QmRetryDispatcher,
  WORKER_INTERRUPTED,
} from './qm-retry-dispatcher.js';
import {
  QmTranscriptionWorker,
  RECORDING_ARCHIVE_WAIT_LIMIT_MS,
  RECORDING_DELETED,
  RECORDING_NOT_ARCHIVED,
  type QmWorkerResult,
} from './qm-transcription-worker.js';
import { QmTranscriptionWorkflow } from './qm-transcription-workflow.js';

// QmRetryDispatcher scans every tenant: tests that use the dispatcher must share this file so they run in order and do not pick each other's jobs
const owner = new PrismaClient();

after(async () => {
  await owner.$disconnect();
});

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
      archivedAt: new Date('2026-09-05T03:00:01.000Z'),
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

// Telephony can send call.hangup before the WAV archive finishes (#988): the worker must wait for archivedAt without spending an attempt
const requestedAt = new Date('2026-09-05T03:00:00.000Z');

async function seedJob(
  t: test.TestContext,
  recording: { archivedAt?: Date; deletedAt?: Date },
  options: { createJob?: boolean; dispatchedAt?: Date | null } = {},
): Promise<{
  tenantId: string;
  queueId: string;
  interactionId: string;
  jobId: string;
  message: QmTranscriptionJobMessage;
}> {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  const jobId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Archive wait tenant ${tenantId}`,
      slug: `archive-wait-${tenantId}`,
      sipDomain: `${tenantId}.archive-wait.test`,
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: `Archive wait queue ${tenantId}`,
      channels: ['VOICE'],
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 1,
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
        ${requestedAt}
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
      durationSec: 20,
      startedAt: new Date(requestedAt.getTime() - 20_000),
      endedAt: requestedAt,
      ...recording,
    },
  });
  if (options.createJob !== false) {
    await owner.qmTranscriptionJob.create({
      data: {
        id: jobId,
        tenantId,
        interactionId,
        recordingId,
        trigger: 'AUTOMATIC',
        languageHint: 'th-TH',
        // A queue with transcriptionMaxAttempts = 1 must not spend its only attempt on an object that does not exist yet
        maxAttempts: 1,
        createdAt: requestedAt,
        dispatchedAt: options.dispatchedAt === undefined ? requestedAt : options.dispatchedAt,
      },
    });
  }
  t.after(async () => {
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptSegment.deleteMany({ where: { tenantId } });
    await owner.qmTranscript.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });
  return {
    tenantId,
    queueId,
    interactionId,
    jobId,
    message: {
      kind: 'TRANSCRIBE',
      jobId,
      interactionId,
      recordingId,
      languageHint: 'th-TH',
      trigger: 'AUTOMATIC',
      attempt: 1,
    },
  };
}

function harness(clock: { at: Date }) {
  const calls = { media: 0, provider: 0 };
  const worker = new QmTranscriptionWorker(
    owner,
    {
      createEncryptedReadUrl: async ({ storageKey }) => {
        calls.media += 1;
        return {
          url: `https://storage.test/${storageKey}?signature=short-lived`,
          expiresAt: new Date(clock.at.getTime() + 300_000),
        };
      },
    },
    {
      id: 'archive-wait-provider',
      transcribe: async () => {
        calls.provider += 1;
        return {
          modelId: 'archive-wait-model',
          language: 'th-TH',
          confidenceAvg: 0.9,
          segments: [{ speaker: 'AGENT', startMs: 0, endMs: 1_000, text: 'สวัสดีครับ' }], // allow-thai: Thai transcript from the ASR provider
        };
      },
    },
    { now: () => new Date(clock.at) },
  );
  const dispatched: QmTranscriptionJobMessage[] = [];
  const retries = new QmRetryDispatcher(owner, {
    publish: async ({ job }) => void dispatched.push(job),
  });
  return { worker, retries, dispatched, calls };
}

async function persistedJob(jobId: string) {
  return owner.qmTranscriptionJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      status: true,
      attempts: true,
      nextAttemptAt: true,
      dispatchedAt: true,
      failureCode: true,
      completedAt: true,
    },
  });
}

test('a job waits for the recording archive without counting an attempt, then the retry dispatcher picks it up until READY', async (t) => {
  const seeded = await seedJob(t, {});
  const clock = { at: new Date(requestedAt.getTime() + 60_000) };
  const { worker, retries, dispatched, calls } = harness(clock);

  const deferred = await worker.process(seeded.tenantId, seeded.message);
  assert.equal(deferred.status, 'PENDING');
  assert.equal(deferred.attempts, 0);
  // Already waited 60 seconds, so postpone another 60 seconds (minimum 15 seconds, ceiling 5 minutes)
  assert.equal(deferred.nextAttemptAt, new Date(clock.at.getTime() + 60_000).toISOString());
  assert.deepEqual(calls, { media: 0, provider: 0 });
  let job = await persistedJob(seeded.jobId);
  assert.equal(job.status, 'PENDING');
  assert.equal(job.attempts, 0);
  assert.equal(job.dispatchedAt, null);
  assert.equal(job.failureCode, RECORDING_NOT_ARCHIVED);

  // The same message redelivered by Kafka before its time is a no-op: no throw (a throw blocks the partition) and no claim
  assert.deepEqual(await worker.process(seeded.tenantId, seeded.message), deferred);
  assert.deepEqual(calls, { media: 0, provider: 0 });
  assert.deepEqual(await retries.dispatchDue(clock.at), []);

  // Still not archived when due: postpone again, attempt stays 0
  clock.at = new Date(deferred.nextAttemptAt!);
  assert.deepEqual(await retries.dispatchDue(clock.at), [seeded.jobId]);
  assert.equal(dispatched[0]!.attempt, 1);
  const deferredAgain = await worker.process(seeded.tenantId, dispatched[0]!);
  assert.equal(deferredAgain.status, 'PENDING');
  assert.equal(deferredAgain.attempts, 0);
  assert.equal(deferredAgain.nextAttemptAt, new Date(clock.at.getTime() + 120_000).toISOString());

  // Telephony finished the archive: the next round reaches READY on the first attempt
  await owner.recording.updateMany({
    where: { tenantId: seeded.tenantId },
    data: { archivedAt: new Date(clock.at.getTime() + 1_000) },
  });
  clock.at = new Date(deferredAgain.nextAttemptAt!);
  assert.deepEqual(await retries.dispatchDue(clock.at), [seeded.jobId]);
  assert.equal(dispatched[1]!.attempt, 1);
  const ready = await worker.process(seeded.tenantId, dispatched[1]!);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.attempts, 1);
  assert.deepEqual(calls, { media: 1, provider: 1 });
  job = await persistedJob(seeded.jobId);
  assert.equal(job.failureCode, null);

  const audit = await worker.getAuditTrail(seeded.tenantId, seeded.jobId);
  assert.deepEqual(
    audit.map((event) => event.action),
    [
      'TRANSCRIPTION_RETRY_SCHEDULED',
      'TRANSCRIPTION_RETRY_SCHEDULED',
      'TRANSCRIPTION_STARTED',
      'TRANSCRIPTION_READY',
    ],
  );
  assert.equal((audit[0]!.details as { failureCode?: string }).failureCode, RECORDING_NOT_ARCHIVED);
});

test('a job whose recording is not archived within the ceiling becomes FAILED with RECORDING_NOT_ARCHIVED', async (t) => {
  const seeded = await seedJob(t, {});
  const deadline = new Date(requestedAt.getTime() + RECORDING_ARCHIVE_WAIT_LIMIT_MS);
  const clock = { at: new Date(deadline.getTime() - 30_000) };
  const { worker, retries, dispatched, calls } = harness(clock);

  // Near the ceiling: postpone no further than the ceiling, even though the normal wait is 5 minutes
  const deferred = await worker.process(seeded.tenantId, seeded.message);
  assert.equal(deferred.status, 'PENDING');
  assert.equal(deferred.nextAttemptAt, deadline.toISOString());

  clock.at = deadline;
  assert.deepEqual(await retries.dispatchDue(clock.at), [seeded.jobId]);
  const failed = await worker.process(seeded.tenantId, dispatched[0]!);
  assert.deepEqual(failed, { jobId: seeded.jobId, status: 'FAILED', attempts: 0 });
  // A duplicate message after the job closed is a no-op
  assert.deepEqual(await worker.process(seeded.tenantId, dispatched[0]!), failed);
  assert.deepEqual(calls, { media: 0, provider: 0 });
  const job = await persistedJob(seeded.jobId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.failureCode, RECORDING_NOT_ARCHIVED);
  assert.equal(job.dispatchedAt, null);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.completedAt?.toISOString(), deadline.toISOString());
  assert.deepEqual(await retries.dispatchDue(new Date(deadline.getTime() + 600_000)), []);

  const audit = await worker.getAuditTrail(seeded.tenantId, seeded.jobId);
  assert.deepEqual(
    audit.map((event) => event.action),
    ['TRANSCRIPTION_RETRY_SCHEDULED', 'TRANSCRIPTION_FAILED'],
  );
  assert.equal((audit[1]!.details as { failureCode?: string }).failureCode, RECORDING_NOT_ARCHIVED);
});

test('a job whose recording was deleted (e.g. ARCHIVE_ABANDONED) becomes FAILED with RECORDING_DELETED instead of staying PENDING', async (t) => {
  const seeded = await seedJob(t, { deletedAt: new Date(requestedAt.getTime() + 3_000) });
  const clock = { at: new Date(requestedAt.getTime() + 10_000) };
  const { worker, retries, calls } = harness(clock);

  const failed = await worker.process(seeded.tenantId, seeded.message);
  assert.deepEqual(failed, { jobId: seeded.jobId, status: 'FAILED', attempts: 0 });
  assert.deepEqual(calls, { media: 0, provider: 0 });
  const job = await persistedJob(seeded.jobId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.failureCode, RECORDING_DELETED);
  assert.equal(job.dispatchedAt, null);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.completedAt?.toISOString(), clock.at.toISOString());

  // A message Kafka redelivers after the job closed does not change the status
  assert.deepEqual(await worker.process(seeded.tenantId, seeded.message), failed);
  assert.deepEqual(await retries.dispatchDue(new Date(requestedAt.getTime() + 3_600_000)), []);

  const audit = await worker.getAuditTrail(seeded.tenantId, seeded.jobId);
  assert.deepEqual(
    audit.map((event) => event.action),
    ['TRANSCRIPTION_FAILED'],
  );
  assert.equal((audit[0]!.details as { failureCode?: string }).failureCode, RECORDING_DELETED);
});

test('the worker postpones a job before the workflow publish returns and the job does not get stuck: the dispatcher picks it up and a duplicate event does not publish again', async (t) => {
  const seeded = await seedJob(t, {}, { createJob: false });
  // A job created by the workflow uses the database createdAt, so the worker clock is real time
  const clock = { at: new Date() };
  const { worker, retries, dispatched } = harness(clock);
  const published: QmTranscriptionJobMessage[] = [];
  const deferrals: QmWorkerResult[] = [];
  const workflow = new QmTranscriptionWorkflow(owner, {
    publish: async ({ tenantId, job }) => {
      published.push(job);
      // Kafka can deliver to the worker before the workflow publish returns
      deferrals.push(await worker.process(tenantId, job));
    },
  });
  const event: KafkaEventEnvelope<QmInteractionEndedPayload> = {
    eventId: randomUUID(),
    type: 'interaction.ended',
    tenantId: seeded.tenantId,
    occurredAt: requestedAt.toISOString(),
    correlationId: seeded.interactionId,
    orderingKey: seeded.interactionId,
    payload: {
      interactionId: seeded.interactionId,
      channel: 'VOICE',
      state: 'WRAPUP',
      queueId: seeded.queueId,
    },
  };

  const created = await workflow.handleInteractionEnded(event);
  assert.ok(created);
  assert.equal(published.length, 1);
  assert.equal(deferrals[0]!.status, 'PENDING');
  assert.equal(deferrals[0]!.attempts, 0);
  let job = await persistedJob(created.jobId);
  // The workflow must not overwrite dispatchedAt after the worker cleared it, or the dispatcher never picks the job again
  assert.equal(job.dispatchedAt, null);
  assert.ok(job.nextAttemptAt);

  // A duplicate interaction.ended while waiting: a job with nextAttemptAt belongs to the dispatcher, so it is not published again
  await workflow.handleInteractionEnded({ ...event, eventId: randomUUID() });
  assert.equal(published.length, 1);
  job = await persistedJob(created.jobId);
  assert.equal(job.dispatchedAt, null);

  await owner.recording.updateMany({
    where: { tenantId: seeded.tenantId },
    data: { archivedAt: new Date(clock.at.getTime() + 1_000) },
  });
  clock.at = job.nextAttemptAt!;
  assert.deepEqual(await retries.dispatchDue(clock.at), [created.jobId]);
  assert.equal(dispatched[0]!.attempt, 1);
  assert.equal((await worker.process(seeded.tenantId, dispatched[0]!)).status, 'READY');
});

test('the dispatcher does not pick a new job while the workflow/API publishes, and sweeps jobs stuck past the threshold', async (t) => {
  const fresh = await seedJob(t, { archivedAt: requestedAt }, { dispatchedAt: null });
  const { retries, dispatched } = harness({ at: requestedAt });
  const staleAfter = (from: Date, deltaMs: number) =>
    new Date(from.getTime() + QM_DISPATCH_STALE_MS + deltaMs);

  // A new job (attempts = 0, nextAttemptAt = null, dispatchedAt = null) belongs to the workflow/API at first
  assert.deepEqual(await retries.dispatchDue(staleAfter(requestedAt, -1_000)), []);
  // The publish failed and nobody retried: the dispatcher picks it up once it is stuck past the threshold
  const firstSweep = staleAfter(requestedAt, 1_000);
  assert.deepEqual(await retries.dispatchDue(firstSweep), [fresh.jobId]);
  assert.equal(dispatched[0]!.attempt, 1);
  assert.equal(
    (await persistedJob(fresh.jobId)).dispatchedAt?.toISOString(),
    firstSweep.toISOString(),
  );

  // The message was lost after claim (process died between claim and publish): dispatchedAt is stale and gets swept again
  assert.deepEqual(await retries.dispatchDue(staleAfter(firstSweep, -1_000)), []);
  const secondSweep = staleAfter(firstSweep, 1_000);
  assert.deepEqual(await retries.dispatchDue(secondSweep), [fresh.jobId]);
  assert.equal(dispatched[1]!.attempt, 1);
});

test('a job the API reopens after the archive wait ceiling (#990) transcribes right away once archived and is not closed by the ceiling again', async (t) => {
  // The job createdAt keeps its original time; the wait ceiling applies only while archivedAt is null, so a reopened job is not affected
  const seeded = await seedJob(t, { archivedAt: new Date(requestedAt.getTime() + 7_200_000) });
  const clock = { at: new Date(requestedAt.getTime() + 3 * RECORDING_ARCHIVE_WAIT_LIMIT_MS) };
  const { worker, calls } = harness(clock);

  // The job is in the state the API reopen leaves: PENDING, attempts = 0, failure and closed time cleared
  await owner.qmTranscriptionJob.update({
    where: { id: seeded.jobId },
    data: {
      failureCode: null,
      failureReason: null,
      completedAt: null,
      dispatchedAt: new Date(clock.at.getTime() - 1_000),
      nextAttemptAt: null,
    },
  });

  const ready = await worker.process(seeded.tenantId, seeded.message);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.attempts, 1);
  assert.deepEqual(calls, { media: 1, provider: 1 });

  // An old attempt-1 message from before the reopen, redelivered by Kafka, is a duplicate no-op and does not call the provider again
  assert.deepEqual(await worker.process(seeded.tenantId, seeded.message), ready);
  assert.deepEqual(calls, { media: 1, provider: 1 });
});

/** a worker whose provider call stays open until the test settles it: a job that is still PROCESSING */
function hangingWorker(clock: { at: Date }) {
  let settle: (outcome: 'ok' | 'fail') => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const worker = new QmTranscriptionWorker(
    owner,
    {
      createEncryptedReadUrl: async ({ storageKey }) => ({
        url: `https://storage.test/${storageKey}?signature=short-lived`,
        expiresAt: new Date(clock.at.getTime() + 300_000),
      }),
    },
    {
      id: 'hanging-provider',
      transcribe: () =>
        new Promise((resolve, reject) => {
          settle = (outcome) =>
            outcome === 'ok'
              ? resolve({
                  modelId: 'late-model',
                  language: 'th-TH',
                  confidenceAvg: 0.5,
                  segments: [{ speaker: 'AGENT', startMs: 0, endMs: 1_000, text: 'late' }],
                })
              : reject(new Error('late provider failure'));
          markStarted();
        }),
    },
    { now: () => new Date(clock.at) },
  );
  return { worker: () => worker, started, settle: (outcome: 'ok' | 'fail') => settle(outcome) };
}

const PROCESSING_STALE_MS = 10 * 60 * 1_000;

test('a job whose worker died mid-attempt gets the attempt back and is retried; the late result of the old claim is dropped', async (t) => {
  // the queue allows a single attempt: an interruption (deploy mid-job) must not use it up
  const seeded = await seedJob(t, { archivedAt: requestedAt });
  const clock = { at: new Date(requestedAt.getTime() + 60_000) };
  const hanging = hangingWorker(clock);
  const { worker, dispatched } = harness(clock);
  const retries = new QmRetryDispatcher(
    owner,
    { publish: async ({ job }) => void dispatched.push(job) },
    { processingStaleMs: PROCESSING_STALE_MS },
  );

  // attempt 1 is claimed and its worker never returns (the process was killed during a deploy)
  const lost = hanging.worker().process(seeded.tenantId, seeded.message);
  await hanging.started;
  assert.equal((await persistedJob(seeded.jobId)).status, 'PROCESSING');
  // Kafka redelivering attempt 1 is a no-op: the claim already counted it
  assert.equal((await worker.process(seeded.tenantId, seeded.message)).status, 'PROCESSING');

  // not stale yet: nothing happens
  clock.at = new Date(clock.at.getTime() + PROCESSING_STALE_MS - 1_000);
  assert.deepEqual(await retries.dispatchDue(clock.at), []);
  assert.equal((await persistedJob(seeded.jobId)).status, 'PROCESSING');

  // past the threshold: the attempt is given back and attempt 1 is published again in the same pass
  clock.at = new Date(clock.at.getTime() + 2_000);
  assert.deepEqual(await retries.dispatchDue(clock.at), [seeded.jobId]);
  assert.equal(dispatched.at(-1)!.attempt, 1);
  const recovered = await persistedJob(seeded.jobId);
  assert.equal(recovered.status, 'PENDING');
  assert.equal(recovered.attempts, 0);
  assert.equal(recovered.failureCode, WORKER_INTERRUPTED);

  clock.at = new Date(clock.at.getTime() + 1_000);
  const ready = await worker.process(seeded.tenantId, dispatched.at(-1)!);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.attempts, 1);

  // the old claim finally returns with the same attempt number: its result must not replace the new one
  hanging.settle('ok');
  assert.deepEqual(await lost, { jobId: seeded.jobId, status: 'READY', attempts: 1 });
  const transcripts = await owner.qmTranscript.findMany({ where: { tenantId: seeded.tenantId } });
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0]!.modelId, 'archive-wait-model');
  const actions = (
    await owner.qmAuditEvent.findMany({
      where: { tenantId: seeded.tenantId },
      orderBy: { createdAt: 'asc' },
    })
  ).map((event) => {
    const details = event.details as { failureCode?: string; countedAsAttempt?: boolean };
    return [event.action, details.failureCode, details.countedAsAttempt];
  });
  assert.deepEqual(actions, [
    ['TRANSCRIPTION_STARTED', undefined, undefined],
    ['TRANSCRIPTION_RETRY_SCHEDULED', WORKER_INTERRUPTED, false],
    ['TRANSCRIPTION_STARTED', undefined, undefined],
    ['TRANSCRIPTION_READY', undefined, undefined],
  ]);
});

test('interruptions are free up to the allowance, then they count, so a recording that kills the worker every time still ends as FAILED', async (t) => {
  const seeded = await seedJob(t, { archivedAt: requestedAt });
  const clock = { at: new Date(requestedAt.getTime() + 60_000) };
  const dispatched: QmTranscriptionJobMessage[] = [];
  const retries = new QmRetryDispatcher(
    owner,
    { publish: async ({ job }) => void dispatched.push(job) },
    { processingStaleMs: PROCESSING_STALE_MS },
  );

  let message = seeded.message;
  const lost: Array<{ settle: (outcome: 'ok' | 'fail') => void; result: Promise<QmWorkerResult> }> =
    [];
  for (let interruption = 1; interruption <= QM_FREE_INTERRUPTIONS + 1; interruption++) {
    const hanging = hangingWorker(clock);
    const result = hanging.worker().process(seeded.tenantId, message);
    await hanging.started;
    lost.push({ settle: hanging.settle, result });
    clock.at = new Date(clock.at.getTime() + PROCESSING_STALE_MS + 1_000);
    const published = await retries.dispatchDue(clock.at);
    const job = await persistedJob(seeded.jobId);
    assert.equal(job.failureCode, WORKER_INTERRUPTED, `interruption ${interruption}`);
    if (interruption <= QM_FREE_INTERRUPTIONS) {
      // free: the single attempt is given back and the job is retried right away
      assert.equal(job.status, 'PENDING', `interruption ${interruption}`);
      assert.equal(job.attempts, 0);
      assert.deepEqual(published, [seeded.jobId]);
      message = dispatched.at(-1)!;
      assert.equal(message.attempt, 1);
    } else {
      // past the allowance the interruption counts: the only attempt is used and the job closes
      assert.equal(job.status, 'FAILED');
      assert.equal(job.attempts, 1);
      assert.equal(job.completedAt?.toISOString(), clock.at.toISOString());
      assert.deepEqual(published, []);
    }
  }

  // late results of the interrupted claims change nothing and add no audit
  const before = await owner.qmAuditEvent.count({ where: { tenantId: seeded.tenantId } });
  lost[0]!.settle('ok');
  lost[1]!.settle('fail');
  lost.at(-1)!.settle('fail');
  await Promise.all(
    lost
      .slice(0, 2)
      .concat(lost.slice(-1))
      .map((entry) => entry.result),
  );
  const job = await persistedJob(seeded.jobId);
  assert.equal(job.status, 'FAILED');
  assert.equal(job.failureCode, WORKER_INTERRUPTED);
  assert.equal(await owner.qmAuditEvent.count({ where: { tenantId: seeded.tenantId } }), before);
  assert.equal(await owner.qmTranscript.count({ where: { tenantId: seeded.tenantId } }), 0);
  // the sweep does not touch a closed job again
  assert.deepEqual(await retries.dispatchDue(new Date(clock.at.getTime() + 60_000)), []);
  lost[2]!.settle('ok');
  await lost[2]!.result;
  assert.equal(await owner.qmTranscript.count({ where: { tenantId: seeded.tenantId } }), 0);
});
