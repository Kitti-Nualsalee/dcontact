import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDphoneHost,
  createDphoneRemote,
  type ChannelLike,
  type DphoneView,
} from './dphone-bridge.js';

/** BroadcastChannel ในหน่วยความจำ — ส่งถึงทุกตัวยกเว้นผู้ส่ง เหมือนของจริง */
function channelPair(): () => ChannelLike {
  const members = new Set<{ listeners: Set<(event: MessageEvent) => void> }>();
  return () => {
    const self = { listeners: new Set<(event: MessageEvent) => void>() };
    members.add(self);
    return {
      postMessage(message) {
        for (const member of members) {
          if (member === self) continue;
          for (const listener of member.listeners) {
            listener({ data: structuredClone(message) } as MessageEvent);
          }
        }
      },
      addEventListener: (_type, listener) => self.listeners.add(listener),
      removeEventListener: (_type, listener) => self.listeners.delete(listener),
      close: () => members.delete(self),
    };
  };
}

const view: DphoneView = {
  phase: 'ACTIVE',
  caller: '081-000-0000',
  queueName: 'บริการ',
  muted: false,
  locale: 'th',
};

test('หน้าต่างแยกของตัวเองได้ view ล่าสุดทันทีที่เปิด และคำสั่งกลับไปถึง working tab', () => {
  const open = channelPair();
  const commands: unknown[] = [];
  const presence: boolean[] = [];
  const host = createDphoneHost({
    onCommand: (command) => commands.push(command),
    onRemotePresence: (present) => presence.push(present),
    expectedRemote: () => 'popup-1',
    channel: open(),
  });
  host.publish(view);

  const views: DphoneView[] = [];
  const remote = createDphoneRemote({
    remote: 'popup-1',
    onView: (next) => views.push(next),
    onClosed: () => undefined,
    channel: open(),
  });
  assert.deepEqual(views, [view]);
  assert.deepEqual(presence, [true]);

  remote.send({ type: 'toggleHold' });
  remote.send({ type: 'dtmf', value: '5' });
  assert.deepEqual(commands, [{ type: 'toggleHold' }, { type: 'dtmf', value: '5' }]);

  remote.close();
  assert.deepEqual(presence, [true, false]);
  host.close();
});

test('ทิ้งข้อความที่ไม่ใช่ v1, ไม่มี remote id, คำสั่งที่ไม่รู้จัก หรือ DTMF ผิดรูป', () => {
  const open = channelPair();
  const commands: unknown[] = [];
  const host = createDphoneHost({
    onCommand: (command) => commands.push(command),
    onRemotePresence: () => undefined,
    expectedRemote: () => 'popup-1',
    channel: open(),
  });
  const attacker = open();
  attacker.postMessage({ v: 2, kind: 'command', remote: 'popup-1', command: { type: 'hangup' } });
  attacker.postMessage({ v: 1, kind: 'command', remote: 'popup-1', command: { type: 'transfer' } });
  attacker.postMessage({
    v: 1,
    kind: 'command',
    remote: 'popup-1',
    command: { type: 'dtmf', value: '12; drop' },
  });
  attacker.postMessage({ v: 1, kind: 'command', command: { type: 'hangup' } });
  attacker.postMessage('hangup');
  assert.deepEqual(commands, []);
  host.close();
});

test('working tab ดึง dphone กลับ → ปิดเฉพาะหน้าต่างแยกของตัวเอง', () => {
  const open = channelPair();
  const host = createDphoneHost({
    onCommand: () => undefined,
    onRemotePresence: () => undefined,
    expectedRemote: () => 'popup-1',
    channel: open(),
  });
  let closed = false;
  let otherClosed = false;
  createDphoneRemote({
    remote: 'popup-1',
    onView: () => undefined,
    onClosed: () => (closed = true),
    channel: open(),
  });
  createDphoneRemote({
    remote: 'other',
    onView: () => undefined,
    onClosed: () => (otherClosed = true),
    channel: open(),
  });
  host.recall();
  assert.equal(closed, true);
  assert.equal(otherClosed, false);
  host.close();
});

test('หน้าต่าง /dphone ที่ working tab ไม่ได้เปิด (id อื่น) ไม่ได้ state ไม่สลับ presence และสั่งสายไม่ได้', () => {
  const open = channelPair();
  const commands: unknown[] = [];
  const presence: boolean[] = [];
  let expected: string | undefined;
  const host = createDphoneHost({
    onCommand: (command) => commands.push(command),
    onRemotePresence: (present) => presence.push(present),
    expectedRemote: () => expected,
    channel: open(),
  });
  host.publish(view);
  const views: DphoneView[] = [];
  const stray = createDphoneRemote({
    remote: 'bookmark',
    onView: (next) => views.push(next),
    onClosed: () => undefined,
    channel: open(),
  });
  stray.send({ type: 'hangup' });
  stray.close();

  expected = 'popup-2';
  const ours = createDphoneRemote({
    remote: 'popup-2',
    onView: (next) => views.push(next),
    onClosed: () => undefined,
    channel: open(),
  });
  assert.deepEqual(views, [view], 'มีแต่หน้าต่างของตัวเองที่ได้ state');
  assert.deepEqual(commands, []);
  assert.deepEqual(presence, [true]);
  ours.close();
  host.close();
});
