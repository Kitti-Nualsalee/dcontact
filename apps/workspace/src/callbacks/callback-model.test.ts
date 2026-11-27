import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApiError } from '../agent-api.js';
import type { AgentCallback } from './callback-api.js';
import {
  callbackErrorKey,
  dueCount,
  localParts,
  newlyDue,
  noticeKey,
  slotInstant,
  suggestedSlot,
} from './callback-model.js';

test('the suggested time is an hour ahead on the next quarter hour', () => {
  assert.deepEqual(suggestedSlot(new Date(2026, 10, 28, 9, 7, 30)), {
    date: '2026-11-28',
    time: '10:15',
  });
  assert.deepEqual(suggestedSlot(new Date(2026, 10, 28, 23, 50)), {
    date: '2026-11-29',
    time: '01:00',
  });
  assert.deepEqual(localParts(new Date(2026, 0, 2, 3, 4)), { date: '2026-01-02', time: '03:04' });
});

test('a chosen time must be at least a minute and at most 30 days ahead', () => {
  const now = new Date(2026, 10, 28, 9, 0);
  assert.deepEqual(slotInstant('2026-11-28', '09:30', now), { at: new Date(2026, 10, 28, 9, 30) });
  assert.deepEqual(slotInstant('2026-11-28', '09:00', now), { problem: 'tooSoon' });
  assert.deepEqual(slotInstant('2026-12-29', '09:00', now), { problem: 'tooFar' });
  assert.deepEqual(slotInstant('', '09:00', now), { problem: 'missing' });
  assert.deepEqual(slotInstant('2026-11-28', '9:30', now), { problem: 'missing' });
});

test('API errors become messages; only server failures may be resent as the same command', () => {
  assert.deepEqual(callbackErrorKey(new AgentApiError(409, 'CALLBACK_EXISTS')), {
    key: 'exists',
    retry: false,
  });
  assert.deepEqual(callbackErrorKey(new AgentApiError(409, 'AGENT_NOT_AVAILABLE')), {
    key: 'notReady',
    retry: false,
  });
  assert.deepEqual(callbackErrorKey(new AgentApiError(409, 'VERSION_CONFLICT')).key, 'changed');
  assert.deepEqual(callbackErrorKey(new AgentApiError(503, 'X')), { key: 'failed', retry: true });
  assert.deepEqual(callbackErrorKey(new TypeError('offline')), { key: 'failed', retry: true });
});

test('due callbacks are counted and announced once per time', () => {
  const item = (id: string, minutes: number, state: AgentCallback['state'] = 'SCHEDULED') =>
    ({
      id,
      state,
      requestedFor: new Date(Date.UTC(2026, 10, 28, 3, minutes)).toISOString(),
    }) as AgentCallback;
  const now = Date.UTC(2026, 10, 28, 3, 30);
  const items = [item('a', 10), item('b', 30), item('c', 45), item('d', 0, 'ORIGINATING')];
  assert.equal(dueCount(items, now), 2);
  const noticed = new Set([noticeKey(items[0]!)]);
  assert.deepEqual(
    newlyDue(items, now, noticed).map((i) => i.id),
    ['b'],
  );
});
