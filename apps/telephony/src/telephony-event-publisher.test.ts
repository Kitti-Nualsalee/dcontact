import assert from 'node:assert/strict';
import test from 'node:test';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { publishTelephonyCallEvent, RecordingTaskQueue } from './telephony-event-publisher.js';

const tenantId = '7f6b4b3e-1d0f-4c38-9a8c-9d5b0c6e2a11';
const callUuid = 'ec6112fc-0000-4000-8000-000000000001';

function callEvent(type: string, uuid = callUuid): KafkaEventEnvelope<TelephonyCallEvent> {
  return {
    eventId: `event-${type}-${uuid}`,
    type,
    tenantId,
    occurredAt: '2026-11-20T03:00:00.000Z',
    correlationId: uuid,
    orderingKey: uuid,
    payload: {
      callUuid: uuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-uat-solo',
      caller: '1002',
      destination: '2000',
    },
  } as KafkaEventEnvelope<TelephonyCallEvent>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(
  recordings: {
    start?: () => Promise<void>;
    finish?: () => Promise<void>;
  } = {},
) {
  const published: string[] = [];
  const steps: string[] = [];
  const logs: { message: string; details: Record<string, unknown> }[] = [];
  const recordingTasks = new RecordingTaskQueue();
  return {
    published,
    steps,
    logs,
    recordingTasks,
    dependencies: {
      recordings: {
        startForAnsweredCall: async () => {
          await recordings.start?.();
          steps.push('recording.started');
        },
        finishForHungupCall: async () => {
          await recordings.finish?.();
          steps.push('recording.finished');
        },
      },
      recordingTasks,
      hangupRecordingBudgetMs: 50,
      publish: async (event: KafkaEventEnvelope<TelephonyCallEvent>) => {
        published.push(event.type);
        steps.push(`published:${event.type}`);
      },
      log: (message: string, details: Record<string, unknown>) => logs.push({ message, details }),
    },
  };
}

test('call.answered is still published when recording cannot start (#923)', async () => {
  const failure = Object.assign(
    new Error("EACCES: permission denied, mkdir '/infra/docker/data/freeswitch-recordings'"),
    { code: 'EACCES' },
  );
  const { published, logs, recordingTasks, dependencies } = harness({
    start: async () => {
      throw failure;
    },
  });

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);
  await recordingTasks.drain(1_000);

  assert.deepEqual(published, ['call.answered']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.message, '[telephony] recording start failed');
  assert.deepEqual(logs[0]?.details, {
    eventType: 'call.answered',
    callUuid,
    tenantId,
    errorName: 'Error',
    errorCode: 'EACCES',
    reason: failure.message,
  });
});

test('call.answered reaches Router without waiting for slow recording storage (NFS ไม่ตอบ)', async () => {
  const storage = deferred();
  const { published, steps, recordingTasks, dependencies } = harness({
    start: () => storage.promise,
  });

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);

  // publish เสร็จแล้วทั้งที่ prepare ยังค้าง: Router ไม่เกิน offer timeout
  assert.deepEqual(published, ['call.answered']);
  assert.equal(recordingTasks.size, 1);
  storage.resolve();
  assert.equal(await recordingTasks.drain(1_000), true);
  assert.deepEqual(steps, ['published:call.answered', 'recording.started']);
});

test('call.hangup waits for recording to finish so QM sees endedAt, as before', async () => {
  const { steps, logs, dependencies } = harness();

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);
  await publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);

  assert.deepEqual(steps, [
    'published:call.answered',
    'recording.started',
    'recording.finished',
    'published:call.hangup',
  ]);
  assert.equal(logs.length, 0);
});

test('call.hangup is published after the budget when archive storage hangs', async () => {
  const storage = deferred();
  const { published, steps, logs, recordingTasks, dependencies } = harness({
    finish: () => storage.promise,
  });

  await publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);

  assert.deepEqual(published, ['call.hangup']);
  assert.equal(logs[0]?.message, '[telephony] call.hangup published before recording finished');
  assert.deepEqual(logs[0]?.details, {
    eventType: 'call.hangup',
    callUuid,
    tenantId,
    budgetMs: 50,
  });
  storage.resolve();
  await recordingTasks.drain(1_000);
  assert.deepEqual(steps, ['published:call.hangup', 'recording.finished']);
});

test('hangup recording work runs after the answered recording work of the same call', async () => {
  const prepare = deferred();
  const { steps, recordingTasks, dependencies } = harness({ start: () => prepare.promise });

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);
  const hangup = publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);
  // สายอื่นไม่ต้องรอสายนี้
  await publishTelephonyCallEvent(
    callEvent('call.answered', 'ec6112fc-0000-4000-8000-000000000002'),
    dependencies,
  );
  prepare.resolve();
  await hangup;
  await recordingTasks.drain(1_000);

  const ownCall = steps.filter((step) => step !== 'published:call.answered');
  assert.equal(ownCall.indexOf('recording.started') < ownCall.indexOf('recording.finished'), true);
  assert.equal(steps.indexOf('recording.finished') < steps.indexOf('published:call.hangup'), true);
});

test('call.hangup is still published when recording archive fails', async () => {
  const { published, logs, dependencies } = harness({
    finish: async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    },
  });

  await publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);

  assert.deepEqual(published, ['call.hangup']);
  assert.equal(logs[0]?.message, '[telephony] recording archive deferred');
  assert.equal(logs[0]?.details.errorCode, 'ENOENT');
});

test('events other than answered/hangup do not touch recordings', async () => {
  const { published, steps, recordingTasks, dependencies } = harness();

  await publishTelephonyCallEvent(callEvent('call.created'), dependencies);

  assert.deepEqual(published, ['call.created']);
  assert.equal(recordingTasks.size, 0);
  assert.deepEqual(steps, ['published:call.created']);
});

test('Kafka publish failure still propagates to the ESL loop', async () => {
  const { dependencies } = harness();
  await assert.rejects(
    () =>
      publishTelephonyCallEvent(callEvent('call.answered'), {
        ...dependencies,
        publish: async () => {
          throw new Error('broker unavailable');
        },
      }),
    /broker unavailable/,
  );
});

test('drain reports work still running after its timeout', async () => {
  const queue = new RecordingTaskQueue();
  const stuck = deferred();
  void queue.run(
    'call',
    () => stuck.promise,
    () => undefined,
  );

  assert.equal(await queue.drain(10), false);
  stuck.resolve();
  assert.equal(await queue.drain(1_000), true);
  assert.equal(queue.size, 0);
});
