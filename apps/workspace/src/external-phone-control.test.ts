import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reduceExternalPhone,
  resolvePhoneControlMode,
  type ExternalPhonePhase,
} from './external-phone-control.js';

test('external control is opt-in; unknown config preserves browser phone mode', () => {
  assert.equal(resolvePhoneControlMode('external-simulator'), 'external-simulator');
  for (const value of [undefined, '', 'external', 'browser'])
    assert.equal(resolvePhoneControlMode(value), 'browser');
});

test('incoming → accept → hangup keeps the simulator reusable without business events', () => {
  let phase: ExternalPhonePhase = 'DISCONNECTED';
  for (const [action, expected] of [
    ['connect', 'IDLE'],
    ['incoming', 'RINGING'],
    ['accept', 'ACTIVE'],
    ['hangup', 'ENDED'],
    ['incoming', 'RINGING'],
    ['hangup', 'ENDED'],
  ] as const) {
    phase = reduceExternalPhone(phase, action);
    assert.equal(phase, expected);
  }
});

test('out-of-order controls have no effect and session loss clears local simulation', () => {
  assert.equal(reduceExternalPhone('DISCONNECTED', 'accept'), 'DISCONNECTED');
  assert.equal(reduceExternalPhone('IDLE', 'hangup'), 'IDLE');
  assert.equal(reduceExternalPhone('ACTIVE', 'incoming'), 'ACTIVE');
  assert.equal(reduceExternalPhone('ACTIVE', 'disconnect'), 'DISCONNECTED');
});
