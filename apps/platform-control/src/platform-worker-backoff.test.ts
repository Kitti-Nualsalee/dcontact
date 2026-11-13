import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformRollout } from './platform-rollout.js';
import { computeBackoffMs, createPlatformWorkerLoop } from './platform-worker.js';

class DatabaseGone extends Error {
  override name = 'PrismaClientInitializationError';
  code = 'P1001';
}

test('computeBackoffMs โตแบบ exponential, มีเพดาน และมี jitter อยู่ในครึ่งบน', () => {
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

test('run หน่วงด้วย backoff ที่เพิ่มขึ้นเมื่อ DB หายติดกัน แล้ว reset เมื่อรอบสำเร็จ', async () => {
  // ล้ม 4 รอบ → สำเร็จ (มีงาน) → ว่าง → ล้มอีกรอบ → ว่าง แล้วหยุด
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

  // 4 รอบล้ม: 1s, 2s, 4s, 8s → รอบสำเร็จไม่ sleep (busy) → ว่าง sleep poll 1s
  // → ล้มอีกครั้งเริ่มที่ 1s ใหม่ (reset แล้ว) → ว่าง 1s
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
  // error log ยังคงมีแค่ชื่อ/code — ไม่มี message
  const error = events.find((event) => event.event === 'platform.worker.error');
  assert.deepEqual(error, {
    event: 'platform.worker.error',
    workerId: 'w-backoff',
    source: 'saga',
    error: 'PrismaClientInitializationError',
    code: 'P1001',
  });
});

test('backoff หยุดทันทีเมื่อ signal ถูก abort ระหว่างรอ (sleep จริง)', async () => {
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
