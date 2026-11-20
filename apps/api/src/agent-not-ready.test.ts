import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAfterWork, parseAgentSelfState, stateChangedBy } from './agent-not-ready.js';

test('availability body: Ready/Offline ห้ามมีเหตุผล, Not Ready ต้องมีเหตุผลรูปแบบ code', () => {
  assert.deepEqual(parseAgentSelfState({ state: 'AVAILABLE' }), { state: 'AVAILABLE' });
  assert.deepEqual(parseAgentSelfState({ state: 'OFFLINE' }), { state: 'OFFLINE' });
  assert.deepEqual(parseAgentSelfState({ state: 'BREAK', reasonCode: 'LUNCH' }), {
    state: 'BREAK',
    reasonCode: 'LUNCH',
  });
  // ตัวตนมาจาก token — field อื่นไม่มีผล
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

test('after-work body: Ready หรือ Not Ready + เหตุผลเท่านั้น', () => {
  assert.deepEqual(parseAfterWork({ state: 'AVAILABLE' }), { state: 'AVAILABLE' });
  assert.deepEqual(parseAfterWork({ state: 'BREAK', reasonCode: 'TRAINING' }), {
    state: 'BREAK',
    reasonCode: 'TRAINING',
  });
  assert.equal(parseAfterWork({ state: 'OFFLINE' }), undefined);
  assert.equal(parseAfterWork({ state: 'BREAK' }), undefined);
});

test('ผู้เปลี่ยนสถานะ: ไม่มี actor = ระบบ, ตัวเอง = Agent, คนอื่น = Supervisor', () => {
  assert.equal(stateChangedBy(undefined, 'me'), 'SYSTEM');
  assert.equal(stateChangedBy({ actorUserId: null }, 'me'), 'SYSTEM');
  assert.equal(stateChangedBy({ actorUserId: 'me' }, 'me'), 'AGENT');
  assert.equal(stateChangedBy({ actorUserId: 'sup' }, 'me'), 'SUPERVISOR');
});
