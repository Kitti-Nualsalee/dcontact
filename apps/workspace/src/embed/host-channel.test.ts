import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityMessage, CallRequestMessage } from '@d-contact/dphone-embed';
import { ACTIVITY_RESEND_MS, ActivityOutbox } from './activity-outbox.js';
import { HostChannel } from './host-channel.js';
import { lockHostOrigin } from './origin-lock.js';

const HOST = 'https://crm.example.test';
const config = { v: 1 as const, tenant: 'demo', allowedHostOrigins: [HOST] };

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

test('ขาออกใช้ targetOrigin แบบ exact ของ host ที่ล็อก — ไม่มี *', () => {
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

test('ข้อความที่ origin หรือ source ผิดถูกปฏิเสธ ไม่ตอบและไม่ถึง handler', () => {
  const c = channel();
  assert.equal(c.from(call('a'), 'https://evil.example.test'), false);
  assert.equal(c.from(call('b'), 'https://crm.example.test:8443'), false);
  assert.equal(c.from(call('c'), HOST, { name: 'other-frame' }), false);
  assert.equal(c.from(call('d'), 'null'), false);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.sent, []);
});

test('dphone.call จาก host แค่ส่งต่อให้ dphone กรอกเบอร์ — channel ไม่โทรออกเอง และ field เกินถูกตัด', () => {
  const c = channel();
  assert.equal(c.from({ ...call('r1'), autoDial: true, dial: 'now' }), true);
  assert.deepEqual(c.calls, [{ v: 1, type: 'dphone.call', requestId: 'r1', number: '0812345678' }]);
  assert.deepEqual(c.sent, []);
});

test('v ไม่รองรับ → dphone.error unsupported_version; ข้อความผิดรูป → invalid_message; type ไม่รู้จัก → เงียบ', () => {
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

test('rate limit ของ dphone.call: เกิน 5 ครั้งใน 10 วินาที → rate_limited แบบไม่มี PII', () => {
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

test('origin ถูกเพิกถอน (embed.origin.revoked) → หยุดรับและหยุดส่งกับ host นั้นทันที', () => {
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

test('activity: ส่งซ้ำตาม backoff จน ack แล้วหยุด', () => {
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

test('activity: interactionId เดิมไม่ซ้ำซ้อน — requestId เดิมและมีรายการเดียว', () => {
  const o = outbox();
  o.box.enqueue(activity('int-1', 'req-1'));
  o.box.enqueue({ ...activity('int-1', 'req-2'), wrapUpCode: 'CALLBACK' });
  assert.equal(o.box.pending.length, 1);
  assert.equal(o.box.pending[0]!.requestId, 'req-1');
  assert.equal(o.box.pending[0]!.wrapUpCode, 'CALLBACK');
  assert.ok(o.sent.every((message) => message.requestId === 'req-1'));
  assert.equal(o.timers.length, 1);
});

test('activity: reload แล้วส่งซ้ำจาก sessionStorage ด้วย requestId/interactionId เดิม', () => {
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

test('activity: ไม่มีไฟล์เสียง/transcript/โน้ต แม้ source หรือ storage ถูกแก้ให้มี', () => {
  const store = new Map<string, string>();
  store.set(
    'dphone.embed.activity.demo',
    JSON.stringify([
      {
        message: {
          ...activity('int-9', 'req-9'),
          recordingUrl: 'https://rec.example.test/a.wav',
          transcript: 'สวัสดี',
          note: 'โน้ตอิสระ',
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
