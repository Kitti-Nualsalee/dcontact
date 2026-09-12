import assert from 'node:assert/strict';
import test from 'node:test';
import { J2_ERROR_CONTRACT } from '@d-contact/cxa-contracts';
import { admitted, rejection } from './dialer-admit-campaign-target-service.js';

test('rejection() derives category/retryDisposition from the shared J2_ERROR_CONTRACT, never invents its own', () => {
  for (const code of ['CONTACT_NOT_FOUND', 'TEAM_SEGMENT_NOT_ALLOWED', 'OWNER_REJECTED'] as const) {
    const decision = rejection(code, 'AUTHORIZATION', 'SOME_REASON');
    assert.equal(decision.status, 'REJECTED');
    assert.equal(decision.code, code);
    assert.equal(decision.category, J2_ERROR_CONTRACT[code].category);
    assert.equal(decision.retryDisposition, J2_ERROR_CONTRACT[code].retryDisposition);
    assert.notEqual(decision.failureClass, 'NONE');
  }
});

test('admitted() always uses status as code, BUSINESS category and NONE/NONE per the contract', () => {
  for (const status of ['ADMITTED', 'ALREADY_ADMITTED'] as const) {
    const decision = admitted(status, 'SOME_REASON', 'record-1', 1);
    assert.equal(decision.status, status);
    assert.equal(decision.code, status);
    assert.equal(decision.category, 'BUSINESS');
    assert.equal(decision.failureClass, 'NONE');
    assert.equal(decision.retryDisposition, 'NONE');
  }
});
