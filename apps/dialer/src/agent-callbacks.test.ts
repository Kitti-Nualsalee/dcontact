import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentCallbackError,
  dialableNumber,
  noteInput,
  requestedForInput,
  versionInput,
} from './agent-callbacks.js';

const now = new Date('2026-11-28T03:00:00.000Z');
const invalid = (field: string) => (error: unknown) =>
  error instanceof AgentCallbackError && error.code === 'INVALID_INPUT' && error.field === field;

test('round one dials internal numbers only', () => {
  assert.equal(dialableNumber('1001'), '1001');
  assert.equal(dialableNumber(' 1 001 '), '1001');
  assert.equal(dialableNumber('2001'), null);
  assert.equal(dialableNumber('+66812345678'), null);
  assert.equal(dialableNumber('10011'), null);
});

test('the time is at least a minute and at most 30 days ahead, as an ISO timestamp', () => {
  assert.equal(
    requestedForInput('2026-11-28T03:01:00.000Z', now).toISOString(),
    '2026-11-28T03:01:00.000Z',
  );
  assert.equal(
    requestedForInput('2026-11-28T10:30:00+07:00', now).toISOString(),
    '2026-11-28T03:30:00.000Z',
  );
  for (const value of [
    '2026-11-28T03:00:30.000Z',
    '2026-12-28T03:00:01.000Z',
    'tomorrow',
    1,
    '2026/11/29',
  ])
    assert.throws(() => requestedForInput(value, now), invalid('requestedFor'));
});

test('a note is optional, trimmed and at most 500 characters; a version is a positive integer', () => {
  assert.equal(noteInput(undefined), null);
  assert.equal(noteInput('   '), null);
  assert.equal(noteInput('  call after lunch '), 'call after lunch');
  assert.equal(noteInput('x'.repeat(500))?.length, 500);
  assert.throws(() => noteInput('x'.repeat(501)), invalid('note'));
  assert.throws(() => noteInput(5), invalid('note'));
  assert.equal(versionInput(3), 3);
  for (const value of [0, 1.5, '2', null])
    assert.throws(() => versionInput(value), invalid('expectedVersion'));
});
