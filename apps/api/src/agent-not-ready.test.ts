import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAfterWork, parseAgentSelfState, stateChangedBy } from './agent-not-ready.js';

test('availability body: Ready/Offline must have no reason, Not Ready must have a code-shaped reason', () => {
  assert.deepEqual(parseAgentSelfState({ state: 'AVAILABLE' }), { state: 'AVAILABLE' });
  assert.deepEqual(parseAgentSelfState({ state: 'OFFLINE' }), { state: 'OFFLINE' });
  assert.deepEqual(parseAgentSelfState({ state: 'BREAK', reasonCode: 'LUNCH' }), {
    state: 'BREAK',
    reasonCode: 'LUNCH',
  });
  // identity comes from the token — other fields have no effect
  assert.deepEqual(parseAgentSelfState({ state: 'AVAILABLE', tenantId: 'x' }), {
    state: 'AVAILABLE',
  });
  for (const body of [
    undefined,
    null,
    [],
    { state: 'BUSY' },
    { state: 'BREAK' },
    { state: 'BREAK', reasonCode: 'lunch' },
    { state: 'BREAK', reasonCode: 7 },
    { state: 'OFFLINE', reasonCode: 'LUNCH' },
    { state: 'AVAILABLE', reasonCode: 'LUNCH' },
  ])
    assert.equal(parseAgentSelfState(body), undefined, JSON.stringify(body));
});

test('after-work body: only Ready or Not Ready + a reason', () => {
  assert.deepEqual(parseAfterWork({ state: 'AVAILABLE' }), { state: 'AVAILABLE' });
  assert.deepEqual(parseAfterWork({ state: 'BREAK', reasonCode: 'TRAINING' }), {
    state: 'BREAK',
    reasonCode: 'TRAINING',
  });
  assert.equal(parseAfterWork({ state: 'OFFLINE' }), undefined);
  assert.equal(parseAfterWork({ state: 'BREAK' }), undefined);
});

test('who changed the state: no actor = the system, themselves = Agent, someone else = Supervisor', () => {
  assert.equal(stateChangedBy(undefined, 'me'), 'SYSTEM');
  assert.equal(stateChangedBy({ actorUserId: null }, 'me'), 'SYSTEM');
  assert.equal(stateChangedBy({ actorUserId: 'me' }, 'me'), 'AGENT');
  assert.equal(stateChangedBy({ actorUserId: 'sup' }, 'me'), 'SUPERVISOR');
});
