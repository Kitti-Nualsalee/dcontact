import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApiError, type WrapupIntentV1, type WrapupResultV1 } from '../agent-api.js';
import type { WebchatApi, WebchatChat, WebchatMessage } from './webchat-api.js';
import { WebchatStore, unreadOf, waitingSince } from './webchat-store.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 27, 3, 0, seconds)).toISOString();

function chat(id: string, patch: Partial<WebchatChat> = {}): WebchatChat {
  return {
    interactionId: id,
    state: 'ACTIVE',
    visitorLabel: id.toUpperCase(),
    origin: 'https://shop.test',
    queueName: 'Online Sales',
    queuedAt: at(0),
    offerExpiresAt: null,
    answeredAt: at(1),
    endedAt: null,
    endReason: null,
    visitorOnline: true,
    idleClosesAt: null,
    lastMessage: null,
    visitorMessageCount: 0,
    ...patch,
  };
}

function harness() {
  const server = {
    chats: [] as WebchatChat[],
    messages: new Map<string, WebchatMessage[]>(),
    fail: {} as {
      chats?: boolean;
      send?: AgentApiError | Error;
      accept?: AgentApiError;
      wrapup?: Error;
    },
    sent: [] as { commandId: string; text: string }[],
    wrapups: [] as WrapupIntentV1[],
  };
  let ids = 0;
  let visible = true;
  const say = (id: string, from: WebchatMessage['from'], text: string, seconds: number) => {
    const message: WebchatMessage = { id: `m${seconds}`, at: at(seconds), from, text };
    server.messages.set(id, [...(server.messages.get(id) ?? []), message]);
    server.chats = server.chats.map((entry) =>
      entry.interactionId === id
        ? {
            ...entry,
            lastMessage: message,
            visitorMessageCount: entry.visitorMessageCount + (from === 'visitor' ? 1 : 0),
          }
        : entry,
    );
  };
  const api: WebchatApi = {
    async chats() {
      if (server.fail.chats) throw new Error('offline');
      return { maxChatsPerAgent: 3, chats: server.chats };
    },
    async messages(id, after) {
      const all = server.messages.get(id) ?? [];
      const messages = after ? all.filter((message) => message.at > after) : all;
      return { messages, cursor: messages.at(-1)?.at ?? after ?? null };
    },
    async accept(id) {
      if (server.fail.accept) throw server.fail.accept;
      server.chats = server.chats.map((entry) =>
        entry.interactionId === id ? { ...entry, state: 'ACTIVE' } : entry,
      );
    },
    async send(id, input) {
      server.sent.push(input);
      if (server.fail.send) throw server.fail.send;
      const message: WebchatMessage = {
        id: `s${server.sent.length}`,
        at: at(30 + server.sent.length),
        from: 'agent',
        text: input.text,
        clientId: input.commandId,
      };
      server.messages.set(id, [...(server.messages.get(id) ?? []), message]);
      return message;
    },
    async end(id) {
      server.chats = server.chats.map((entry) =>
        entry.interactionId === id
          ? { ...entry, state: 'WRAPUP', endReason: 'AGENT_ENDED' }
          : entry,
      );
    },
  };
  const store = new WebchatStore({
    api,
    submitWrapup: async (intent) => {
      server.wrapups.push(intent);
      if (server.fail.wrapup) throw server.fail.wrapup;
      server.chats = server.chats.filter((entry) => entry.interactionId !== intent.interactionId);
      return {
        interactionId: intent.interactionId,
        policyVersion: 1,
        state: 'COMPLETED',
        disposition: intent.disposition,
        note: intent.note,
        recordedAt: at(59),
        legacy: false,
      } satisfies WrapupResultV1;
    },
    newId: () => `c${++ids}`,
    now: () => new Date(at(20)),
    visible: () => visible,
  });
  return { store, server, say, setVisible: (value: boolean) => void (visible = value) };
}

test('rooms keep their arrival order, the first is selected, and only unseen rooms count as unread', async () => {
  const h = harness();
  h.server.chats = [chat('a'), chat('b')];
  h.say('a', 'visitor', 'hello', 2);
  await h.store.refresh();
  let state = h.store.snapshot();
  assert.deepEqual(
    state.rooms.map((room) => room.chat.interactionId),
    ['a', 'b'],
  );
  assert.equal(state.selectedId, 'a');
  assert.equal(unreadOf(state.rooms[0]!), 0, 'the room in view is read');

  h.say('b', 'visitor', 'anyone?', 5);
  h.say('b', 'visitor', 'hello?', 6);
  await h.store.refresh();
  state = h.store.snapshot();
  assert.deepEqual(
    state.rooms.map((room) => room.chat.interactionId),
    ['a', 'b'],
    'a new message does not reorder',
  );
  assert.equal(unreadOf(state.rooms[1]!), 2);
  assert.equal(waitingSince(state.rooms[1]!), at(6));
  assert.deepEqual(
    state.rooms[1]!.messages.map((message) => message.text),
    ['anyone?', 'hello?'],
  );

  h.store.select('b');
  assert.equal(unreadOf(h.store.snapshot().rooms[1]!), 0);
  // a message that arrives while the Agent is on another window stays unread
  h.setVisible(false);
  h.say('b', 'visitor', 'still there?', 7);
  await h.store.refresh();
  assert.equal(unreadOf(h.store.snapshot().rooms[1]!), 1);
});

test('a draft belongs to its room, and a sent message shows once whether the answer or the refresh comes first', async () => {
  const h = harness();
  h.server.chats = [chat('a'), chat('b')];
  await h.store.refresh();
  h.store.setDraft('a', 'for a');
  h.store.select('b');
  h.store.setDraft('b', '  for b  ');
  assert.equal(h.store.snapshot().rooms[0]!.draft, 'for a');

  await h.store.send('b');
  await h.store.refresh();
  const room = h.store.snapshot().rooms[1]!;
  assert.equal(room.draft, '');
  assert.deepEqual(
    room.messages.map((message) => [message.id, message.text, message.pending]),
    [['s1', 'for b', undefined]],
  );
  assert.equal(h.store.snapshot().rooms[0]!.draft, 'for a', 'the other draft is untouched');
});

test('a message that fails stays with its text; retry repeats the same command and delete removes it', async () => {
  const h = harness();
  h.server.chats = [chat('a')];
  await h.store.refresh();
  h.server.fail.send = new Error('network');
  h.store.setDraft('a', 'first');
  await h.store.send('a');
  h.store.setDraft('a', 'second');
  await h.store.send('a');
  const failed = h.store.snapshot().rooms[0]!.messages;
  assert.deepEqual(
    failed.map((message) => message.pending),
    ['failed', 'failed'],
  );

  h.server.fail.send = undefined;
  await h.store.retry('a', failed[0]!.id);
  h.store.discard('a', failed[1]!.id);
  assert.deepEqual(
    h.server.sent.map((entry) => entry.commandId),
    ['c1', 'c2', 'c1'],
  );
  assert.deepEqual(
    h.store.snapshot().rooms[0]!.messages.map((message) => [message.text, message.pending]),
    [['first', undefined]],
  );
});

test('accepting an offer opens its room; an offer that went elsewhere is reported once', async () => {
  const h = harness();
  h.server.chats = [chat('a', { state: 'ASSIGNED', answeredAt: null, offerExpiresAt: at(40) })];
  await h.store.refresh();
  assert.equal(h.store.snapshot().offers.length, 1);
  assert.equal(h.store.snapshot().selectedId, null);
  assert.equal(await h.store.accept('a'), true);
  assert.equal(h.store.snapshot().selectedId, 'a');
  assert.deepEqual(h.store.snapshot().missed, []);

  h.server.chats = [...h.server.chats, chat('b', { state: 'ASSIGNED', offerExpiresAt: at(50) })];
  await h.store.refresh();
  h.server.chats = h.server.chats.filter((entry) => entry.interactionId !== 'b');
  await h.store.refresh();
  assert.deepEqual(h.store.snapshot().missed, [{ interactionId: 'b', visitorLabel: 'B' }]);
  h.store.dismissMissed('b');
  assert.deepEqual(h.store.snapshot().missed, []);

  h.server.chats = [...h.server.chats, chat('c', { state: 'ASSIGNED', offerExpiresAt: at(55) })];
  await h.store.refresh();
  h.server.fail.accept = new AgentApiError(409, 'OFFER_GONE');
  h.server.chats = h.server.chats.filter((entry) => entry.interactionId !== 'c');
  assert.equal(await h.store.accept('c'), false);
  await h.store.refresh();
  assert.equal(h.store.snapshot().notice, 'offerTaken');
  assert.deepEqual(h.store.snapshot().missed, [], 'the Agent already saw why it went away');
});

test('the outcome is saved once: a lost answer locks the form and retries the same command', async () => {
  const h = harness();
  h.server.chats = [chat('a'), chat('b')];
  await h.store.refresh();
  await h.store.end('a');
  assert.equal(h.store.snapshot().rooms[0]!.chat.state, 'WRAPUP');
  assert.equal(
    await h.store.submitWrapup('a'),
    null,
    'nothing is sent without an outcome and a note',
  );
  h.store.setWrapup('a', { disposition: 'CUSTOMER_ASSISTED', note: '  done  ' });

  h.server.fail.wrapup = new Error('network');
  assert.equal(await h.store.submitWrapup('a'), null);
  assert.equal(h.store.snapshot().rooms[0]!.wrapup.error, 'unknown');
  h.store.setWrapup('a', { note: 'changed' });
  assert.equal(
    h.store.snapshot().rooms[0]!.wrapup.note,
    '  done  ',
    'the form is locked while unknown',
  );
  // a refresh must not drop a room whose result is still unknown, even if the server no longer lists it
  h.server.chats = h.server.chats.filter((entry) => entry.interactionId !== 'a');
  await h.store.refresh();
  assert.equal(h.store.snapshot().rooms.length, 2);

  h.server.fail.wrapup = undefined;
  const saved = await h.store.submitWrapup('a');
  assert.equal(saved?.note, 'done');
  assert.deepEqual(
    h.server.wrapups.map((intent) => intent.commandId),
    ['c1', 'c1'],
  );
  const state = h.store.snapshot();
  assert.deepEqual(
    state.rooms.map((room) => room.chat.interactionId),
    ['b'],
  );
  assert.equal(state.selectedId, 'b', 'the next room comes into view');
  assert.deepEqual(
    state.closed.map((entry) => entry.interactionId),
    ['a'],
  );
});

test('a refused outcome can be corrected and sent as a new command', async () => {
  const h = harness();
  h.server.chats = [chat('a', { state: 'WRAPUP', endReason: 'CUSTOMER_ENDED' })];
  await h.store.refresh();
  h.store.setWrapup('a', { disposition: 'FOLLOW_UP_REQUIRED', note: 'call back' });
  h.server.fail.wrapup = new AgentApiError(409, 'WRAPUP_POLICY_MISMATCH');
  assert.equal(await h.store.submitWrapup('a'), null);
  assert.equal(h.store.snapshot().rooms[0]!.wrapup.error, 'failed');
  h.server.fail.wrapup = undefined;
  h.store.setWrapup('a', { note: 'call back tomorrow' });
  assert.ok(await h.store.submitWrapup('a'));
  assert.deepEqual(
    h.server.wrapups.map((intent) => intent.commandId),
    ['c1', 'c2'],
  );
});

test('a failed refresh marks the chats offline and keeps what is on screen', async () => {
  const h = harness();
  h.server.chats = [chat('a')];
  await h.store.refresh();
  h.store.setDraft('a', 'half typed');
  h.server.fail.chats = true;
  await h.store.refresh();
  assert.equal(h.store.snapshot().online, false);
  assert.equal(h.store.snapshot().rooms[0]!.draft, 'half typed');
  h.server.fail.chats = false;
  await h.store.refresh();
  assert.equal(h.store.snapshot().online, true);
});
