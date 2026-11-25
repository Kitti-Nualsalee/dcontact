import assert from 'node:assert/strict';
import test from 'node:test';
import { LineWebhookWorkerLoop } from './line-webhook-worker-loop.js';

const empty = { processed: 0, projected: 0, touches: 0, pending: 0, quarantined: 0 };

test('#567 worker loop: continues when there is work, rests when idle, backs off on failure, and stop waits for the current round to finish', async () => {
  const script: Array<'work' | 'fail' | 'idle'> = ['work', 'fail', 'fail', 'idle'];
  const sleeps: number[] = [];
  const events: string[] = [];
  let calls = 0;
  let loop: LineWebhookWorkerLoop;
  const worker = {
    async runOnce() {
      calls += 1;
      const step = script.shift() ?? 'idle';
      if (step === 'fail') throw new Error('db down');
      return { ...empty, processed: step === 'work' ? 3 : 0 };
    },
    async resolvePending() {
      return empty;
    },
  };
  loop = new LineWebhookWorkerLoop({
    worker,
    tenantId: 't',
    idleMs: 100,
    maxBackoffMs: 300,
    onTick: (event) => events.push(event.kind),
    sleep: async (ms) => {
      sleeps.push(ms);
      // after the first idle round stop — stop must wait for this round to finish before it resolves
      if (script.length === 0 && sleeps.length >= 3) void loop.stop();
    },
  });
  loop.start();
  loop.start(); // calling again does not create a second loop
  await new Promise((resolve) => setTimeout(resolve, 20));
  await loop.stop();
  assert.deepEqual(events.slice(0, 4), ['processed', 'failed', 'failed', 'processed']);
  // failure 1 = 200, failure 2 = 400 → ceiling 300, idle = 100
  assert.deepEqual(sleeps.slice(0, 3), [200, 300, 100]);
  assert.ok(calls >= 4);
});
