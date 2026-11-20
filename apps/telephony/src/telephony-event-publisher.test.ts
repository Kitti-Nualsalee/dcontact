import assert from 'node:assert/strict';
import test from 'node:test';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { publishTelephonyCallEvent } from './telephony-event-publisher.js';

const tenantId = '7f6b4b3e-1d0f-4c38-9a8c-9d5b0c6e2a11';
const callUuid = 'ec6112fc-0000-4000-8000-000000000001';

function callEvent(type: string): KafkaEventEnvelope<TelephonyCallEvent> {
  return {
    eventId: `event-${type}`,
    type,
    tenantId,
    occurredAt: '2026-11-20T03:00:00.000Z',
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-uat-solo',
      caller: '1002',
      destination: '2000',
    },
  } as KafkaEventEnvelope<TelephonyCallEvent>;
}

function harness(failures: { start?: Error; finish?: Error }) {
  const published: KafkaEventEnvelope<TelephonyCallEvent>[] = [];
  const logs: { message: string; details: Record<string, unknown> }[] = [];
  return {
    published,
    logs,
    dependencies: {
      recordings: {
        startForAnsweredCall: async () => {
          if (failures.start) throw failures.start;
        },
        finishForHungupCall: async () => {
          if (failures.finish) throw failures.finish;
        },
      },
      publish: async (event: KafkaEventEnvelope<TelephonyCallEvent>) => {
        published.push(event);
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
  const { published, logs, dependencies } = harness({ start: failure });

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);

  assert.deepEqual(
    published.map((event) => event.type),
    ['call.answered'],
  );
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

test('call.hangup is still published when recording archive fails', async () => {
  const { published, logs, dependencies } = harness({ finish: new Error('ENOENT') });

  await publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);

  assert.deepEqual(
    published.map((event) => event.type),
    ['call.hangup'],
  );
  assert.equal(logs[0]?.message, '[telephony] recording archive deferred');
});

test('call events publish without logs when recording succeeds', async () => {
  const { published, logs, dependencies } = harness({});

  await publishTelephonyCallEvent(callEvent('call.answered'), dependencies);
  await publishTelephonyCallEvent(callEvent('call.hangup'), dependencies);

  assert.equal(published.length, 2);
  assert.equal(logs.length, 0);
});

test('Kafka publish failure still propagates to the ESL loop', async () => {
  const { dependencies } = harness({});
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
