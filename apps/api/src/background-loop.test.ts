import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBackgroundError, startBackgroundLoop } from './background-loop.js';

class TransactionTimeout extends Error {
  override name = 'PrismaClientKnownRequestError';
  code = 'P2028';
}

test('a round that throws (e.g. P2028) is logged in a structured way and the loop continues with the next round', async () => {
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
  // the error message may contain a query/PII — it must not leak into the log
  assert.equal(JSON.stringify(events).includes('agent@example.com'), false);
});

test('runOnce does not throw and returns false when the round fails — no unhandled rejection', async () => {
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

test('describeBackgroundError keeps only the name and code', () => {
  assert.deepEqual(describeBackgroundError(new TransactionTimeout('x')), {
    error: 'PrismaClientKnownRequestError',
    code: 'P2028',
  });
  assert.deepEqual(describeBackgroundError('plain string'), { error: 'Unknown', code: null });
  assert.deepEqual(describeBackgroundError(undefined), { error: 'Unknown', code: null });
});
