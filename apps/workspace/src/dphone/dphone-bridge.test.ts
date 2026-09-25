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
          for (const listener of member.listeners)
            listener({ data: structuredClone(message) } as MessageEvent);
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

test('หน้าต่างแยกได้ view ล่าสุดทันทีที่เปิด และคำสั่งกลับไปถึง working tab', () => {
  const open = channelPair();
  const commands: unknown[] = [];
  const presence: boolean[] = [];
  const host = createDphoneHost({
    onCommand: (command) => commands.push(command),
    onRemotePresence: (present) => presence.push(present),
    channel: open(),
  });
  host.publish(view);

  const views: DphoneView[] = [];
  const remote = createDphoneRemote({
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

test('ทิ้งข้อความที่ไม่ใช่ v1 หรือคำสั่งที่ไม่รู้จัก/DTMF ผิดรูป', () => {
  const open = channelPair();
  const commands: unknown[] = [];
  const host = createDphoneHost({
    onCommand: (command) => commands.push(command),
    onRemotePresence: () => undefined,
    channel: open(),
  });
  const attacker = open();
  attacker.postMessage({ v: 2, kind: 'command', command: { type: 'hangup' } });
  attacker.postMessage({ v: 1, kind: 'command', command: { type: 'transfer' } });
  attacker.postMessage({ v: 1, kind: 'command', command: { type: 'dtmf', value: '12; drop' } });
  attacker.postMessage('hangup');
  assert.deepEqual(commands, []);
  host.close();
});

test('working tab ดึง dphone กลับ → หน้าต่างแยกได้สัญญาณปิดตัวเอง', () => {
  const open = channelPair();
  const host = createDphoneHost({
    onCommand: () => undefined,
    onRemotePresence: () => undefined,
    channel: open(),
  });
  let closed = false;
  createDphoneRemote({ onView: () => undefined, onClosed: () => (closed = true), channel: open() });
  host.recall();
  assert.equal(closed, true);
  host.close();
});
