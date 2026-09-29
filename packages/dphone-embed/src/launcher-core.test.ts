import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LauncherCore, parseDphoneMessage } from './launcher-core.js';
import type { DphoneToHostMessage } from './protocol.js';

const DPHONE = 'https://api.dcontact.test';

function launcher() {
  const posted: { message: any; targetOrigin: string }[] = [];
  const events: [string, unknown][] = [];
  const iframe = {
    postMessage: (message: unknown, targetOrigin: string) =>
      void posted.push({ message, targetOrigin }),
  };
  let failActivity = false;
  let id = 0;
  const core = new LauncherCore({
    dphoneOrigin: DPHONE,
    target: () => iframe,
    requestId: () => `req-${++id}`,
    emit: (type, message) => {
      events.push([type, message]);
      if (type === 'activity')
        return [failActivity ? Promise.reject(new Error('crm down')) : Promise.resolve()];
      return [];
    },
  });
  const from = (data: DphoneToHostMessage | unknown, origin = DPHONE, source: unknown = iframe) =>
    core.handle({ origin, source, data });
  return {
    core,
    posted,
    events,
    from,
    iframe,
    failActivity: (value: boolean) => (failActivity = value),
  };
}

const ready = {
  v: 1,
  type: 'dphone.ready',
  capabilities: { screenPop: true, clickToCall: true, activity: true },
  screenPopLevel: 'ids',
} as const;

test('รับเฉพาะ origin ของ dphone แบบ exact และ source ที่เป็น iframe ของ launcher', () => {
  const l = launcher();
  assert.equal(l.from(ready, 'https://evil.test'), false);
  assert.equal(l.from(ready, DPHONE, {}), false);
  assert.equal(l.from({ ...ready, v: 2 }), false);
  assert.equal(l.from({ v: 1, type: 'dphone.future' }), false);
  assert.deepEqual(l.events, []);
  assert.equal(l.from(ready), true);
  assert.deepEqual(l.events, [['ready', ready]]);
});

test('call() ก่อน ready เข้าคิว แล้วส่งด้วย targetOrigin แบบ exact เมื่อ ready; resolve ด้วยผลที่ไม่ใช่ prefilled', async () => {
  const l = launcher();
  const result = l.core.call('0812345678', { contactId: 'CIF-1' });
  assert.equal(l.posted.length, 0);
  l.from(ready);
  assert.deepEqual(l.posted, [
    {
      message: {
        v: 1,
        type: 'dphone.call',
        requestId: 'req-1',
        number: '0812345678',
        contactId: 'CIF-1',
      },
      targetOrigin: DPHONE,
    },
  ]);
  l.from({
    v: 1,
    type: 'dphone.call.result',
    requestId: 'req-1',
    status: 'prefilled',
    blocked: false,
  });
  const final = {
    v: 1,
    type: 'dphone.call.result',
    requestId: 'req-1',
    status: 'blocked',
    blocked: true,
    reasonCode: 'QUIET_HOURS',
  } as const;
  l.from(final);
  assert.deepEqual(await result, final);
  assert.deepEqual(
    l.events
      .filter(([type]) => type === 'callresult')
      .map(([, m]) => (m as { status: string }).status),
    ['prefilled', 'blocked'],
  );
});

test('dphone.error ของคำขอ → call() reject ด้วย code', async () => {
  const l = launcher();
  l.from(ready);
  const result = l.core.call('0812345678');
  l.from({
    v: 1,
    type: 'dphone.error',
    requestId: 'req-1',
    code: 'invalid_message',
    supportedVersions: [1],
  });
  await assert.rejects(result, /invalid_message/);
});

test('activity: ack อัตโนมัติเมื่อ handler สำเร็จ; handler ล้ม = ไม่ ack (dphone ส่งซ้ำ)', async () => {
  const activity = {
    v: 1,
    type: 'dphone.activity',
    requestId: 'a-1',
    interactionId: 'int-1',
    direction: 'INBOUND',
    startedAt: '2026-09-29T10:00:00.000Z',
    endedAt: '2026-09-29T10:01:00.000Z',
    durationSeconds: 60,
  } as const;
  const ok = launcher();
  ok.from(ready);
  ok.from(activity);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ok.posted.at(-1), {
    message: { v: 1, type: 'dphone.activity.ack', interactionId: 'int-1' },
    targetOrigin: DPHONE,
  });

  const failing = launcher();
  failing.failActivity(true);
  failing.from(ready);
  failing.from(activity);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failing.posted.length, 0);
});

test('parseDphoneMessage: รูปแบบไม่ครบ = null', () => {
  assert.equal(parseDphoneMessage({ v: 1, type: 'dphone.activity' }), null);
  assert.equal(parseDphoneMessage({ v: 1, type: 'dphone.call.result', requestId: 'x' }), null);
  assert.equal(parseDphoneMessage(null), null);
  assert.equal(parseDphoneMessage([]), null);
});
