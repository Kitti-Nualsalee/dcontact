import assert from 'node:assert/strict';
import test from 'node:test';
import { LineWebhookWorkerLoop } from './line-webhook-worker-loop.js';

const empty = { processed: 0, projected: 0, touches: 0, pending: 0, quarantined: 0 };

test('#567 worker loop: ทำต่อเมื่อมีงาน, พักเมื่อว่าง, backoff เมื่อล้ม และ stop รอรอบปัจจุบันจบ', async () => {
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
      // หลังรอบ idle แรกให้หยุด — stop ต้องรอรอบนี้จบก่อน resolve
      if (script.length === 0 && sleeps.length >= 3) void loop.stop();
    },
  });
  loop.start();
  loop.start(); // เรียกซ้ำไม่สร้าง loop ที่สอง
  await new Promise((resolve) => setTimeout(resolve, 20));
  await loop.stop();
  assert.deepEqual(events.slice(0, 4), ['processed', 'failed', 'failed', 'processed']);
  // ล้ม 1 = 200, ล้ม 2 = 400 → เพดาน 300, ว่าง = 100
  assert.deepEqual(sleeps.slice(0, 3), [200, 300, 100]);
  assert.ok(calls >= 4);
});
