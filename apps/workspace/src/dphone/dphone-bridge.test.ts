import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDphoneHost,
  createDphoneRemote,
  type ChannelLike,
  type DphoneView,
} from './dphone-bridge.js';

/** in-memory BroadcastChannel — delivers to everyone except the sender, like the real one */
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
  queueName: 'Service',
  muted: false,
  locale: 'th',
};

test('its own detached window gets the latest view as soon as it opens, and commands reach the working tab', () => {
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

test('drops messages that are not v1, have no remote id, unknown commands, or a malformed DTMF', () => {
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

test('the working tab pulls dphone back → closes only its own detached window', () => {
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

test('a /dphone window that the working tab did not open (another id) gets no state, does not toggle presence, and cannot control calls', () => {
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
  assert.deepEqual(views, [view], 'only its own window gets the state');
  assert.deepEqual(commands, []);
  assert.deepEqual(presence, [true]);
  ours.close();
  host.close();
});
