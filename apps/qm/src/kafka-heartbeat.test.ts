import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QM_HEARTBEAT_INTERVAL_MS,
  jobRebalanceTimeoutMs,
  whileHeartbeating,
  type HeartbeatTimer,
} from './kafka-heartbeat.js';

function manualTimer() {
  const active = new Map<number, () => void>();
  let next = 0;
  const intervals: number[] = [];
  const timer: HeartbeatTimer = {
    setInterval: (callback, ms) => {
      intervals.push(ms);
      active.set(++next, callback);
      return next;
    },
    clearInterval: (handle) => void active.delete(handle as number),
  };
  return {
    timer,
    intervals,
    tick: () => [...active.values()].forEach((callback) => callback()),
    activeCount: () => active.size,
  };
}

test('heartbeats on an interval while the job runs and stops when it settles', async () => {
  const clock = manualTimer();
  let beats = 0;
  let finish!: (value: string) => void;
  const running = whileHeartbeating(
    async () => void beats++,
    () => new Promise<string>((resolve) => (finish = resolve)),
    { timer: clock.timer },
  );
  assert.deepEqual(clock.intervals, [QM_HEARTBEAT_INTERVAL_MS]);
  // well inside the 30 s session timeout
  assert.ok(QM_HEARTBEAT_INTERVAL_MS * 3 <= 30_000);
  clock.tick();
  clock.tick();
  assert.equal(beats, 2);
  finish('done');
  assert.equal(await running, 'done');
  assert.equal(clock.activeCount(), 0);
});

test('a failed job still stops the heartbeat and keeps its error', async () => {
  const clock = manualTimer();
  await assert.rejects(
    whileHeartbeating(
      async () => undefined,
      async () => {
        throw new Error('provider timed out');
      },
      { timer: clock.timer },
    ),
    /provider timed out/,
  );
  assert.equal(clock.activeCount(), 0);
});

test('a failing heartbeat (rebalance in progress) does not abort the job and is reported once', async () => {
  const clock = manualTimer();
  const reported: unknown[] = [];
  let finish!: () => void;
  const running = whileHeartbeating(
    async () => {
      throw new Error('REBALANCE_IN_PROGRESS');
    },
    () => new Promise<void>((resolve) => (finish = resolve)),
    { timer: clock.timer, onError: (error) => reported.push(error) },
  );
  clock.tick();
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await running;
  assert.equal(reported.length, 1);
});

test('without a heartbeat function the job just runs', async () => {
  const clock = manualTimer();
  assert.equal(await whileHeartbeating(undefined, async () => 7, { timer: clock.timer }), 7);
  assert.deepEqual(clock.intervals, []);
});

test('the rebalance timeout outlasts every provider call of a job', () => {
  assert.equal(jobRebalanceTimeoutMs([300_000]), 360_000);
  assert.equal(jobRebalanceTimeoutMs([300_000, 120_000]), 480_000);
});

test('a job stuck past its maximum stops heartbeating so the coordinator can evict the member', async () => {
  const clock = manualTimer();
  let nowMs = 0;
  let beats = 0;
  let finish!: () => void;
  const running = whileHeartbeating(
    async () => void beats++,
    () => new Promise<void>((resolve) => (finish = resolve)),
    { timer: clock.timer, now: () => nowMs, maxMs: 10_000 },
  );
  nowMs = 5_000;
  clock.tick();
  assert.equal(beats, 1);
  nowMs = 10_001;
  clock.tick();
  assert.equal(beats, 1);
  assert.equal(clock.activeCount(), 0);
  finish();
  await running;
});
