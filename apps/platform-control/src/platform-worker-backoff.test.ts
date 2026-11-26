import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformRollout } from './platform-rollout.js';
import { computeBackoffMs, createPlatformWorkerLoop } from './platform-worker.js';

class DatabaseGone extends Error {
  override name = 'PrismaClientInitializationError';
  code = 'P1001';
}

test('computeBackoffMs grows exponentially, is capped, and the jitter is in the upper half', () => {
  const max = (failures: number) =>
    computeBackoffMs(failures, { baseMs: 1_000, maxMs: 30_000, random: () => 1 });
  const min = (failures: number) =>
    computeBackoffMs(failures, { baseMs: 1_000, maxMs: 30_000, random: () => 0 });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(max),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.deepEqual([1, 2, 3].map(min), [500, 1_000, 2_000]);
  assert.equal(max(1_000), 30_000);
});

test('run delays with a backoff that grows when the DB stays unavailable, then resets after a successful round', async () => {
  // fails 4 rounds → succeeds (there is work) → idle → fails once more → idle then stops
  const script: Array<'fail' | 'busy' | 'idle'> = [
    'fail',
    'fail',
    'fail',
    'fail',
    'busy',
    'idle',
    'fail',
    'idle',
  ];
  const controller = new AbortController();
  const sleeps: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  let step = 0;
  const loop = createPlatformWorkerLoop({
    workerId: 'w-backoff',
    saga: {
      runOnce: async () => {
        const next = script[step++];
        if (next === undefined) {
          controller.abort();
          return { kind: 'IDLE' } as never;
        }
        if (next === 'fail') throw new DatabaseGone();
        return (next === 'busy' ? { kind: 'COMPLETED' } : { kind: 'IDLE' }) as never;
      },
    },
    commands: { runOnce: async () => ({ kind: 'IDLE' }) as never },
    rollout: PlatformRollout.fixed({ enabled: true, allowlist: [] }),
    random: () => 1,
    maxBackoffMs: 30_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (event) => events.push(event),
  });

  await loop.run(controller.signal, 1_000);

  // 4 failed rounds: 1s, 2s, 4s, 8s → the successful round does not sleep (busy) → idle sleeps a 1s poll
  // → fails again starting at 1s anew (reset) → idle 1s
  assert.deepEqual(sleeps.slice(0, 7), [1_000, 2_000, 4_000, 8_000, 1_000, 1_000, 1_000]);
  const backoffs = events.filter((event) => event.event === 'platform.worker.backoff');
  assert.deepEqual(
    backoffs.map((event) => event.failures),
    [1, 2, 3, 4, 1],
  );
  const recovered = events.filter((event) => event.event === 'platform.worker.recovered');
  assert.deepEqual(
    recovered.map((event) => event.failures),
    [4, 1],
  );
  // the error log still has only name/code — no message
  const error = events.find((event) => event.event === 'platform.worker.error');
  assert.deepEqual(error, {
    event: 'platform.worker.error',
    workerId: 'w-backoff',
    source: 'saga',
    error: 'PrismaClientInitializationError',
    code: 'P1001',
  });
});

test('backoff stops immediately when the signal is aborted while waiting (a real sleep)', async () => {
  const controller = new AbortController();
  const loop = createPlatformWorkerLoop({
    workerId: 'w-abort',
    saga: {
      runOnce: async () => {
        throw new DatabaseGone();
      },
    },
    commands: { runOnce: async () => ({ kind: 'IDLE' }) as never },
    rollout: PlatformRollout.fixed({ enabled: true, allowlist: [] }),
    maxBackoffMs: 60_000,
  });
  const started = Date.now();
  const running = loop.run(controller.signal, 60_000);
  setTimeout(() => controller.abort(), 20);
  await running;
  assert.ok(Date.now() - started < 5_000);
});
