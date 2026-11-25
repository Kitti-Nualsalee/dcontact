import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityMessage, CallRequestMessage } from '@d-contact/dphone-embed';
import { ACTIVITY_RESEND_MS, ActivityOutbox } from './activity-outbox.js';
import { HostChannel } from './host-channel.js';
import { lockHostOrigin } from './origin-lock.js';

const HOST = 'https://crm.example.test';
const config = { v: 1 as const, tenant: 'demo', allowedHostOrigins: [HOST], auth: null };

function channel() {
  const parent = { name: 'parent' };
  const lock = lockHostOrigin(config, HOST, parent)!;
  const sent: { message: any; targetOrigin: string }[] = [];
  const calls: CallRequestMessage[] = [];
  const acks: string[] = [];
  let now = 0;
  const host = new HostChannel({
    lock,
    host: { postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin }) },
    now: () => now,
    onCall: (request) => calls.push(request),
    onActivityAck: (id) => acks.push(id),
  });
  const from = (data: unknown, origin = HOST, source: unknown = parent) =>
    host.handle({ origin, source, data });
  return { host, lock, sent, calls, acks, from, tick: (ms: number) => (now += ms) };
}

const call = (requestId: string) => ({
  v: 1,
  type: 'dphone.call',
  requestId,
  number: '0812345678',
});

test('outbound uses the exact targetOrigin of the locked host — never *', () => {
  const c = channel();
  c.host.ready({ screenPop: false, clickToCall: true, activity: true }, 'off');
  assert.deepEqual(c.sent, [
    {
      message: {
        v: 1,
        type: 'dphone.ready',
        capabilities: { screenPop: false, clickToCall: true, activity: true },
        screenPopLevel: 'off',
      },
      targetOrigin: HOST,
    },
  ]);
});

test('messages with a wrong origin or source are rejected, no reply, and never reach the handler', () => {
  const c = channel();
  assert.equal(c.from(call('a'), 'https://evil.example.test'), false);
  assert.equal(c.from(call('b'), 'https://crm.example.test:8443'), false);
  assert.equal(c.from(call('c'), HOST, { name: 'other-frame' }), false);
  assert.equal(c.from(call('d'), 'null'), false);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.sent, []);
});

test('dphone.call from the host is only forwarded for dphone to fill in the number — the channel does not dial itself and extra fields are cut', () => {
  const c = channel();
  assert.equal(c.from({ ...call('r1'), autoDial: true, dial: 'now' }), true);
  assert.deepEqual(c.calls, [{ v: 1, type: 'dphone.call', requestId: 'r1', number: '0812345678' }]);
  assert.deepEqual(c.sent, []);
});

test('unsupported v → dphone.error unsupported_version; malformed message → invalid_message; unknown type → silent', () => {
  const c = channel();
  c.from({ v: 2, type: 'dphone.call', requestId: 'r9', number: '0812' });
  c.from({ v: 1, type: 'dphone.call', requestId: 'r10', number: 'abc' });
  c.from({ v: 1, type: 'dphone.unknown' });
  c.from({ type: 'crm.internal' });
  assert.deepEqual(
    c.sent.map((entry) => entry.message),
    [
      {
        v: 1,
        type: 'dphone.error',
        code: 'unsupported_version',
        supportedVersions: [1],
        requestId: 'r9',
      },
      {
        v: 1,
        type: 'dphone.error',
        code: 'invalid_message',
        supportedVersions: [1],
        requestId: 'r10',
      },
    ],
  );
  assert.ok(c.sent.every((entry) => entry.targetOrigin === HOST));
});

test('rate limit of dphone.call: more than 5 times in 10 seconds → rate_limited with no PII', () => {
  const c = channel();
  for (let index = 0; index < 6; index += 1) c.from(call(`r${index}`));
  assert.equal(c.calls.length, 5);
  assert.deepEqual(c.sent.at(-1)!.message, {
    v: 1,
    type: 'dphone.call.result',
    requestId: 'r5',
    status: 'rate_limited',
    blocked: true,
    reasonCode: 'RATE_LIMITED',
  });
  c.tick(10_000);
  c.from(call('r6'));
  assert.equal(c.calls.length, 6);
});

test('origin revoked (embed.origin.revoked) → stop accepting and sending with that host immediately', () => {
  const c = channel();
  c.lock.revoke(HOST);
  assert.equal(c.from(call('r1')), false);
  assert.equal(
    c.host.ready({ screenPop: false, clickToCall: false, activity: false }, 'off'),
    false,
  );
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.calls, []);
});

// ---------- activity outbox ----------

function outbox(store = new Map<string, string>()) {
  const sent: ActivityMessage[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  const box = new ActivityOutbox({
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    storageKey: 'dphone.embed.activity.demo',
    send: (message) => (sent.push(message), true),
    setTimeout: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { box, store, sent, timers };
}

const activity = (interactionId: string, requestId: string): ActivityMessage => ({
  v: 1,
  type: 'dphone.activity',
  requestId,
  interactionId,
  direction: 'INBOUND',
  startedAt: '2026-09-28T10:00:00.000Z',
  endedAt: '2026-09-28T10:03:00.000Z',
  durationSeconds: 180,
  wrapUpCode: 'RESOLVED',
});

test('activity: resend with backoff until ack then stop', () => {
  const o = outbox();
  o.box.enqueue(activity('int-1', 'req-1'));
  assert.equal(o.sent.length, 1);
  assert.equal(o.timers[0]!.ms, ACTIVITY_RESEND_MS[0]);
  o.timers.shift()!.callback();
  assert.equal(o.sent.length, 2);
  assert.equal(o.timers[0]!.ms, ACTIVITY_RESEND_MS[1]);
  assert.equal(o.box.ack('int-1'), true);
  assert.equal(o.timers.length, 0);
  assert.equal(o.store.size, 0);
});

test('activity: the same interactionId is not duplicated — same requestId and a single entry', () => {
  const o = outbox();
  o.box.enqueue(activity('int-1', 'req-1'));
  o.box.enqueue({ ...activity('int-1', 'req-2'), wrapUpCode: 'CALLBACK' });
  assert.equal(o.box.pending.length, 1);
  assert.equal(o.box.pending[0]!.requestId, 'req-1');
  assert.equal(o.box.pending[0]!.wrapUpCode, 'CALLBACK');
  assert.ok(o.sent.every((message) => message.requestId === 'req-1'));
  assert.equal(o.timers.length, 1);
});

test('activity: after reload, resend from sessionStorage with the same requestId/interactionId', () => {
  const first = outbox();
  first.box.enqueue(activity('int-1', 'req-1'));
  first.box.enqueue(activity('int-2', 'req-2'));
  first.box.ack('int-2');

  const reloaded = outbox(first.store);
  reloaded.box.resendAll();
  assert.deepEqual(
    reloaded.sent.map((message) => [message.interactionId, message.requestId]),
    [['int-1', 'req-1']],
  );
});

test('activity: no audio file/transcript/note even if the source or storage is altered to include them', () => {
  const store = new Map<string, string>();
  store.set(
    'dphone.embed.activity.demo',
    JSON.stringify([
      {
        message: {
          ...activity('int-9', 'req-9'),
          recordingUrl: 'https://rec.example.test/a.wav',
          transcript: 'Hello',
          note: 'Free-text note',
        },
        attempts: 3,
      },
    ]),
  );
  const o = outbox(store);
  o.box.resendAll();
  o.box.enqueue({ ...activity('int-10', 'req-10'), ...{ recordingUrl: 'x', transcript: 'y' } });
  for (const message of o.sent) {
    assert.deepEqual(Object.keys(message).sort(), [
      'direction',
      'durationSeconds',
      'endedAt',
      'interactionId',
      'requestId',
      'startedAt',
      'type',
      'v',
      'wrapUpCode',
    ]);
  }
});
