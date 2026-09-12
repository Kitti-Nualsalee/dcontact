import assert from 'node:assert/strict';
import test from 'node:test';
import { J2_ERROR_CONTRACT } from '@d-contact/cxa-contracts';
import { callbackRejection, positive, tooLate } from './dialer-callback-service.js';

test('callbackRejection() derives category/retryDisposition from the shared J2_ERROR_CONTRACT', () => {
  for (const code of ['CONTACT_NOT_FOUND', 'TEAM_SEGMENT_NOT_ALLOWED', 'OWNER_REJECTED'] as const) {
    const decision = callbackRejection(code, 'AUTHORIZATION', 'SOME_REASON');
    assert.equal(decision.status, 'REJECTED');
    assert.equal(decision.code, code);
    assert.equal(decision.category, J2_ERROR_CONTRACT[code].category);
    assert.equal(decision.retryDisposition, J2_ERROR_CONTRACT[code].retryDisposition);
    assert.notEqual(decision.failureClass, 'NONE');
  }
});

test('tooLate() always uses the frozen ACTION_TOO_LATE terminal code/category/retryDisposition', () => {
  const decision = tooLate('CALLBACK_IRREVERSIBLE', 'record-1', 3);
  assert.equal(decision.status, 'TOO_LATE');
  assert.equal(decision.code, 'ACTION_TOO_LATE');
  assert.equal(decision.category, J2_ERROR_CONTRACT.ACTION_TOO_LATE.category);
  assert.equal(decision.retryDisposition, J2_ERROR_CONTRACT.ACTION_TOO_LATE.retryDisposition);
  assert.equal(decision.failureClass, 'BUSINESS');
  assert.equal(decision.recordId, 'record-1');
  assert.equal(decision.recordVersion, 3);
});

test('positive() always uses status as code, BUSINESS category and NONE/NONE per the contract', () => {
  for (const status of ['SCHEDULED', 'ALREADY_SCHEDULED', 'CANCELLED', 'SUPERSEDED'] as const) {
    const decision = positive(status, 'SOME_REASON', 'record-1', 1);
    assert.equal(decision.status, status);
    assert.equal(decision.code, status);
    assert.equal(decision.category, 'BUSINESS');
    assert.equal(decision.failureClass, 'NONE');
    assert.equal(decision.retryDisposition, 'NONE');
  }
});
