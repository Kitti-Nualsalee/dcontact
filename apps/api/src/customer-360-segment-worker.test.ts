import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@d-contact/db';
import { startC360SegmentWorker } from './customer-360-segment-worker.js';

const database = {
  tenant: { findMany: async () => [{ id: 't1' }] },
} as unknown as PrismaClient;
const quiet = () => undefined;
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};

test('turned off with C360_SEGMENT_WORKER=off without opening the DB/Kafka', () => {
  const logs: Record<string, unknown>[] = [];
  const worker = startC360SegmentWorker({
    database,
    env: { C360_SEGMENT_WORKER: 'off' },
    log: (entry) => logs.push(entry),
    connectKafka: async () => assert.fail('must not connect to Kafka'),
  });
  assert.equal(worker, undefined);
  assert.deepEqual(logs, [{ event: 'c360.segment_worker.disabled' }]);
});

test('the evaluator works before Kafka is ready, and when Kafka fails it retries until it connects', async () => {
  let attempts = 0;
  const evaluated: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const worker = startC360SegmentWorker({
    database,
    env: {},
    log: (entry) => logs.push(entry),
    evaluateIntervalMs: 60_000,
    publishIntervalMs: 60_000,
    reconnectDelayMs: () => 1,
    runtime: {
      evaluatePending: async (tenantId) => {
        evaluated.push(tenantId);
        return { contacts: 0, snapshots: 0, commits: {}, skipped: 0 };
      },
    },
    connectKafka: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('broker down secret-host:9092');
      return {
        producer: { send: async () => {}, disconnect: async () => {} },
        close: async () => {},
      };
    },
  })!;
  try {
    assert.equal(await worker.evaluateOnce(), true);
    assert.deepEqual(evaluated, ['t1']);
    await waitFor(() => worker.kafkaConnected);
    assert.equal(attempts, 3);
    const failures = logs.filter(
      (entry) => entry.event === 'c360.segment_worker.kafka_connect_failed',
    );
    assert.equal(failures.length, 2);
    assert.ok(!JSON.stringify(logs).includes('secret-host'), 'the log has no connection details');
  } finally {
    await worker.stop();
  }
});

test('an evaluate round that fails does not stop the worker, and stop closes Kafka', async () => {
  let closed = false;
  let fail = true;
  const worker = startC360SegmentWorker({
    database,
    env: {},
    log: quiet,
    evaluateIntervalMs: 60_000,
    publishIntervalMs: 60_000,
    runtime: {
      evaluatePending: async () => {
        if (fail) throw new Error('db down');
        return { contacts: 0, snapshots: 0, commits: {}, skipped: 0 };
      },
    },
    connectKafka: async () => ({
      producer: { send: async () => {}, disconnect: async () => {} },
      close: async () => {
        closed = true;
      },
    }),
  })!;
  assert.equal(await worker.evaluateOnce(), false);
  fail = false;
  assert.equal(await worker.evaluateOnce(), true);
  await waitFor(() => worker.kafkaConnected);
  await worker.stop();
  assert.equal(closed, true);
});
