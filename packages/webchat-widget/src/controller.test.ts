import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChatApiError,
  type ChatApi,
  type ChatMessage,
  type ServerState,
  type StoredSession,
} from './client.js';
import { ChatController, type ChatView } from './controller.js';

function harness(options: { staffed?: boolean; stored?: StoredSession | null } = {}) {
  let stored = options.stored ?? null;
  let ids = 0;
  const calls: string[] = [];
  const server: { state: ServerState; sendError?: ChatApiError; bootstrapError?: boolean } = {
    state: {
      status: 'NEW',
      endReason: null,
      staffed: true,
      messages: [],
      cursor: null,
      version: 'NEW:',
    },
  };
  let wake: (() => void) | undefined;
  const push = (patch: Partial<ServerState>) => {
    server.state = { ...server.state, ...patch };
    server.state.version = `${server.state.status}:${server.state.messages.length}`;
    wake?.();
  };
  const api: ChatApi = {
    async bootstrap() {
      calls.push('bootstrap');
      if (server.bootstrapError) throw new ChatApiError(404, 'WEBCHAT_DISABLED');
      return {
        tenantName: 'Demo Retail',
        greeting: { th: 'th', en: 'en' },
        idleTimeoutSec: 600,
        staffed: options.staffed ?? true,
      };
    },
    async startSession() {
      calls.push('startSession');
      return { sessionId: 's1', token: 'secret' };
    },
    async state(_session, query) {
      calls.push(`state:${query.known ?? ''}`);
      if (query.known && query.known === server.state.version)
        await new Promise<void>((resolve) => {
          wake = resolve;
          query.signal?.addEventListener('abort', () => resolve());
        });
      return server.state;
    },
    async send(_session, input) {
      calls.push(`send:${input.text}`);
      if (server.sendError) throw server.sendError;
      const message: ChatMessage = {
        id: `m${server.state.messages.length + 1}`,
        at: new Date(Date.UTC(2026, 10, 27, 3, 0, server.state.messages.length)).toISOString(),
        from: 'visitor',
        text: input.text,
        clientId: input.clientMessageId,
      };
      push({ status: 'WAITING', messages: [...server.state.messages, message] });
      return message;
    },
    async end() {
      calls.push('end');
      push({ status: 'ENDED', endReason: 'CUSTOMER_ENDED' });
    },
  };
  const controller = new ChatController({
    api,
    store: { load: () => stored, save: (session) => void (stored = session) },
    origin: 'https://shop.test',
    locale: 'th',
    newId: () => `c${++ids}`,
    now: () => new Date(Date.UTC(2026, 10, 27, 3, 0, 0)),
    delay: async () => undefined,
  });
  const views: ChatView[] = [];
  controller.subscribe((view) => views.push(view));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { controller, calls, server, push, views, settle, stored: () => stored };
}

test('the first message creates the session, shows once, and the chat follows the server', async () => {
  const h = harness();
  await h.controller.init();
  assert.equal(h.controller.current().phase, 'ready');
  assert.equal(h.calls.includes('startSession'), false, 'opening the widget creates nothing');

  await h.controller.send('  hello  ');
  await h.settle();
  assert.deepEqual(h.stored(), { sessionId: 's1', token: 'secret' });
  assert.equal(h.controller.current().phase, 'waiting');
  assert.deepEqual(
    h.controller.current().messages.map((message) => [message.id, message.text, message.pending]),
    [['m1', 'hello', undefined]],
  );

  h.push({
    status: 'ACTIVE',
    messages: [
      ...h.server.state.messages,
      { id: 'm2', at: '2026-11-27T03:00:05.000Z', from: 'system', event: 'AGENT_JOINED' },
      { id: 'm3', at: '2026-11-27T03:00:06.000Z', from: 'agent', text: 'hi' },
    ],
  });
  await h.settle();
  assert.equal(h.controller.current().phase, 'active');
  assert.deepEqual(
    h.controller.current().messages.map((message) => message.id),
    ['m1', 'm2', 'm3'],
  );

  await h.controller.end();
  await h.settle();
  assert.equal(h.controller.current().phase, 'ended');
  assert.equal(h.stored(), null, 'an ended chat is not resumed by the next page load');
  h.controller.dispose();
});

test('a refreshed page returns to its open chat, and an ended one starts fresh', async () => {
  const open = harness({ stored: { sessionId: 's1', token: 'secret' } });
  open.server.state = {
    ...open.server.state,
    status: 'ACTIVE',
    messages: [{ id: 'm1', at: '2026-11-27T03:00:00.000Z', from: 'visitor', text: 'hello' }],
    version: 'ACTIVE:1',
  };
  await open.controller.init();
  assert.equal(open.controller.current().phase, 'active');
  assert.equal(open.controller.current().messages.length, 1);
  open.controller.dispose();

  const ended = harness({ stored: { sessionId: 's1', token: 'secret' } });
  ended.server.state = { ...ended.server.state, status: 'ENDED', endReason: 'AGENT_ENDED' };
  await ended.controller.init();
  assert.equal(ended.controller.current().phase, 'ready');
  assert.equal(ended.stored(), null);
  ended.controller.dispose();
});

test('no Agent online: the composer is closed, and a first message refused for it is not kept', async () => {
  const offline = harness({ staffed: false });
  await offline.controller.init();
  assert.equal(offline.controller.current().phase, 'offline');
  await offline.controller.send('hello');
  assert.equal(offline.calls.includes('send:hello'), false);
  offline.controller.dispose();

  const raced = harness();
  await raced.controller.init();
  raced.server.sendError = new ChatApiError(409, 'NO_AGENT_ONLINE');
  await raced.controller.send('hello');
  assert.equal(raced.controller.current().phase, 'offline');
  assert.deepEqual(raced.controller.current().messages, []);
  raced.controller.dispose();
});

test('a message that fails stays with a retry, and the retry sends the same id', async () => {
  const h = harness();
  await h.controller.init();
  h.server.sendError = new ChatApiError(429, 'RATE_LIMITED');
  await h.controller.send('hello');
  const [failed] = h.controller.current().messages;
  assert.equal(failed?.pending, 'failed');
  assert.equal(h.controller.current().notice, 'rate');
  h.server.sendError = undefined;
  await h.controller.retry(failed!.id);
  await h.settle();
  assert.deepEqual(
    h.controller.current().messages.map((message) => [message.clientId, message.pending]),
    [['c1', undefined]],
  );
  h.controller.dispose();
});

test('a widget that is off shows as unavailable', async () => {
  const h = harness();
  h.server.bootstrapError = true;
  await h.controller.init();
  assert.equal(h.controller.current().phase, 'unavailable');
  h.controller.dispose();
});
