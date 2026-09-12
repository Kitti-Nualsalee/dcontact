import assert from 'node:assert/strict';
import test from 'node:test';
import { J2_ERROR_CONTRACT } from '@d-contact/cxa-contracts';
import { rejection, success } from './cases-ensure-case-service.js';

/** ต้องตรงกับ STATUS_BY_COMMAND.ENSURE_CASE ใน @d-contact/cxa-contracts (ไม่ export ตรงๆ) */
const ENSURE_CASE_ALLOWED_STATUSES = new Set(['CREATED', 'LINKED', 'REOPENED', 'REJECTED']);

test('rejection() derives category/retryDisposition from the shared J2_ERROR_CONTRACT, never invents its own', () => {
  for (const code of ['CONTACT_NOT_FOUND', 'TEAM_SEGMENT_NOT_ALLOWED', 'OWNER_REJECTED'] as const) {
    const decision = rejection(code, 'BUSINESS', 'SOME_REASON');
    assert.equal(decision.status, 'REJECTED');
    assert.equal(decision.code, code);
    assert.equal(decision.category, J2_ERROR_CONTRACT[code].category);
    assert.equal(decision.retryDisposition, J2_ERROR_CONTRACT[code].retryDisposition);
    assert.notEqual(decision.failureClass, 'NONE');
  }
});

test('success() always uses status as code, BUSINESS category and NONE/NONE per the contract', () => {
  for (const status of ['CREATED', 'LINKED', 'REOPENED'] as const) {
    const decision = success(status, 'SOME_REASON', 'case-1', 1);
    assert.equal(decision.status, status);
    assert.equal(decision.code, status);
    assert.equal(decision.category, 'BUSINESS');
    assert.equal(decision.failureClass, 'NONE');
    assert.equal(decision.retryDisposition, 'NONE');
    assert.ok(ENSURE_CASE_ALLOWED_STATUSES.has(status), 'status ต้องอยู่ใน ENSURE_CASE allowlist');
  }
});
