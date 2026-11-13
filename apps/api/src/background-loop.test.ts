import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBackgroundError, startBackgroundLoop } from './background-loop.js';

class TransactionTimeout extends Error {
  override name = 'PrismaClientKnownRequestError';
  code = 'P2028';
}

test('รอบที่ throw (เช่น P2028) ถูก log แบบ structured แล้ว loop ทำรอบถัดไปต่อ', async () => {
  const events: Array<Record<string, unknown>> = [];
  let calls = 0;
  let resolveThird!: () => void;
  const third = new Promise<void>((resolve) => (resolveThird = resolve));
  const loop = startBackgroundLoop({
    name: 'work_session.sweep',
    intervalMs: 5,
    unref: false,
    work: async () => {
      calls += 1;
      if (calls === 3) resolveThird();
      if (calls <= 2) throw new TransactionTimeout('secret query text agent@example.com');
      return 0;
    },
    log: (event) => events.push(event),
  });
  try {
    await third;
  } finally {
    loop.stop();
  }
  assert.ok(calls >= 3);
  assert.deepEqual(events.slice(0, 2), [
    { event: 'work_session.sweep_failed', error: 'PrismaClientKnownRequestError', code: 'P2028' },
    { event: 'work_session.sweep_failed', error: 'PrismaClientKnownRequestError', code: 'P2028' },
  ]);
  // message ของ error อาจมี query/PII — ห้ามหลุดไปใน log
  assert.equal(JSON.stringify(events).includes('agent@example.com'), false);
});

test('runOnce ไม่ throw และคืน false เมื่อรอบล้ม — ไม่มี unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const loop = startBackgroundLoop({
    name: 'test.loop',
    intervalMs: 60_000,
    work: async () => {
      throw new TransactionTimeout('boom');
    },
    log: () => {
      throw new Error('logger down');
    },
  });
  try {
    assert.equal(await loop.runOnce(), false);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    loop.stop();
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('describeBackgroundError เก็บแค่ชื่อและ code', () => {
  assert.deepEqual(describeBackgroundError(new TransactionTimeout('x')), {
    error: 'PrismaClientKnownRequestError',
    code: 'P2028',
  });
  assert.deepEqual(describeBackgroundError('plain string'), { error: 'Unknown', code: null });
  assert.deepEqual(describeBackgroundError(undefined), { error: 'Unknown', code: null });
});
